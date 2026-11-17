/**
 * The only module that talks to googleapis.com. It sets the bearer header,
 * bounds each request in time and size, maps Google's errors to MCP errors,
 * and never retries a write.
 */
import { GoogleToolError, GoogleWorkspaceAuthError } from "./errors.js";

/** Hosts this package may call. Add a host when a service's tools land. */
export const GOOGLE_API_HOSTS = ["gmail.googleapis.com"] as const;
export type GoogleApiHost = (typeof GOOGLE_API_HOSTS)[number];

export type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface GoogleRequest {
  method: "GET" | "POST";
  host: GoogleApiHost;
  /** Absolute path, already percent-encoded where it embeds caller input. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

/** Same shape as `fetch`; a caller may pass its own egress-guarded fetch. */
export type GoogleFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GoogleHttpOptions {
  accessToken: string;
  fetch?: GoogleFetch;
  /** Cancels every request made with this client. */
  signal?: AbortSignal;
  /** Per-request deadline. */
  timeoutMs?: number;
  /** Delay before the single retry of a read. Tests set 0. */
  retryDelayMs?: number;
}

export interface GoogleHttp {
  send<T = unknown>(request: GoogleRequest): Promise<T>;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const RETRYABLE_READ_STATUSES = new Set([502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_ERROR_MESSAGE_LENGTH = 300;

export function googleRequestUrl(request: GoogleRequest): string {
  if (!GOOGLE_API_HOSTS.includes(request.host)) throw new Error(`Host is not allowed: ${request.host}`);
  if (!request.path.startsWith("/") || request.path.startsWith("//")) throw new Error("Request path must be absolute");
  const url = new URL(`https://${request.host}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function createGoogleHttp(options: GoogleHttpOptions): GoogleHttp {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  async function attempt(request: GoogleRequest): Promise<Response> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])];
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.accessToken}`,
      Accept: "application/json",
    };
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await doFetch(googleRequestUrl(request), {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.any(signals),
        redirect: "error",
      });
    } catch (error) {
      if (options.signal?.aborted) throw new GoogleToolError("timeout", "The request was cancelled.");
      if (isAbort(error)) {
        throw new GoogleToolError("timeout", request.method === "GET"
          ? "Google did not answer in time."
          : "Google did not answer in time. The change may or may not have been made; check before trying again.");
      }
      throw new GoogleToolError("network", "Could not reach Google.");
    }
  }

  return {
    async send<T>(request: GoogleRequest): Promise<T> {
      let response: Response;
      for (let tries = 0; ; tries += 1) {
        // Reads are safe to repeat once. Writes are never repeated: Google may
        // have applied a request before failing.
        const mayRetry = request.method === "GET" && tries === 0;
        try {
          response = await attempt(request);
        } catch (error) {
          if (mayRetry && error instanceof GoogleToolError && error.kind === "network") {
            await delay(retryDelayMs, options.signal);
            continue;
          }
          throw error;
        }
        if (mayRetry && RETRYABLE_READ_STATUSES.has(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          await delay(retryDelayMs, options.signal);
          continue;
        }
        break;
      }
      const text = await readBounded(response);
      if (!response.ok) throw googleError(response, text);
      if (text.length === 0) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new GoogleToolError("invalid_response", "Google returned a response that is not JSON.", response.status);
      }
    },
  };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleToolError("invalid_response", "Google's response is too large.", response.status);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new GoogleToolError("invalid_response", "Google's response is too large.", response.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string }>;
    details?: Array<{ reason?: string }>;
  } | string;
}

/** Map a non-2xx Google response to the error a caller can act on. */
export function googleError(response: Pick<Response, "status" | "headers">, text: string): Error {
  const status = response.status;
  let body: GoogleErrorBody = {};
  try {
    body = JSON.parse(text) as GoogleErrorBody;
  } catch {
    // Non-JSON error bodies keep the status mapping below.
  }
  const error = typeof body.error === "object" ? body.error : undefined;
  const reasons = new Set([
    ...(error?.errors ?? []).map((item) => item.reason),
    ...(error?.details ?? []).map((item) => item.reason),
    typeof body.error === "string" ? body.error : undefined,
  ].filter((reason): reason is string => typeof reason === "string"));
  const authenticate = response.headers.get("www-authenticate") ?? "";

  if (status === 401) return new GoogleWorkspaceAuthError("unauthenticated");
  if (status === 403 && (
    /\berror\s*=\s*"?insufficient_scope\b/i.test(authenticate)
    || reasons.has("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
    || reasons.has("insufficientPermissions")
    || reasons.has("insufficient_scope")
  )) return new GoogleWorkspaceAuthError("insufficient_scope");

  const message = safeMessage(error?.message);
  if (status === 403 && (reasons.has("SERVICE_DISABLED") || reasons.has("accessNotConfigured"))) {
    return new GoogleToolError("api_disabled", "This Google API is not enabled for the Google Cloud project behind this connection.", status);
  }
  if (status === 429 || reasons.has("RATE_LIMIT_EXCEEDED") || reasons.has("rateLimitExceeded") || reasons.has("userRateLimitExceeded")) {
    return new GoogleToolError("rate_limited", "Google is rate limiting requests. Try again shortly.", status);
  }
  if (status === 403) return new GoogleToolError("permission_denied", message ?? "Google denied access to this item.", status);
  if (status === 404) return new GoogleToolError("not_found", "Google could not find that item.", status);
  if (status === 400 || status === 409 || status === 412 || status === 413) {
    return new GoogleToolError("invalid_argument", message ?? "Google rejected the request.", status);
  }
  if (status >= 500) return new GoogleToolError("unavailable", "Google is temporarily unavailable. Try again shortly.", status);
  return new GoogleToolError("invalid_response", message ?? `Google returned HTTP ${status}.`, status);
}

function safeMessage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_ERROR_MESSAGE_LENGTH ? `${oneLine.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : oneLine;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new GoogleToolError("timeout", "The request was cancelled."));
    }, { once: true });
  });
}
