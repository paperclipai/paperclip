import { createHash } from "node:crypto";
import { URL } from "node:url";

export class ApiRequestError extends Error {
  status: number;
  details?: unknown;
  body?: unknown;

  constructor(status: number, message: string, details?: unknown, body?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
    this.body = body;
  }
}

export class ApiConnectionError extends Error {
  url: string;
  method: string;
  causeMessage?: string;

  constructor(input: {
    apiBase: string;
    path: string;
    method: string;
    cause?: unknown;
  }) {
    const url = buildUrl(input.apiBase, input.path);
    const causeMessage = formatConnectionCause(input.cause);
    super(buildConnectionErrorMessage({ apiBase: input.apiBase, url, method: input.method, causeMessage }));
    this.url = url;
    this.method = input.method;
    this.causeMessage = causeMessage;
  }
}

interface RequestOptions {
  ignoreNotFound?: boolean;
}

interface RecoverAuthInput {
  path: string;
  method: string;
  error: ApiRequestError;
}

interface ApiClientOptions {
  apiBase: string;
  apiKey?: string;
  runId?: string;
  recoverAuth?: (input: RecoverAuthInput) => Promise<string | null>;
}

export class PaperclipApiClient {
  readonly apiBase: string;
  apiKey?: string;
  readonly runId?: string;
  readonly recoverAuth?: (input: RecoverAuthInput) => Promise<string | null>;

  constructor(opts: ApiClientOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.runId = opts.runId?.trim() || undefined;
    this.recoverAuth = opts.recoverAuth;
  }

  get<T>(path: string, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, { method: "GET" }, opts);
  }

  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, {
      method: "POST",
      ...jsonRequestBody(body),
    }, opts);
  }

  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, {
      method: "PATCH",
      ...jsonRequestBody(body),
    }, opts);
  }

  put<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, {
      method: "PUT",
      ...jsonRequestBody(body),
    }, opts);
  }

  /** Raw binary upload (e.g. one chunked import-transfer part); the body travels as-is. */
  putRaw<T>(path: string, body: Uint8Array, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, {
      method: "PUT",
      body: body as unknown as BodyInit,
      headers: { "content-type": "application/octet-stream" },
    }, opts);
  }

  delete<T>(path: string, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, { method: "DELETE" }, opts);
  }

  setApiKey(apiKey: string | undefined) {
    this.apiKey = apiKey?.trim() || undefined;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    opts?: RequestOptions,
    hasRetriedAuth = false,
  ): Promise<T | null> {
    const url = buildUrl(this.apiBase, path);
    const method = String(init.method ?? "GET").toUpperCase();

    const headers: Record<string, string> = {
      accept: "application/json",
      ...toStringRecord(init.headers),
    };

    if (init.body !== undefined) {
      headers["content-type"] = headers["content-type"] ?? "application/json; charset=utf-8";
    }

    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    if (this.runId) {
      headers["x-paperclip-run-id"] = this.runId;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
      });
    } catch (error) {
      throw new ApiConnectionError({
        apiBase: this.apiBase,
        path,
        method,
        cause: error,
      });
    }

    if (opts?.ignoreNotFound && response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const apiError = await toApiError(response);
      if (!hasRetriedAuth && this.recoverAuth) {
        const recoveredToken = await this.recoverAuth({
          path,
          method,
          error: apiError,
        });
        if (recoveredToken) {
          this.setApiKey(recoveredToken);
          return this.request<T>(path, init, opts, true);
        }
      }
      throw apiError;
    }

    if (response.status === 204) {
      verifyTextMutationReadback(path, init.method, init.body, undefined);
      return null;
    }

    const text = await response.text();
    if (!text.trim()) {
      verifyTextMutationReadback(path, init.method, init.body, undefined);
      return null;
    }

    const parsed = safeParseJson(text) as T;
    verifyTextMutationReadback(path, init.method, init.body, parsed);
    return parsed;
  }
}

