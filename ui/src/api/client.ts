const BASE = "/api";
const MAX_CONCURRENT_REQUESTS = 3;

let inflightRequests = 0;
const requestQueue: Array<() => void> = [];

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
    return res.json();
  } finally {
    inflightRequests = Math.max(0, inflightRequests - 1);
    const next = requestQueue.shift();
    if (next) next();
  }
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
