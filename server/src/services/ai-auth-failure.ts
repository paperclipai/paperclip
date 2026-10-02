import { AI_PROVIDERS, isAiConnectionCompatible, type AiConnectionBinding } from "@paperclipai/shared";

/** Provider authentication signals only. Tool authorization and quotas need different repairs. */
export function isAiAuthenticationFailure(code: string | null | undefined): boolean {
  return Boolean(code && (
    /^(acpx|claude|codex|grok|opencode|gemini|kimi|pi|cursor)_auth_required$/.test(code)
    || ["adapter_auth_missing", "authentication_required", "auth_required", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"].includes(code)
  ));
}

/** Only a persisted blocked classification confirms that an inline repair owns recovery. */
export function isAiAuthenticationBlocked(run: { errorCode?: string | null; livenessState?: string | null } | null | undefined): boolean {
  return run?.livenessState === "blocked" && isAiAuthenticationFailure(run.errorCode);
}

export function aiBindingForAuthRecovery(
  adapterType: string,
  config: Record<string, unknown>,
): AiConnectionBinding | undefined {
  for (const provider of AI_PROVIDERS) {
    const binding = { provider, method: provider === "openrouter" ? "api_key" : "subscription", mode: "responsible_user" } as const;
    if (isAiConnectionCompatible(binding, adapterType, config.model, config.provider, config.acpxAgent)) return binding;
  }
  return undefined;
}