export class ApiReadbackMismatchError extends Error {
  constructor(path: string, field: string) {
    super(`Paperclip readback mismatch for ${field} after ${path}; stopping workflow.`);
  }
}

function jsonRequestBody(body: unknown): Pick<RequestInit, "body" | "headers"> {
  if (body === undefined) return {};
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    // Send JSON as bytes rather than a JavaScript string so transport encoding is
    // explicit and cannot depend on a host shell or platform default code page.
    body: bytes,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-digest": `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`,
    },
  };
}

function verifyTextMutationReadback(path: string, method: string | undefined, rawBody: BodyInit | null | undefined, response: unknown) {
  if (!(rawBody instanceof Uint8Array)) return;
  const request = safeParseJson(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  if (!request || typeof request !== "object" || Array.isArray(request)) return;
  const requested = request as Record<string, unknown>;
  const pathname = path.split("?")[0] ?? path;
  const isIssueUpdate = method?.toUpperCase() === "PATCH" && /^\/api\/issues\/[^/]+$/.test(pathname);
  const isCommentCreate = method?.toUpperCase() === "POST" && /^\/api\/issues\/[^/]+\/comments$/.test(pathname);
  const isIssueCreate = method?.toUpperCase() === "POST" && /^\/api\/companies\/[^/]+\/issues$/.test(pathname);
  const isChildCreate = method?.toUpperCase() === "POST" && /^\/api\/issues\/[^/]+\/children$/.test(pathname);
  const isRecoveryResolve = method?.toUpperCase() === "POST" && /^\/api\/issues\/[^/]+\/recovery-actions\/resolve$/.test(pathname);
  const isInteraction = /^\/api\/issues\/[^/]+\/interactions(?:\/[^/]+(?:\/(?:accept|reject|respond|verdicts|withdraw|cancel))?)?$/.test(pathname);
  const isDecision = /^\/api\/(?:companies\/[^/]+\/(?:decisions|decision-bundles)|decisions\/[^/]+\/(?:decide|dismiss|cancel))$/.test(pathname);
  const expectedText = collectSemanticText(requested);
  const expectedContractText = isInteraction || isDecision ? collectContractText(requested) : [];
  const requiresReadback = isIssueUpdate || isCommentCreate || isIssueCreate || isChildCreate || isRecoveryResolve || isInteraction || isDecision;
  if (!response || typeof response !== "object") {
    if (requiresReadback && (expectedText.length > 0 || expectedContractText.length > 0)) throw new ApiReadbackMismatchError(path, "authoritative response unavailable");
    return;
  }
  const returned = response as Record<string, unknown>;

  if (isCommentCreate) assertExactText(path, "body", requested.body, returned.body);
  if (isIssueCreate || isIssueUpdate) {
    assertExactText(path, "title", requested.title, returned.title);
    assertExactText(path, "description", requested.description, returned.description);
  }
  if (isIssueUpdate) assertExactText(path, "comment", requested.comment, (returned.comment as Record<string, unknown> | undefined)?.body);
  if (isRecoveryResolve) {
    assertExactText(path, "resolutionNote", requested.resolutionNote, (returned.recoveryAction as Record<string, unknown> | undefined)?.resolutionNote);
  }
  if (isChildCreate) {
    const child = isRecord(returned.issue) ? returned.issue : returned;
    assertExactText(path, "title", requested.title, child.title);
    assertExactText(path, "description", requested.description, child.description);
  }
  if (isInteraction || isDecision) {
    const authoritative = isInteraction && isRecord(returned.interaction)
      ? returned.interaction
      : isDecision && isRecord(returned.decision)
        ? returned.decision
        : returned;
    assertTextPaths(path, expectedContractText, authoritative);
  }
}

function assertExactText(path: string, field: string, expected: unknown, actual: unknown) {
  if (expected !== undefined && (typeof expected !== "string" || actual !== expected)) {
    throw new ApiReadbackMismatchError(path, field);
  }
}

const SEMANTIC_TEXT_FIELDS = new Set([
  "title", "description", "comment", "body", "resolutionNote", "decisionNote", "reason", "summaryMarkdown",
  "prompt", "question", "answer", "message", "text", "instructions", "summary",
]);

function collectSemanticText(value: unknown, fieldName?: string): string[] {
  if (typeof value === "string") return fieldName && SEMANTIC_TEXT_FIELDS.has(fieldName) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectSemanticText(item, fieldName));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => collectSemanticText(item, key));
}

