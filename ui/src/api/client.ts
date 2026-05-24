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

// Module-scoped header registry. Components mount/unmount headers via
// `setRequestHeader(name, value)` / `setRequestHeader(name, null)`. Used by
// OnboardingWizard.tsx to tag every wizard-time fetch with
// `X-Paperclip-Onboarding: 1` so the server's auto-file middleware can scope
// 5xx incident filing to the onboarding surface without each api module
// growing a per-call header option.
const extraHeaders = new Map<string, string>();

export function setRequestHeader(name: string, value: string | null): void {
  const key = name.toLowerCase();
  if (value === null) extraHeaders.delete(key);
  else extraHeaders.set(key, value);
}

function applyExtraHeaders(headers: Headers): void {
  for (const [name, value] of extraHeaders) {
    if (!headers.has(name)) headers.set(name, value);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  applyExtraHeaders(headers);

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
