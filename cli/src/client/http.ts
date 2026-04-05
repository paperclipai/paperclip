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

/** Retries for connection failures and selected HTTP statuses (502/503/504/429). Safe for idempotent reads; mutating calls may still double-apply if the server processed the first attempt but the response was lost—keep maxAttempts modest. */
export interface TransientRetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
}

const DEFAULT_TRANSIENT_RETRY: TransientRetryOptions = {
  maxAttempts: 4,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 12_000,
};

interface ApiClientOptions {
  apiBase: string;
  apiKey?: string;
  runId?: string;
  recoverAuth?: (input: RecoverAuthInput) => Promise<string | null>;
  /** Set to `false` to disable transient retries. Default: bounded backoff on 502/503/504/429 and fetch network errors. */
  transientRetry?: false | TransientRetryOptions;
}

export class PaperclipApiClient {
  readonly apiBase: string;
  apiKey?: string;
  readonly runId?: string;
  readonly recoverAuth?: (input: RecoverAuthInput) => Promise<string | null>;
  private readonly transientRetry: TransientRetryOptions | null;

  constructor(opts: ApiClientOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.runId = opts.runId?.trim() || undefined;
    this.recoverAuth = opts.recoverAuth;
    if (opts.transientRetry === false) {
      this.transientRetry = null;
    } else {
      const merged = { ...DEFAULT_TRANSIENT_RETRY, ...opts.transientRetry };
      merged.maxAttempts = Math.max(1, merged.maxAttempts);
      this.transientRetry = merged;
    }
  }

  get<T>(path: string, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, { method: "GET" }, opts);
  }

  post<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }, opts);
  }

  patch<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T | null> {
    return this.request<T>(path, {
      method: "PATCH",
      body: body === undefined ? undefined : JSON.stringify(body),
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

    const maxAttempts = this.transientRetry?.maxAttempts ?? 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...toStringRecord(init.headers),
      };

      if (init.body !== undefined) {
        headers["content-type"] = headers["content-type"] ?? "application/json";
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
        if (!this.shouldRetryTransient(attempt, maxAttempts, "connection")) {
          throw new ApiConnectionError({
            apiBase: this.apiBase,
            path,
            method,
            cause: error,
          });
        }
        await sleep(transientBackoffMs(this.transientRetry!, attempt));
        continue;
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

        if (isTransientHttpStatus(response.status) && this.shouldRetryTransient(attempt, maxAttempts, response.status)) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          await sleep(
            retryAfterMs ?? transientBackoffMs(this.transientRetry!, attempt),
          );
          continue;
        }

        throw apiError;
      }

      if (response.status === 204) {
        return null;
      }

      const text = await response.text();
      if (!text.trim()) {
        return null;
      }

      return safeParseJson(text) as T;
    }

    throw new Error(
      `[paperclip] internal: API request loop ended without result (${method} ${path}, maxAttempts=${maxAttempts})`,
    );
  }

  private shouldRetryTransient(
    attemptIndex: number,
    maxAttempts: number,
    kind: "connection" | number,
  ): boolean {
    if (!this.transientRetry || attemptIndex >= maxAttempts - 1) {
      return false;
    }
    return kind === "connection" || isTransientHttpStatus(kind);
  }
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
    "- Start Paperclip with `pnpm dev` or `pnpm paperclipai run`.",
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

function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function transientBackoffMs(cfg: TransientRetryOptions, attemptIndex: number): number {
  const mult = cfg.backoffMultiplier ?? 2;
  const cap = cfg.maxDelayMs ?? 12_000;
  const raw = cfg.initialDelayMs * mult ** attemptIndex;
  const capped = Math.min(cap, raw);
  const jitter = Math.floor(Math.random() * 250);
  return capped + jitter;
}

/** `Retry-After` as delay-seconds (common for 429/503). Ignores HTTP-date form. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header?.trim()) return undefined;
  const n = Number.parseInt(header.trim(), 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(n * 1000, 120_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
