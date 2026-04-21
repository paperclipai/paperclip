import {
  authSessionSchema,
  currentUserProfileSchema,
  type AuthSession,
  type CurrentUserProfile,
  type UpdateCurrentUserProfile,
} from "@paperclipai/shared";

type AuthErrorBody =
  | {
    code?: string;
    message?: string;
    error?: string | { code?: string; message?: string };
  }
  | null;

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

async function authPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/auth${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return payload;
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

  signInEmail: async (input: { email: string; password: string }): Promise<{ twoFactorRequired: boolean }> => {
    const payload = await authPost("/sign-in/email", input);
    const data = (payload as { data?: { twoFactorRedirect?: boolean } } | null)?.data ?? payload;
    const twoFactorRequired = Boolean((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect);
    return { twoFactorRequired };
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
      throw new Error((payload as { error?: string } | null)?.error ?? `Failed to load profile (${res.status})`);
    }
    return currentUserProfileSchema.parse(payload);
  },

  updateProfile: async (input: UpdateCurrentUserProfile): Promise<CurrentUserProfile> =>
    authPatch("/profile", input, (payload) => currentUserProfileSchema.parse(payload)),

  signOut: async () => {
    await authPost("/sign-out", {});
  },

  twoFactor: {
    enable: async (input: { password: string }): Promise<{ totpURI: string; backupCodes: string[] }> => {
      const payload = await authPost("/two-factor/enable", input);
      const data = (payload as { data?: { totpURI?: string; backupCodes?: string[] } } | null)?.data ?? payload;
      const totpURI = (data as { totpURI?: string } | null)?.totpURI;
      const backupCodes = (data as { backupCodes?: string[] } | null)?.backupCodes;
      if (typeof totpURI !== "string" || !Array.isArray(backupCodes)) {
        throw new Error("Unexpected response from /two-factor/enable");
      }
      return { totpURI, backupCodes };
    },

    disable: async (input: { password: string }): Promise<void> => {
      await authPost("/two-factor/disable", input);
    },

    verifyTotp: async (input: { code: string; trustDevice?: boolean }): Promise<void> => {
      await authPost("/two-factor/verify-totp", input);
    },

    verifyBackupCode: async (input: { code: string; trustDevice?: boolean }): Promise<void> => {
      await authPost("/two-factor/verify-backup-code", input);
    },

    generateBackupCodes: async (input: { password: string }): Promise<{ backupCodes: string[] }> => {
      const payload = await authPost("/two-factor/generate-backup-codes", input);
      const data = (payload as { data?: { backupCodes?: string[] } } | null)?.data ?? payload;
      const backupCodes = (data as { backupCodes?: string[] } | null)?.backupCodes;
      if (!Array.isArray(backupCodes)) {
        throw new Error("Unexpected response from /two-factor/generate-backup-codes");
      }
      return { backupCodes };
    },

    getTotpUri: async (input: { password: string }): Promise<{ totpURI: string }> => {
      const payload = await authPost("/two-factor/get-totp-uri", input);
      const data = (payload as { data?: { totpURI?: string } } | null)?.data ?? payload;
      const totpURI = (data as { totpURI?: string } | null)?.totpURI;
      if (typeof totpURI !== "string") {
        throw new Error("Unexpected response from /two-factor/get-totp-uri");
      }
      return { totpURI };
    },
  },
};
