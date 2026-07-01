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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // NOTE: spread `init` first so the auto-augmented `headers` wins. Earlier
  // versions had this reversed, which let `init.headers` (a plain record)
  // clobber the merged `Headers` and drop `Content-Type: application/json`,
  // breaking every JSON request that carried an extra header (e.g. an
  // Idempotency-Key on agent-hires).
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new ApiError(
      (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      res.status,
      errorBody,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface ApiRequestOptions {
  headers?: Record<string, string>;
}

function withOptions(method: string, body: BodyInit | undefined, options?: ApiRequestOptions): RequestInit {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = body;
  if (options?.headers) init.headers = options.headers;
  return init;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown, options?: ApiRequestOptions) =>
    request<T>(path, withOptions("POST", JSON.stringify(body), options)),
  postForm: <T>(path: string, body: FormData, options?: ApiRequestOptions) =>
    request<T>(path, withOptions("POST", body, options)),
  put: <T>(path: string, body: unknown, options?: ApiRequestOptions) =>
    request<T>(path, withOptions("PUT", JSON.stringify(body), options)),
  patch: <T>(path: string, body: unknown, options?: ApiRequestOptions) =>
    request<T>(path, withOptions("PATCH", JSON.stringify(body), options)),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
