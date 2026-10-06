import { AI_PROVIDERS, AI_CONNECTION_CAPABILITIES, isAiConnectionCompatible, type AiConnectionBinding, type AiProvider } from "@paperclipai/shared";

type AuthenticationFailure = {
  errorCode?: string | null;
  resultJson?: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** A personal model credential gap is repairable without changing other secrets. */
function missingPersonalAiCredentialProvider(run: AuthenticationFailure): AiProvider | undefined {
  if (run.errorCode !== "configuration_incomplete") return undefined;
  const gap = record(record(run.resultJson)?.configurationIncomplete);
  if (gap?.reason !== "secret_binding_missing" || !Array.isArray(gap.missingBindings) || !gap.missingBindings.length) return undefined;
  const missingBindings = gap.missingBindings;
  return AI_PROVIDERS.find(provider => {
    const keys = new Set(Object.values(AI_CONNECTION_CAPABILITIES[provider].methods).map(method => method.envKey));
    return missingBindings.every((value: unknown) => {
      const binding = record(value);
      return binding?.bindingType === "user_secret_ref"
        && ["user_secret_missing", "secret_inactive"].includes(String(binding.errorCode))
        && typeof binding.envKey === "string" && keys.has(binding.envKey)
        && binding.configPath === `env.${binding.envKey}`;
    });
  });
}

export function isAiConnectionConfigurationFailure(run: AuthenticationFailure): boolean {
  return run.errorCode === "configuration_incomplete" && (
    record(record(run.resultJson)?.configurationIncomplete)?.reason === "ai_connection_unavailable"
    || Boolean(missingPersonalAiCredentialProvider(run))
  );
}

export function isAiAuthenticationRepairable(run: AuthenticationFailure): boolean {
  return isAiAuthenticationFailure(run.errorCode) || isAiConnectionConfigurationFailure(run);
}

/** Provider authentication signals only. Tool authorization and quotas need different repairs. */
export function isAiAuthenticationFailure(code: string | null | undefined): boolean {
  return Boolean(code && (
    /^(acpx|claude|codex|grok|opencode|gemini|kimi|pi|cursor)_auth_required$/.test(code)
    || ["adapter_auth_missing", "authentication_required", "auth_required", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"].includes(code)
  ));
}

/** Only a persisted blocked classification confirms that an inline repair owns recovery. */
export function isAiAuthenticationBlocked(run: (AuthenticationFailure & { livenessState?: string | null }) | null | undefined): boolean {
  return run?.livenessState === "blocked" && isAiAuthenticationRepairable(run);
}

export function aiBindingForAuthRecovery(
  adapterType: string,
  config: Record<string, unknown>,
  failure?: AuthenticationFailure,
): AiConnectionBinding | undefined {
  const missingProvider = failure ? missingPersonalAiCredentialProvider(failure) : undefined;
  for (const provider of AI_PROVIDERS) {
    if (missingProvider && missingProvider !== provider) continue;
    const binding = { provider, method: AI_CONNECTION_CAPABILITIES[provider].methods.subscription ? "subscription" : "api_key", mode: "responsible_user" } as const;
    if (isAiConnectionCompatible(binding, adapterType, config.model, config.provider, config.acpxAgent)) return binding;
  }
  return undefined;
}
