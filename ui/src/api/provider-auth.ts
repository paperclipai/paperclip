export type ProviderAuthStatus = "idle" | "starting" | "waiting" | "complete" | "failed" | "canceled";

export type AnthropicAuthState = {
  apiProvider: string | null;
  authDetected: boolean;
  authMethod: string | null;
  codeRequired: boolean;
  completedAt: string | null;
  createdAt: string | null;
  email: string | null;
  error: string | null;
  organizationId: string | null;
  organizationName: string | null;
  sessionId: string | null;
  status: ProviderAuthStatus;
  subscriptionType: string | null;
  updatedAt: string | null;
  verificationUrl: string | null;
};

export type OpenAiAuthState = {
  authDetected: boolean;
  completedAt: string | null;
  createdAt: string | null;
  error: string | null;
  expiresAt: string | null;
  sessionId: string | null;
  status: ProviderAuthStatus;
  updatedAt: string | null;
  userCode: string | null;
  verificationUrl: string | null;
};

async function authGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api/provider-auth${path}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (payload as { error?: string } | null)?.error ?? `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

async function authPost<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/provider-auth${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (payload as { error?: string } | null)?.error ?? `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export const providerAuthApi = {
  getStatus: () =>
    authGet<{ anthropic: AnthropicAuthState; openai: OpenAiAuthState }>("/status"),

  // Anthropic (Claude Code)
  getAnthropic: () => authGet<AnthropicAuthState>("/anthropic"),
  startAnthropic: () => authPost<AnthropicAuthState>("/anthropic/start"),
  submitAnthropicCode: (code: string) => authPost<AnthropicAuthState>("/anthropic/submit", { code }),
  cancelAnthropic: () => authPost<AnthropicAuthState>("/anthropic/cancel"),

  // OpenAI (Codex)
  getOpenAi: () => authGet<OpenAiAuthState>("/openai"),
  startOpenAi: () => authPost<OpenAiAuthState>("/openai/start"),
  cancelOpenAi: () => authPost<OpenAiAuthState>("/openai/cancel"),
};
