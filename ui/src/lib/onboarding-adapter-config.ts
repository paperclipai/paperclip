// Pure adapter-config builder for onboarding, extracted verbatim from
// OnboardingWizard.buildAdapterConfig so the new onboarding flow and the
// useOnboardingFlow hook can build an agent adapter config from user inputs
// without duplicating the branch logic.
import { getUIAdapter } from "@/adapters";
import { defaultCreateValues } from "@/components/agent-config-defaults";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";

export interface OnboardingAdapterConfigInput {
  adapterType: string;
  model: string;
  command: string;
  args: string;
  url: string;
  /**
   * When true and the adapter is claude_local, force ANTHROPIC_API_KEY to an
   * empty plain value so a subscription login is used instead of a stray env
   * key that overrides it.
   */
  forceUnsetAnthropicApiKey: boolean;
}

export function buildOnboardingAdapterConfig(
  input: OnboardingAdapterConfigInput,
): Record<string, unknown> {
  const { adapterType, model, command, args, url, forceUnsetAnthropicApiKey } = input;
  const adapter = getUIAdapter(adapterType);
  const config = adapter.buildAdapterConfig({
    ...defaultCreateValues,
    adapterType,
    model:
      adapterType === "gemini_local"
        ? model || DEFAULT_GEMINI_LOCAL_MODEL
        : adapterType === "cursor"
          ? model || DEFAULT_CURSOR_LOCAL_MODEL
          : adapterType === "opencode_local"
            ? model || DEFAULT_OPENCODE_LOCAL_MODEL
            : model,
    command,
    args,
    url,
    dangerouslySkipPermissions:
      adapterType === "claude_local" || adapterType === "opencode_local",
    dangerouslyBypassSandbox:
      adapterType === "codex_local"
        ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
        : defaultCreateValues.dangerouslyBypassSandbox,
  });
  if (adapterType === "claude_local" && forceUnsetAnthropicApiKey) {
    const env =
      typeof config.env === "object" &&
      config.env !== null &&
      !Array.isArray(config.env)
        ? { ...(config.env as Record<string, unknown>) }
        : {};
    env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
    config.env = env;
  }
  return config;
}
