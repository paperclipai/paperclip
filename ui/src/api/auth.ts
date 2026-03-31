export type AuthSession = {
  session: { id: string; userId: string };
  user: { id: string; email: string | null; name: string | null };
};
export type SocialAuthProvider = "google" | "microsoft";

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

async function authPost(path: string, body: Record<string, unknown>) {
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
  return payload;
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
    await authPost("/sign-in/email", input);
  },

  signUpEmail: async (input: { name: string; email: string; password: string }) => {
    await authPost("/sign-up/email", input);
  },

  signInSocial: async (input: {
    provider: SocialAuthProvider;
    callbackURL?: string;
    errorCallbackURL?: string;
    newUserCallbackURL?: string;
  }) => {
    const payload = await authPost("/sign-in/social", {
      provider: input.provider,
      callbackURL: input.callbackURL,
      errorCallbackURL: input.errorCallbackURL,
      newUserCallbackURL: input.newUserCallbackURL,
      disableRedirect: true,
    });

    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const data = record?.data && typeof record.data === "object" ? record.data as Record<string, unknown> : null;
    const redirectUrlCandidates = [
      record?.url,
      record?.redirectURL,
      record?.redirectUrl,
      data?.url,
      data?.redirectURL,
      data?.redirectUrl,
    ];
    const redirectUrl = redirectUrlCandidates.find((candidate) => typeof candidate === "string") as string | undefined;

    if (redirectUrl) {
      window.location.assign(redirectUrl);
      return;
    }

    const query = new URLSearchParams({
      provider: input.provider,
      callbackURL: input.callbackURL ?? "/",
    });
    if (input.errorCallbackURL) query.set("errorCallbackURL", input.errorCallbackURL);
    if (input.newUserCallbackURL) query.set("newUserCallbackURL", input.newUserCallbackURL);
    window.location.assign(`/api/auth/sign-in/social?${query.toString()}`);
  },

  signOut: async () => {
    await authPost("/sign-out", {});
  },
};
