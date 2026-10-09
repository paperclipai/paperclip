import { getPageVisibility, getVisibilityHeaderValue } from "@/lib/page-visibility";
import { tenantSessionRecovery } from "@/lib/tenant-session-recovery";
import { apiErrorMessage, parseRetryAfter } from "./errors";
import { readApiJson } from "./response";

const BASE = "/api";

export interface ApiErrorOptions {
  /** Raw server error code; defaults to `body.error` when that is a string. */
  code?: string | null;
  /** Server-requested delay from the `Retry-After` header, in milliseconds. */
  retryAfterMs?: number | null;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  /**
   * The raw `body.error` string (for example `tenant_app_unavailable`). Match
   * on this, never on `message`: `message` is readable copy for people and may
   * differ from the code (see `apiErrorMessage` in `api/errors.ts`).
   */
  code: string | null;
  retryAfterMs: number | null;

  constructor(message: string, status: number, body: unknown, options: ApiErrorOptions = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    const rawError = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    this.code = options.code !== undefined ? options.code : typeof rawError === "string" ? rawError : null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** Build the `ApiError` for a non-OK response whose body has been read. */
export function apiErrorFromResponse(res: Response, body: unknown): ApiError {
  return new ApiError(apiErrorMessage(res.status, body), res.status, body, {
    retryAfterMs: parseRetryAfter(res.headers?.get("Retry-After") ?? null),
  });
}

// --- Dev/QA outage simulator ----------------------------------------------------
//
// Reproduces a deploy blip without a deploy. Dev and QA builds only:
//
//   localStorage.paperclipSimulateOutage = "503:tenant_app_unavailable"     // until removed
//   localStorage.paperclipSimulateOutage = "503:tenant_app_unavailable@20"  // for 20 seconds
//   localStorage.paperclipSimulateOutage = "502"       // non-JSON proxy page
//   localStorage.paperclipSimulateOutage = "network"   // fetch rejects (connection drop)
//
// Every same-origin API request made through `apiFetch` (the client, health,
// session) fails with the chosen shape. Remove the key to end the outage.

export const OUTAGE_SIMULATOR_STORAGE_KEY = "paperclipSimulateOutage";

export type SimulatedOutage =
  | { kind: "network"; durationMs: number | null }
  | { kind: "status"; status: number; code: string | null; durationMs: number | null };

export function parseSimulatedOutage(raw: string | null | undefined): SimulatedOutage | null {
  const match = /^\s*(network|(\d{3})(?::([A-Za-z0-9_.-]+))?)(?:@(\d+(?:\.\d+)?))?\s*$/.exec(raw ?? "");
  if (!match) return null;
  const durationMs = match[4] ? Math.round(Number(match[4]) * 1000) : null;
  if (match[1] === "network") return { kind: "network", durationMs };
  const status = Number(match[2]);
  if (status < 400 || status > 599) return null;
  return { kind: "status", status, code: match[3] ?? null, durationMs };
}

function outageSimulatorEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.MODE === "qa";
}

let simulatedOutageWindow: { raw: string; endsAt: number | null } | null = null;

/** The outage to simulate for the next request, or null. Never throws. */
export function activeSimulatedOutage(now = Date.now()): SimulatedOutage | null {
  if (!outageSimulatorEnabled() || typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage?.getItem(OUTAGE_SIMULATOR_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  const outage = parseSimulatedOutage(raw);
  if (!raw || !outage) {
    simulatedOutageWindow = null;
    return null;
  }
  if (simulatedOutageWindow?.raw !== raw) {
    simulatedOutageWindow = { raw, endsAt: outage.durationMs === null ? null : now + outage.durationMs };
  }
  if (simulatedOutageWindow.endsAt !== null && now >= simulatedOutageWindow.endsAt) {
    simulatedOutageWindow = null;
    try {
      window.localStorage.removeItem(OUTAGE_SIMULATOR_STORAGE_KEY);
    } catch {
      // Storage can be unavailable; the outage still ends for this tab.
    }
    return null;
  }
  return outage;
}

function simulatedOutageResponse(outage: Extract<SimulatedOutage, { kind: "status" }>): Response {
  if (!outage.code) {
    // What a proxy serves while the app is down: an HTML page, not JSON.
    return new Response("<!doctype html><title>Unavailable</title>", {
      status: outage.status,
      headers: { "Content-Type": "text/html" },
    });
  }
  return new Response(JSON.stringify({ error: outage.code }), {
    status: outage.status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * `fetch` for same-origin API calls. Identical to `fetch` except that the
 * dev/QA outage simulator can intercept it.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const outage = activeSimulatedOutage();
  if (outage) {
    if (init?.signal?.aborted) throw abortError();
    if (outage.kind === "network") throw new TypeError("Failed to fetch");
    return simulatedOutageResponse(outage);
  }
  return fetch(input, init);
}

export interface RequestOptions {
  /** Abort signal wired through to `fetch` and coalescing (per-caller). */
  signal?: AbortSignal;
  /** Extra request headers (e.g. the async-import opt-in). Mutations only. */
  headers?: Record<string, string>;
  /** The `fetch` cache mode. Use `"no-store"` for a response that must never
   *  come from the browser's HTTP cache. */
  cache?: RequestCache;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Non-authoritative observability hints (PAP-12556 / Phase 1). The server treats
 * these as scheduling/telemetry only and never as security signals.
 */
function applyObservabilityHeaders(headers: Headers) {
  if (headers.has("X-Paperclip-Tab-Visible")) return; // caller override wins
  const visibility = getPageVisibility();
  headers.set("X-Paperclip-Tab-Visible", getVisibilityHeaderValue(visibility));
  if (typeof window !== "undefined" && window.location) {
    headers.set("X-Paperclip-Route", window.location.pathname);
  }
}

export async function requestResponse(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  applyObservabilityHeaders(headers);

  const res = await apiFetch(`${BASE}${path}`, {
    credentials: "include",
    ...init,
    headers,
  });
  if (!res.ok) {
    const errorBody = await readApiJson(res);
    const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, errorBody);
    if (recovery) return recovery;
    throw apiErrorFromResponse(res, errorBody);
  }
  return res;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await requestResponse(path, init);
  if (res.status === 204) return undefined as T;
  return readApiJson<T>(res);
}

// --- In-tab request coalescing for identical safe GETs -----------------------
//
// Multiple callers issuing the same GET while one is in flight share a single
// underlying fetch. Each caller keeps its own abort semantics: aborting one
// caller only cancels the shared fetch when *every* caller has aborted.
// Mutations are never coalesced.

interface InflightGet {
  promise: Promise<unknown>;
  controller: AbortController;
  refs: Set<symbol>;
}

const inflightGets = new Map<string, InflightGet>();

function coalescedGet<T>(path: string, options?: RequestOptions): Promise<T> {
  const signal = options?.signal;
  if (signal?.aborted) return Promise.reject(abortError());

  let entry = inflightGets.get(path);
  if (!entry) {
    const controller = new AbortController();
    const promise = request<T>(path, {
      method: "GET",
      signal: controller.signal,
      ...(options?.cache ? { cache: options.cache } : {}),
    });
    const created: InflightGet = { promise, controller, refs: new Set() };
    // Clear the shared entry once settled so later calls issue a fresh request.
    promise.then(
      () => {
        if (inflightGets.get(path) === created) inflightGets.delete(path);
      },
      () => {
        if (inflightGets.get(path) === created) inflightGets.delete(path);
      },
    );
    inflightGets.set(path, created);
    entry = created;
  }

  const activeEntry = entry;
  const ref = Symbol("caller");
  activeEntry.refs.add(ref);

  const releaseRef = () => {
    if (!activeEntry.refs.delete(ref)) return;
    // Last caller gone before the fetch settled → abort the shared request.
    if (activeEntry.refs.size === 0 && inflightGets.get(path) === activeEntry) {
      inflightGets.delete(path);
      activeEntry.controller.abort();
    }
  };

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal?.removeEventListener("abort", onAbort);
      releaseRef();
      reject(abortError());
    };
    if (signal) signal.addEventListener("abort", onAbort);

    activeEntry.promise.then(
      (value) => {
        signal?.removeEventListener("abort", onAbort);
        activeEntry.refs.delete(ref);
        resolve(value as T);
      },
      (err) => {
        signal?.removeEventListener("abort", onAbort);
        activeEntry.refs.delete(ref);
        reject(err);
      },
    );
  });
}

/**
 * Stop later callers from joining the in-flight GET for `path`.
 *
 * Coalescing keys on the path alone, so a GET issued under one account's session
 * can be joined by a caller that runs after the account changed — and handed the
 * previous account's response. Detaching leaves that request to settle for the
 * callers that asked for it, and makes the next call issue a fresh one. It does
 * not abort, because those callers still want what they asked for.
 */
export function detachInflightGet(path: string): void {
  inflightGets.delete(path);
}

/** Test-only: number of in-flight coalesced GET keys. */
export function __inflightGetCount(): number {
  return inflightGets.size;
}

function isRequestOptions(value: unknown): value is RequestOptions {
  return typeof value === "object" && value !== null && "signal" in value;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => coalescedGet<T>(path, options),
  post: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
      signal: options?.signal,
      ...(options?.headers ? { headers: options.headers } : {}),
    }),
  postForm: <T>(path: string, body: FormData, options?: RequestOptions) =>
    request<T>(path, {
      method: "POST",
      body,
      signal: options?.signal,
      // Never set Content-Type here — the browser sets multipart/form-data with
      // the boundary. Extra headers (e.g. an async opt-in) may still ride along.
      ...(options?.headers ? { headers: options.headers } : {}),
    }),
  put: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body), signal: options?.signal }),
  /** Raw binary upload (e.g. one chunked import-transfer part); the body travels as-is. */
  putRaw: <T>(path: string, body: Blob, options?: RequestOptions) =>
    request<T>(path, {
      method: "PUT",
      body,
      signal: options?.signal,
      headers: { "Content-Type": "application/octet-stream", ...(options?.headers ?? {}) },
    }),
  patch: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body), signal: options?.signal }),
  delete: <T>(path: string, bodyOrOptions?: unknown, options?: RequestOptions) => {
    const requestOptions = isRequestOptions(bodyOrOptions) ? bodyOrOptions : options;
    const body = bodyOrOptions === undefined || isRequestOptions(bodyOrOptions) ? undefined : JSON.stringify(bodyOrOptions);
    return request<T>(path, { method: "DELETE", ...(body === undefined ? {} : { body }), signal: requestOptions?.signal });
  },
  deleteWithBody: <T>(path: string, body: unknown, options?: RequestOptions) =>
    request<T>(path, { method: "DELETE", body: JSON.stringify(body), signal: options?.signal }),
};
