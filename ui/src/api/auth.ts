import {
  authSessionSchema,
  currentUserProfileSchema,
  type AuthSession,
  type CurrentUserProfile,
  type UpdateCurrentUserProfile,
} from "@paperclipai/shared";
import { redactUrlSecrets } from "@/lib/redact-url-secrets";

type AuthErrorBody =
  | {
    code?: string;
    message?: string;
    error?: string | { code?: string; message?: string };
  }
  | null;

export interface SignOutResult {
  success?: boolean;
  redirectTo?: string;
}

export class AuthApiError extends Error {
  status: number;
  code: string | null;
  body: unknown;

  constructor(message: string, status: number, body: unknown, code: string | null = null) {
    super(message);
    this.name = "AuthApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function toSession(value: unknown): AuthSession | null {
  const direct = authSessionSchema.safeParse(value);
  if (direct.success) return direct.data;

  if (!value || typeof value !== "object") return null;
  const nested = authSessionSchema.safeParse((value as Record<string, unknown>).data);
  return nested.success ? nested.data : null;
}

function extractAuthError(payload: AuthErrorBody, status: number) {
  const nested =
    payload?.error && typeof payload.error === "object"
      ? payload.error
      : null;
  const code =
    typeof nested?.code === "string"
      ? nested.code
      : typeof payload?.code === "string"
        ? payload.code
        : null;
  const message =
    typeof nested?.message === "string" && nested.message.trim().length > 0
      ? nested.message
      : typeof payload?.message === "string" && payload.message.trim().length > 0
        ? payload.message
        : typeof payload?.error === "string" && payload.error.trim().length > 0
          ? payload.error
          : `Request failed: ${status}`;

  return new AuthApiError(message, status, payload, code);
}

type AuthRetryPolicy = {
  maxRetries?: number;
  retryDelayMs?: (attempt: number) => number;
  isRetryable?: (error: AuthApiError) => boolean;
};

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableNetworkError(error: unknown) {
  if (error instanceof AuthApiError) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|Failed to fetch|NetworkError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout/i.test(message);
}

function shouldRetrySignInError(error: AuthApiError) {
  if (error.status === 429) return true;
  if (error.status >= 500) return true;
  if (error.code === "TOO_MANY_REQUESTS" || error.code === "TOO_MANY_REQUESTS_ERROR") return true;
  return false;
}

// Rich diagnostics for auth requests. Network-layer failures (Safari
// "Load failed" / Chrome "Failed to fetch") throw a TypeError *before* any
// HTTP response, so they are indistinguishable from a bad password in the UI
// unless we log the resolved request URL + origin here. See PAP-13466.
function resolveAuthUrl(path: string) {
  const relative = `/api/auth${path}`;
  try {
    return new URL(relative, window.location.origin).href;
  } catch {
    return relative;
  }
}

function logAuthNetworkFailure(method: string, path: string, error: unknown) {
  // eslint-disable-next-line no-console
  console.error("[auth] request failed at the network layer (no HTTP response)", {
    method,
    requestUrl: resolveAuthUrl(path),
    pageOrigin: typeof window !== "undefined" ? window.location.origin : "(no window)",
    pageHref: typeof window !== "undefined" ? redactUrlSecrets(window.location.href) : "(no window)",
    credentials: "include",
    online: typeof navigator !== "undefined" ? navigator.onLine : "(no navigator)",
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    error,
    hint:
      "This means the browser never got a response from the server. Common causes: " +
      "the page origin differs from the API host (mixed http/https, wrong hostname/port, " +
      "or a proxy/tunnel that only forwards the page but not /api), an SSL error, or the " +
      "connection was reset. A wrong password would instead return HTTP 401, not this.",
  });
}

function logAuthHttpError(method: string, path: string, status: number, statusText: string, body: unknown) {
  // eslint-disable-next-line no-console
  console.error("[auth] request returned an error status", {
    method,
    requestUrl: resolveAuthUrl(path),
    status,
    statusText,
    body,
  });
}

async function authPost(
  path: string,
  body: Record<string, unknown>,
  retryPolicy: AuthRetryPolicy = {},
): Promise<unknown> {
  const {
    maxRetries = 0,
    retryDelayMs = (attempt) => Math.min(600, 120 * attempt),
    isRetryable = shouldRetrySignInError,
  } = retryPolicy;

  let attempt = 0;
  while (true) {
    attempt += 1;
    let res: Response;
    try {
      res = await fetch(`/api/auth${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (networkError) {
      logAuthNetworkFailure("POST", path, networkError);
      if (attempt <= maxRetries && isRetryableNetworkError(networkError)) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      throw networkError instanceof Error
        ? networkError
        : new Error(`Authentication request failed: ${networkError}`);
    }

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      logAuthHttpError("POST", path, res.status, res.statusText, payload);
      const error = extractAuthError(payload as AuthErrorBody, res.status);
      if (attempt <= maxRetries && isRetryable(error)) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      throw error;
    }
    return payload;
  }
}

async function authPatch<T>(path: string, body: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return parse(payload);
}

export const authApi = {
  getSession: async (): Promise<AuthSession | null> => {
    const res = await fetch("/api/auth/get-session", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return null;
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`Failed to load session (${res.status})`);
    }
    const direct = toSession(payload);
    if (direct) return direct;
    const nested = payload && typeof payload === "object" ? toSession((payload as Record<string, unknown>).data) : null;
    return nested;
  },

  signInEmail: async (input: { email: string; password: string }) => {
    return (await authPost("/sign-in/email", input, {
      maxRetries: 4,
      retryDelayMs: (attempt) => 300 * attempt,
    })) as { twoFactorRedirect?: boolean } | null;
  },

  signUpEmail: async (input: { name: string; email: string; password: string }) => {
    await authPost("/sign-up/email", input);
  },

  twoFactor: {
    verifyTotp: async (input: { code: string; trustDevice?: boolean }) => {
      await authPost("/two-factor/verify-totp", input);
    },
    verifyBackupCode: async (input: { code: string }) => {
      await authPost("/two-factor/verify-backup-code", input);
    },
    enable: async (input: { password: string }) => {
      return (await authPost("/two-factor/enable", input)) as {
        totpURI?: string;
        backupCodes?: string[];
      } | null;
    },
    disable: async (input: { password: string }) => {
      await authPost("/two-factor/disable", input);
    },
    generateBackupCodes: async (input: { password: string }) => {
      return (await authPost("/two-factor/generate-backup-codes", input)) as {
        backupCodes?: string[];
      } | null;
    },
  },

  getProfile: async (): Promise<CurrentUserProfile> => {
    const res = await fetch("/api/auth/profile", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error((payload as { error?: string } | null)?.error ?? `Failed to load profile (${res.status})`);
    }
    return currentUserProfileSchema.parse(payload);
  },

  updateProfile: async (input: UpdateCurrentUserProfile): Promise<CurrentUserProfile> =>
    authPatch("/profile", input, (payload) => currentUserProfileSchema.parse(payload)),

  signOut: async (): Promise<SignOutResult | null> => {
    const payload = await authPost("/sign-out", {});
    if (!payload || typeof payload !== "object") return null;

    const result = payload as Record<string, unknown>;
    return {
      ...(typeof result.success === "boolean" ? { success: result.success } : {}),
      ...(typeof result.redirectTo === "string" ? { redirectTo: result.redirectTo } : {}),
    };
  },
};
