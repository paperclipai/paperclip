const BASE = "/api";
const MAX_CONCURRENT_REQUESTS = 3;
const DEDUP_WINDOW_MS = 5_000;

let inflightRequests = 0;
const requestQueue: Array<() => void> = [];

// Promise dedup cache for GET requests to company-scoped endpoints.
// Prevents multiple tabs/components from firing identical in-flight requests.
const dedupCache = new Map<string, { promise: Promise<unknown>; expiresAt: number }>();

function dedupCacheGet(path: string): Promise<unknown> | undefined {
  const entry = dedupCache.get(path);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    dedupCache.delete(path);
    return undefined;
  }
  return entry.promise;
}

function dedupCacheSet(path: string, promise: Promise<unknown>): void {
  dedupCache.set(path, { promise, expiresAt: Date.now() + DEDUP_WINDOW_MS });
}

function isDeduplicatedPath(path: string): boolean {
  return path.includes("/companies/");
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  headers: Headers;

  constructor(message: string, status: number, body: unknown, headers?: Headers) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.headers = headers ?? new Headers();
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isGet = !init?.method || init.method.toUpperCase() === "GET";
  if (isGet && isDeduplicatedPath(path)) {
    const cached = dedupCacheGet(path);
    if (cached) return cached as Promise<T>;
  }

  await new Promise<void>((resolve) => {
    const start = () => {
      inflightRequests += 1;
      resolve();
    };
    if (inflightRequests < MAX_CONCURRENT_REQUESTS) {
      start();
      return;
    }
    requestQueue.push(start);
  });

  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const promise = (async (): Promise<T> => {
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers,
        credentials: "include",
        ...init,
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        throw new ApiError(
          (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
          res.status,
          errorBody,
          res.headers,
        );
      }
      if (res.status === 204) return undefined as T;
      return res.json() as Promise<T>;
    } finally {
      inflightRequests = Math.max(0, inflightRequests - 1);
      const next = requestQueue.shift();
      if (next) next();
    }
  })();

  if (isGet && isDeduplicatedPath(path)) {
    dedupCacheSet(path, promise as Promise<unknown>);
  }
  return promise;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  postForm: <T>(path: string, body: FormData) =>
    request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
