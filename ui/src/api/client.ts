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

/**
 * Perform an HTTP request against the API base path and return the parsed JSON response.
 *
 * Builds request headers (adds `Content-Type: application/json` unless the body is `FormData` or a `Content-Type` header is already present), sends the request with credentials included, and parses the response body as JSON. On HTTP 204 returns `undefined`. On non-OK responses parses the error body and throws an `ApiError`. For 401 responses, redirects the browser to `/auth?next=...` unless the request or current page is already an auth-related path.
 *
 * @param path - The API request path appended to the configured base (`BASE + path`)
 * @param init - Optional fetch `RequestInit` overrides (headers, method, body, etc.)
 * @returns The parsed JSON response typed as `T`, or `undefined` when the response status is 204.
 * @throws ApiError when the response is not OK; contains the HTTP status and the parsed error body.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${BASE}${path}`, {
    headers,
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    // Global 401 handler: redirect to login when auth fails.
    // Skip for auth-related endpoints to avoid redirect loops.
    if (
      res.status === 401
      && !path.startsWith("/auth")
      && !path.startsWith("/fleetos/login")
      && !window.location.pathname.startsWith("/auth")
    ) {
      const currentPath = window.location.pathname + window.location.search;
      const next = encodeURIComponent(currentPath);
      window.location.href = `/auth?next=${next}`;
    }
    throw new ApiError(
      (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      res.status,
      errorBody,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
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
