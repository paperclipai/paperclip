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

// Turn a Zod issue list (the `details` body the server attaches to a 400
// "Validation error") into readable "field: message" lines. Without this the
// UI only ever shows the generic top-level "Validation error" string and the
// user can't tell which field was rejected.
function zodIssueMessages(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const lines: string[] = [];
  for (const issue of details) {
    if (!issue || typeof issue !== "object") continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== "string" || message.length === 0) continue;
    const field = Array.isArray(path)
      ? path.filter((segment) => segment !== "" && segment != null).join(".")
      : "";
    lines.push(field ? `${field}: ${message}` : message);
  }
  return lines;
}

// Build a user-facing message from a thrown request error, naming the specific
// field(s) when the server returned Zod validation `details`. Falls back to the
// error message and finally to `fallback`.
export function formatApiError(error: unknown, fallback = "Request failed."): string {
  if (error instanceof ApiError) {
    const body = error.body as { details?: unknown } | null;
    const fieldMessages = zodIssueMessages(body?.details);
    if (fieldMessages.length > 0) {
      const prefix = error.message && error.message !== "Validation error" ? `${error.message}: ` : "";
      return `${prefix}${fieldMessages.join("; ")}`;
    }
    return error.message || fallback;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
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
