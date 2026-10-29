import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import {
  authAccountSecuritySchema,
  authSessionSchema,
  authSignInOptionsSchema,
  currentUserProfileSchema,
  type AuthAccountSecurity,
  type AuthSession,
  type AuthSignInOptions,
  type CurrentUserProfile,
  type UpdateCurrentUserProfile,
} from "@paperclipai/shared";
import { redactUrlSecrets } from "@/lib/redact-url-secrets";
import { tenantSessionRecovery } from "@/lib/tenant-session-recovery";
import { apiFetch } from "./client";
import { apiErrorMessage, isRawErrorCode } from "./errors";
import { readApiJson } from "./response";

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

export interface EmailSignInResult {
  twoFactorRequired: boolean;
}

export interface TwoFactorEnrollment {
  totpURI: string;
  backupCodes: string[];
}

export interface AuthPasskey {
  id: string;
  name: string | null;
  deviceType: string | null;
  createdAt: string | null;
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

/** The server's own explanation on an auth error body, if it sent one. */
export function authErrorServerMessage(payload: unknown): string | null {
  const body = payload && typeof payload === "object" ? payload as Exclude<AuthErrorBody, null> : null;
  const nested = body?.error && typeof body.error === "object" ? body.error : null;
  const candidates = [nested?.message, body?.message, typeof body?.error === "string" ? body.error : undefined];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
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
  const message = authErrorServerMessage(payload);

  // Never surface a raw gateway code ("tenant_app_unavailable") as the message.
  const readable = message && !isRawErrorCode(message) ? message : apiErrorMessage(status, payload);
  return new AuthApiError(readable, status, payload, code);
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

async function authRequest(method: "GET" | "POST", path: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`/api/auth${path}`, { ...init, method, credentials: "include" });
  } catch (networkError) {
    logAuthNetworkFailure(method, path, networkError);
    throw networkError;
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
    if (recovery) return recovery;
    logAuthHttpError(method, path, res.status, res.statusText, payload);
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return payload;
}

function authPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  return authRequest("POST", path, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authGet(path: string): Promise<unknown> {
  return authRequest("GET", path, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// Better Auth replaces the stored codes before it responds, so an empty list
// means the user's old codes are gone and no new ones arrived.
function toBackupCodes(payload: unknown): string[] {
  const codes = payload && typeof payload === "object"
    ? stringList((payload as Record<string, unknown>).backupCodes)
    : [];
  if (codes.length === 0) {
    throw new Error("The server did not return any backup codes. Try again.");
  }
  return codes;
}

function toPasskey(value: unknown): AuthPasskey | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string") return null;
  return {
    id: row.id,
    name: typeof row.name === "string" && row.name.trim().length > 0 ? row.name : null,
    deviceType: typeof row.deviceType === "string" ? row.deviceType : null,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
  };
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
    const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
    if (recovery) return recovery;
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return parse(payload);
}

export const authApi = {
  getSession: async (): Promise<AuthSession | null> => {
    const res = await apiFetch("/api/auth/get-session", {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const payload = await readApiJson(res);
    if (!res.ok) {
      const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
      if (recovery) return recovery;
      if (res.status === 401) return null;
      throw extractAuthError(payload as AuthErrorBody, res.status);
    }
    const direct = toSession(payload);
    if (direct) return direct;
    const nested = payload && typeof payload === "object" ? toSession((payload as Record<string, unknown>).data) : null;
    return nested;
  },

  signInEmail: async (input: { email: string; password: string }): Promise<EmailSignInResult> => {
    const payload = await authPost("/sign-in/email", input);
    const twoFactorRequired = Boolean(
      payload && typeof payload === "object" && (payload as Record<string, unknown>).twoFactorRedirect === true,
    );
    return { twoFactorRequired };
  },

  verifyTotp: async (input: { code: string; trustDevice: boolean }) => {
    await authPost("/two-factor/verify-totp", input);
  },

  verifyBackupCode: async (input: { code: string; trustDevice: boolean }) => {
    await authPost("/two-factor/verify-backup-code", input);
  },

  signInPasskey: async () => {
    const optionsJSON = await authGet("/passkey/generate-authenticate-options") as PublicKeyCredentialRequestOptionsJSON;
    // The plugin asks only for "preferred"; the server rejects ceremonies without
    // user verification, so have the authenticator demand a PIN or biometric up front.
    optionsJSON.userVerification = "required";
    const { startAuthentication } = await import("@simplewebauthn/browser");
    const response = await startAuthentication({ optionsJSON });
    await authPost("/passkey/verify-authentication", { response });
  },

  getSignInOptions: async (): Promise<AuthSignInOptions> =>
    authSignInOptionsSchema.parse(await authGet("/sign-in-options")),

  getAccountSecurity: async (): Promise<AuthAccountSecurity> =>
    authAccountSecuritySchema.parse(await authGet("/account-security")),

  enableTwoFactor: async (input: { password: string }): Promise<TwoFactorEnrollment> => {
    const payload = await authPost("/two-factor/enable", input);
    const totpURI = payload && typeof payload === "object" ? (payload as Record<string, unknown>).totpURI : null;
    if (typeof totpURI !== "string") throw new Error("The server did not return an authenticator setup key.");
    return { totpURI, backupCodes: toBackupCodes(payload) };
  },

  disableTwoFactor: async (input: { password: string }) => {
    await authPost("/two-factor/disable", input);
  },

  regenerateBackupCodes: async (input: { password: string }): Promise<string[]> =>
    toBackupCodes(await authPost("/two-factor/generate-backup-codes", input)),

  listPasskeys: async (): Promise<AuthPasskey[]> => {
    const payload = await authGet("/passkey/list-user-passkeys");
    if (!Array.isArray(payload)) return [];
    return payload.map(toPasskey).filter((passkey): passkey is AuthPasskey => passkey !== null);
  },

  addPasskey: async (input: { name: string }) => {
    const optionsJSON = await authGet("/passkey/generate-register-options");
    const { startRegistration } = await import("@simplewebauthn/browser");
    const response = await startRegistration({
      optionsJSON: optionsJSON as PublicKeyCredentialCreationOptionsJSON,
    });
    await authPost("/passkey/verify-registration", { response, name: input.name });
  },

  deletePasskey: async (id: string) => {
    await authPost("/passkey/delete-passkey", { id });
  },

  signUpEmail: async (input: { name: string; email: string; password: string }) => {
    await authPost("/sign-up/email", input);
  },

  getProfile: async (): Promise<CurrentUserProfile> => {
    const res = await fetch("/api/auth/profile", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const recovery = tenantSessionRecovery.recoverIfNeeded(res.status, payload);
      if (recovery) return recovery;
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
