import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX, DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { getUIAdapter } from "../adapters";
import { defaultCreateValues } from "../components/agent-config-defaults";

type OnboardingAdapterType =
  | "claude_local"
  | "codex_local"
  | "gemini_local"
  | "hermes_local"
  | "opencode_local"
  | "pi_local"
  | "cursor"
  | "http"
  | "openclaw_gateway";

export function buildOnboardingAdapterConfig(input: {
  adapterType: OnboardingAdapterType;
  model: string;
  command: string;
  extraArgs: string;
  url: string;
  dangerouslySkipPermissions: boolean;
  forceUnsetAnthropicApiKey?: boolean;
}) {
  const adapter = getUIAdapter(input.adapterType);
  const config = adapter.buildAdapterConfig({
    ...defaultCreateValues,
    adapterType: input.adapterType,
    model:
      input.adapterType === "codex_local"
        ? input.model || DEFAULT_CODEX_LOCAL_MODEL
        : input.adapterType === "gemini_local"
          ? input.model || DEFAULT_GEMINI_LOCAL_MODEL
          : input.adapterType === "cursor"
            ? input.model || DEFAULT_CURSOR_LOCAL_MODEL
            : input.model,
    command: input.command,
    extraArgs: input.extraArgs,
    url: input.url,
    dangerouslySkipPermissions:
      input.adapterType === "claude_local" || input.adapterType === "opencode_local"
        ? input.dangerouslySkipPermissions
        : defaultCreateValues.dangerouslySkipPermissions,
    dangerouslyBypassSandbox:
      input.adapterType === "codex_local"
        ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
        : defaultCreateValues.dangerouslyBypassSandbox,
  });

  if (input.adapterType === "claude_local" && input.forceUnsetAnthropicApiKey) {
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
