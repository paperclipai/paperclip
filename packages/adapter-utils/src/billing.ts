function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function inferOpenAiCompatibleBiller(
  env: NodeJS.ProcessEnv,
  fallback: string | null = "openai",
): string | null {
  const explicitOpenRouterKey = readEnv(env, "OPENROUTER_API_KEY");
  if (explicitOpenRouterKey) return "openrouter";

  const baseUrl =
    readEnv(env, "OPENAI_BASE_URL") ??
    readEnv(env, "OPENAI_API_BASE") ??
    readEnv(env, "OPENAI_API_BASE_URL");
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol === "https:" && url.hostname === "openrouter.ai") return "openrouter";
      // An OpenAI-compatible endpoint does not imply OpenAI prices. Do not
      // assign direct-provider estimates to a proxy or an unknown endpoint.
      if (url.protocol !== "https:" || url.hostname !== "api.openai.com") return "unknown";
    } catch {
      return "unknown";
    }
  }

  return fallback;
}

/** Managed Responses routes use their own credentials and prices, including
 * no-auth endpoints. Absence of OPENAI_API_KEY never makes them ChatGPT plans. */
export function resolveManagedOpenAiBilling(routing: unknown) {
  if (!routing || typeof routing !== "object") return undefined;
  return {
    provider: "openai",
    biller: (routing as { kind?: unknown }).kind === "openrouter" ? "openrouter" : "unknown",
    billingType: "api" as const,
  };
}
