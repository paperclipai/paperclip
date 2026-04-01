export type AuthSession = {
  session: { id: string; userId: string };
  user: { id: string; email: string | null; name: string | null };
};

export type SignInResult = {
  twoFactorRedirect?: boolean;
};

export type TwoFactorEnableResult = {
  totpURI: string;
  backupCodes: string[];
};

function toSession(value: unknown): AuthSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const sessionValue = record.session;
  const userValue = record.user;
  if (!sessionValue || typeof sessionValue !== "object") return null;
  if (!userValue || typeof userValue !== "object") return null;
  const session = sessionValue as Record<string, unknown>;
  const user = userValue as Record<string, unknown>;
  if (typeof session.id !== "string" || typeof session.userId !== "string") return null;
  if (typeof user.id !== "string") return null;
  return {
    session: { id: session.id, userId: session.userId },
    user: {
      id: user.id,
      email: typeof user.email === "string" ? user.email : null,
      name: typeof user.name === "string" ? user.name : null,
    },
  };
}

async function authPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (payload as { error?: { message?: string } | string } | null)?.error &&
      typeof (payload as { error?: { message?: string } | string }).error === "object"
        ? ((payload as { error?: { message?: string } }).error?.message ?? `Request failed: ${res.status}`)
        : (payload as { error?: string } | null)?.error ?? `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
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

  signInEmail: async (input: { email: string; password: string }): Promise<SignInResult> => {
    const result = await authPost<Record<string, unknown>>("/sign-in/email", input);
    if (result && typeof result === "object" && "twoFactorRedirect" in result && result.twoFactorRedirect === true) {
      return { twoFactorRedirect: true };
    }
    return {};
  },

  signUpEmail: async (input: { name: string; email: string; password: string }) => {
    await authPost("/sign-up/email", input);
  },

  signOut: async () => {
    await authPost("/sign-out", {});
  },

  // Two-factor authentication methods
  twoFactor: {
    enable: async (input: { password: string }): Promise<TwoFactorEnableResult> => {
      return await authPost<TwoFactorEnableResult>("/two-factor/enable", {
        password: input.password,
        issuer: "Paperclip",
      });
    },

    disable: async (input: { password: string }): Promise<void> => {
      await authPost("/two-factor/disable", { password: input.password });
    },

    verifyTotp: async (input: { code: string }): Promise<void> => {
      await authPost("/two-factor/verify-totp", { code: input.code });
    },

    getTotpUri: async (input: { password: string }): Promise<{ totpURI: string }> => {
      return await authPost<{ totpURI: string }>("/two-factor/get-totp-uri", {
        password: input.password,
      });
    },

    verifyBackupCode: async (input: { code: string }): Promise<void> => {
      await authPost("/two-factor/verify-backup-code", { code: input.code });
    },

    generateBackupCodes: async (input: { password: string }): Promise<{ backupCodes: string[] }> => {
      return await authPost<{ backupCodes: string[] }>("/two-factor/generate-backup-codes", {
        password: input.password,
      });
    },
  },
};
