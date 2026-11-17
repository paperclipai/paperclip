import { GoogleToolError, GoogleWorkspaceAuthError } from "./errors.js";

export const GOOGLE_API_HOSTS = ["gmail.googleapis.com", "www.googleapis.com"] as const;
export type GoogleApiHost = (typeof GOOGLE_API_HOSTS)[number];
export const GOOGLE_API_PATH_PREFIXES: Partial<Record<GoogleApiHost, string>> = { "www.googleapis.com": "/calendar/v3/" };

export type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface GoogleRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  host: GoogleApiHost;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  readOnly?: boolean;
  ifMatch?: string;
}

export type GoogleFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GoogleHttpOptions {
  accessToken: string;
  fetch?: GoogleFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export interface GoogleHttp {
  send<T = unknown>(request: GoogleRequest): Promise<T>;
}

interface GoogleAnswer {
  status: number;
  headers: Headers;
  text: string;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const RETRYABLE_READ_STATUSES = new Set([502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_ERROR_MESSAGE_LENGTH = 300;
export const UNCERTAIN_WRITE = "The change may or may not have been made; check before trying again.";

export function googleRequestUrl(request: GoogleRequest): string {
  if (!GOOGLE_API_HOSTS.includes(request.host)) throw new Error(`Host is not allowed: ${request.host}`);
  if (!request.path.startsWith("/") || request.path.startsWith("//")) throw new Error("Request path must be absolute");
  const url = new URL(`https://${request.host}${request.path}`);
  const prefix = GOOGLE_API_PATH_PREFIXES[request.host];
  if (prefix && !url.pathname.startsWith(prefix)) throw new Error(`Path is not allowed on ${request.host}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function isWrite(request: Pick<GoogleRequest, "method" | "readOnly">): boolean {
  if (request.method === "GET") return false;
  return !(request.method === "POST" && request.readOnly === true);
}

function withWriteWarning(request: GoogleRequest, message: string): string {
  return isWrite(request) ? `${message} ${UNCERTAIN_WRITE}` : message;
}

export function createGoogleHttp(options: GoogleHttpOptions): GoogleHttp {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  async function attempt(request: GoogleRequest): Promise<GoogleAnswer> {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.accessToken}`,
      Accept: "application/json",
    };
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    if (request.ifMatch) headers["If-Match"] = request.ifMatch;
    const url = googleRequestUrl(request);
    try {
      const response = await doFetch(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal,
        redirect: "error",
      });
      return { status: response.status, headers: response.headers, text: await readBounded(response) };
    } catch (error) {
      if (error instanceof GoogleToolError) {
        throw new GoogleToolError(error.kind, withWriteWarning(request, error.message), error.httpStatus);
      }
      if (options.signal?.aborted) throw new GoogleToolError("timeout", withWriteWarning(request, "The request was cancelled."));
      if (isAbort(error)) throw new GoogleToolError("timeout", withWriteWarning(request, "Google did not answer in time."));
      throw new GoogleToolError("network", withWriteWarning(request, "Could not reach Google."));
    }
  }

  return {
    async send<T>(request: GoogleRequest): Promise<T> {
      let answer: GoogleAnswer;
      for (let tries = 0; ; tries += 1) {
        const mayRetry = !isWrite(request) && tries === 0;
        try {
          answer = await attempt(request);
        } catch (error) {
          if (mayRetry && error instanceof GoogleToolError && error.kind === "network") {
            await delay(retryDelayMs, options.signal);
            continue;
          }
          throw error;
        }
        if (mayRetry && RETRYABLE_READ_STATUSES.has(answer.status)) {
          await delay(retryDelayMs, options.signal);
          continue;
        }
        break;
      }
      if (answer.status < 200 || answer.status >= 300) throw googleError(answer, answer.text, request);
      if (answer.text.length === 0) return {} as T;
      try {
        return JSON.parse(answer.text) as T;
      } catch {
        throw new GoogleToolError("invalid_response", withWriteWarning(request, "Google returned a response that is not JSON."), answer.status);
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

export function googleError(
  response: { status: number; headers: Pick<Headers, "get"> },
  text: string,
  request?: GoogleRequest,
): Error {
  const status = response.status;
  let body: GoogleErrorBody = {};
  try {
    body = JSON.parse(text) as GoogleErrorBody;
  } catch {
    body = {};
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
  if (status === 404 || status === 410) return new GoogleToolError("not_found", "Google could not find that item.", status);
  if (status === 412) return new GoogleToolError("invalid_argument", "The item changed after it was read, so nothing was changed. Read it again and retry.", status);
  if (status === 400 || status === 409 || status === 413) {
    return new GoogleToolError("invalid_argument", message ?? "Google rejected the request.", status);
  }
  if (status >= 500) {
    const unavailable = "Google is temporarily unavailable.";
    return new GoogleToolError("unavailable", request && isWrite(request) ? withWriteWarning(request, unavailable) : `${unavailable} Try again shortly.`, status);
  }
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
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GoogleToolError("timeout", "The request was cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