// Interaction and decision endpoints persist their contract payloads verbatim.
// These fields are identifiers, enum values, or normalized temporal metadata;
// they are not user-authored text and therefore have no authoritative text
// readback requirement. Every other string is checked recursively.
const NON_TEXT_CONTRACT_FIELDS = new Set([
  "id", "kind", "type", "key", "optionId", "clientKey", "revisionId",
  "idempotencyKey", "sourceCommentId", "sourceRunId", "addresseeAgentId",
  "continuationPolicy", "resolverPolicy", "expiresAt",
]);

interface TextPath {
  path: readonly (string | number)[];
  value: string;
}

function collectContractText(value: unknown, fieldName?: string, path: readonly (string | number)[] = []): TextPath[] {
  if (typeof value === "string") return fieldName && NON_TEXT_CONTRACT_FIELDS.has(fieldName) ? [] : [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectContractText(item, fieldName, [...path, index]));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => collectContractText(item, key, [...path, key]));
}

function assertTextPaths(path: string, expectedText: readonly TextPath[], response: unknown) {
  for (const expected of expectedText) {
    const actual = readTextPath(response, expected.path);
    if (actual !== expected.value) throw new ApiReadbackMismatchError(path, formatTextPath(expected.path));
  }
}

function readTextPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!isRecord(current)) return undefined;
      current = current[segment];
    }
  }
  return current;
}

function formatTextPath(path: readonly (string | number)[]): string {
  return path.map((segment) => typeof segment === "number" ? `[${segment}]` : segment).join(".").replace(".[", "[");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildUrl(apiBase: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const [pathname, query] = normalizedPath.split("?");
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  if (query) url.search = query;
  return url.toString();
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function toApiError(response: Response): Promise<ApiRequestError> {
  const text = await response.text();
  const parsed = safeParseJson(text);

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const body = parsed as Record<string, unknown>;
    const message =
      (typeof body.error === "string" && body.error.trim()) ||
      (typeof body.message === "string" && body.message.trim()) ||
      `Request failed with status ${response.status}`;

    return new ApiRequestError(response.status, message, body.details, parsed);
  }

  return new ApiRequestError(response.status, `Request failed with status ${response.status}`, undefined, parsed);
}

function buildConnectionErrorMessage(input: {
  apiBase: string;
  url: string;
  method: string;
  causeMessage?: string;
}): string {
  const healthUrl = buildHealthCheckUrl(input.url);
  const lines = [
    "Could not reach the Paperclip API.",
    "",
    `Request: ${input.method} ${input.url}`,
  ];
  if (input.causeMessage) {
    lines.push(`Cause: ${input.causeMessage}`);
  }
  lines.push(
    "",
    "This usually means the Paperclip server is not running, the configured URL is wrong, or the request is being blocked before it reaches Paperclip.",
    "",
    "Try:",
    "- Start Paperclip with `pnpm dev` (from a source checkout) or `npx paperclipai run`.",
    `- Verify the server is reachable with \`curl ${healthUrl}\`.`,
    `- If Paperclip is running elsewhere, pass \`--api-base ${input.apiBase.replace(/\/+$/, "")}\` or set \`PAPERCLIP_API_URL\`.`,
  );
  return lines.join("\n");
}

function buildHealthCheckUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/api(?:\/.*)?$/, "")}/api/health`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function formatConnectionCause(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) {
    return error.message.trim() || error.name;
  }
  const message = String(error).trim();
  return message || undefined;
}

function toStringRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, String(value)]));
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}
