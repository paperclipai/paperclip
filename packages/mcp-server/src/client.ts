import { createHash } from "node:crypto";
import type { PaperclipMcpConfig } from "./config.js";

export class PaperclipApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(input: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    message: string;
  }) {
    super(input.message);
    this.name = "PaperclipApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.body = input.body;
  }
}

export class PaperclipApiReadbackMismatchError extends Error {
  constructor(path: string, field: string) {
    super(`Paperclip readback mismatch for ${field} after ${path}; stopping workflow.`);
    this.name = "PaperclipApiReadbackMismatchError";
  }
}

export interface JsonRequestOptions {
  body?: unknown;
  includeRunId?: boolean;
}

function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function buildErrorMessage(method: string, path: string, status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return `${method} ${path} failed with ${status}: ${body.error}`;
  }
  return `${method} ${path} failed with ${status}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function jsonRequestBody(body: unknown): { bytes: Uint8Array; contentDigest: string } {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    bytes,
    contentDigest: `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`,
  };
}

const SEMANTIC_TEXT_FIELDS = new Set([
  "title", "description", "comment", "body", "resolutionNote", "decisionNote", "reason", "summaryMarkdown",
  "prompt", "question", "answer", "message", "text", "instructions", "summary",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
    if (actual !== expected.value) throw new PaperclipApiReadbackMismatchError(path, formatTextPath(expected.path));
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

function assertExactText(path: string, field: string, expected: unknown, actual: unknown) {
  if (expected !== undefined && (typeof expected !== "string" || actual !== expected)) {
    throw new PaperclipApiReadbackMismatchError(path, field);
  }
}

function verifyTextMutationReadback(path: string, method: string, requestBody: unknown, response: unknown) {
  const pathname = path.split("?")[0] ?? path;
  const isIssueUpdate = method === "PATCH" && /^\/issues\/[^/]+$/.test(pathname);
  const isCommentCreate = method === "POST" && /^\/issues\/[^/]+\/comments$/.test(pathname);
  const isIssueCreate = method === "POST" && /^\/companies\/[^/]+\/issues$/.test(pathname);
  const isChildCreate = method === "POST" && /^\/issues\/[^/]+\/children$/.test(pathname);
  const isRecoveryResolve = method === "POST" && /^\/issues\/[^/]+\/recovery-actions\/resolve$/.test(pathname);
  const isInteraction = /^\/issues\/[^/]+\/interactions(?:\/[^/]+(?:\/(?:accept|reject|respond|verdicts|withdraw|cancel))?)?$/.test(pathname);
  const isDecision = /^\/(?:companies\/[^/]+\/(?:decisions|decision-bundles)|decisions\/[^/]+\/(?:decide|dismiss|cancel))$/.test(pathname);
  const requiresReadback = isIssueUpdate || isCommentCreate || isIssueCreate || isChildCreate || isRecoveryResolve || isInteraction || isDecision;
  const requested = isRecord(requestBody) ? requestBody : null;
  const expectedText = requested ? collectSemanticText(requested) : [];
  const expectedContractText = requested && (isInteraction || isDecision) ? collectContractText(requested) : [];
  if (!requiresReadback || (expectedText.length === 0 && expectedContractText.length === 0)) return;
  if (!isRecord(response)) throw new PaperclipApiReadbackMismatchError(path, "authoritative response unavailable");

  if (isCommentCreate) assertExactText(path, "body", requested?.body, response.body);
  if (isIssueCreate || isIssueUpdate) {
    assertExactText(path, "title", requested?.title, response.title);
    assertExactText(path, "description", requested?.description, response.description);
  }
  if (isIssueUpdate) assertExactText(path, "comment", requested?.comment, isRecord(response.comment) ? response.comment.body : undefined);
  if (isRecoveryResolve) assertExactText(path, "resolutionNote", requested?.resolutionNote, isRecord(response.recoveryAction) ? response.recoveryAction.resolutionNote : undefined);
  if (isChildCreate) {
    const child = isRecord(response.issue) ? response.issue : response;
    assertExactText(path, "title", requested?.title, child.title);
    assertExactText(path, "description", requested?.description, child.description);
  }
  if (isInteraction || isDecision) {
    const authoritative = isInteraction && isRecord(response.interaction)
      ? response.interaction
      : isDecision && isRecord(response.decision)
        ? response.decision
        : response;
    assertTextPaths(path, expectedContractText, authoritative);
  }
}

export class PaperclipApiClient {
  constructor(private readonly config: PaperclipMcpConfig) {}

  get defaults() {
    return {
      companyId: this.config.companyId,
      agentId: this.config.agentId,
      runId: this.config.runId,
    };
  }

  resolveCompanyId(companyId?: string | null): string {
    const resolved = companyId?.trim() || this.config.companyId;
    if (!resolved) {
      throw new Error("companyId is required because PAPERCLIP_COMPANY_ID is not set");
    }
    return resolved;
  }

  resolveAgentId(agentId?: string | null): string {
    const resolved = agentId?.trim() || this.config.agentId;
    if (!resolved) {
      throw new Error("agentId is required because PAPERCLIP_AGENT_ID is not set");
    }
    return resolved;
  }

  async requestJson<T>(method: string, path: string, options: JsonRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error(`API path must start with "/": ${path}`);
    }

    const url = new URL(path.slice(1), `${this.config.apiUrl}/`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
    };
    const requestBody = options.body === undefined ? undefined : jsonRequestBody(options.body);
    if (requestBody) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Digest"] = requestBody.contentDigest;
    }
    if ((options.includeRunId ?? isWriteMethod(method)) && this.config.runId) {
      headers["X-Paperclip-Run-Id"] = this.config.runId;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: requestBody?.bytes as unknown as BodyInit | undefined,
    });
    const parsedBody = await parseResponseBody(response);

    if (!response.ok) {
      throw new PaperclipApiError({
        status: response.status,
        method: method.toUpperCase(),
        path,
        body: parsedBody,
        message: buildErrorMessage(method.toUpperCase(), path, response.status, parsedBody),
      });
    }

    if (options.body !== undefined) verifyTextMutationReadback(path, method.toUpperCase(), options.body, parsedBody);
    return parsedBody as T;
  }
}
