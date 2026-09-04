import { getPageVisibility, getVisibilityHeaderValue } from "@/lib/page-visibility";
import { tenantSessionRecovery } from "@/lib/tenant-session-recovery";

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface RequestOptions {
  /** Abort signal wired through to `fetch` and coalescing (per-caller). */
  signal?: AbortSignal;
  /** Extra request headers (e.g. the async-import opt-in). Mutations only. */
  headers?: Record<string, string>;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  applyObservabilityHeaders(headers);

  const res = await fetch(`${BASE}${path}`, {
    headers,
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, errorBody);
    if (recovery) return recovery;
    throw new ApiError(
      (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      res.status,
      errorBody,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
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
    const promise = request<T>(path, { method: "GET", signal: controller.signal });
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
