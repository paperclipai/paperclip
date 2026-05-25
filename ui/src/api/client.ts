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

const NETWORK_RETRY_DELAYS_MS = [200, 600, 1500];

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForOnline(timeoutMs: number) {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener("online", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    window.addEventListener("online", done, { once: true });
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const method = (init?.method ?? "GET").toUpperCase();
  const canRetryNetwork = method === "GET";

  let lastError: unknown;
  const attempts = canRetryNetwork ? NETWORK_RETRY_DELAYS_MS.length + 1 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
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
        );
      }
      if (res.status === 204) return undefined as T;
      return res.json();
    } catch (err) {
      lastError = err;
      if (!canRetryNetwork || !isNetworkError(err) || attempt === attempts - 1) {
        throw err;
      }
      await waitForOnline(NETWORK_RETRY_DELAYS_MS[attempt]);
      await sleep(NETWORK_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
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
