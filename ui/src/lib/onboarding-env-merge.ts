import type { EnvBinding } from "@paperclipai/shared";

/**
 * Merge user-defined env bindings on top of an adapter-built env block.
 *
 * Order:
 *   1. Start from whatever the adapter's `buildAdapterConfig` produced (or {}
 *      if the adapter didn't set env, or the value isn't an object).
 *   2. Spread `userEnv` on top — user values override adapter defaults for the
 *      same key.
 *   3. If the adapter is `claude_local` and `forceUnsetAnthropicApiKey` is true,
 *      override `ANTHROPIC_API_KEY` to an empty plain binding LAST. This
 *      preserves the existing onboarding UX where the user can opt to clear
 *      that key — even if they typed something into the env editor for it.
 *
 * Returns `undefined` when the merged result has no entries, so callers can
 * skip attaching `env: {}` to the adapter config (matches pre-existing
 * behavior in OnboardingWizard).
 */
export function mergeAdapterEnv(input: {
  adapterEnv: unknown;
  userEnv: Record<string, EnvBinding>;
  adapterType: string;
  forceUnsetAnthropicApiKey: boolean;
}): Record<string, unknown> | undefined {
  const { adapterEnv, userEnv, adapterType, forceUnsetAnthropicApiKey } = input;

  const baseEnv: Record<string, unknown> =
    adapterEnv !== null &&
    typeof adapterEnv === "object" &&
    !Array.isArray(adapterEnv)
      ? { ...(adapterEnv as Record<string, unknown>) }
      : {};

  const merged: Record<string, unknown> = { ...baseEnv, ...userEnv };

  if (adapterType === "claude_local" && forceUnsetAnthropicApiKey) {
    merged.ANTHROPIC_API_KEY = { type: "plain", value: "" };
  }

  if (Object.keys(merged).length === 0) {
    return undefined;
  }
  return merged;
}
