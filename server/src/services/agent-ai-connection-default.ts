import {
  AI_PROVIDERS,
  aiConnectionBindingSchema,
  isAiConnectionCompatible,
  type AiConnectionBinding,
} from "@paperclipai/shared";

/** A hire inherits a connection choice, never its manager's credentials or identity. */
export function defaultAiConnectionForHire(
  adapterType: string,
  config: Record<string, unknown>,
  managerBinding: unknown,
): AiConnectionBinding | undefined {
  const compatible = (binding: AiConnectionBinding) =>
    isAiConnectionCompatible(binding, adapterType, config.model, config.provider, config.acpxAgent);
  const inherited = aiConnectionBindingSchema.safeParse(managerBinding);
  // Unmanaged parents keep their existing login and credential-reference paths.
  if (!inherited.success) return undefined;
  if (inherited.data.mode !== "delegated" && compatible(inherited.data)) {
    return inherited.data;
  }
  // The selected provider's personal default supplies the actual sign-in method
  // at run time. A provider without an account can be connected on the first task.
  for (const provider of AI_PROVIDERS) {
    const binding = { provider, method: "api_key", mode: "responsible_user" } as const;
    if (compatible(binding)) return binding;
  }
  return undefined;
}
