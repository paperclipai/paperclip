import type { PaperclipRunnerProviderProfile } from "./provider-profile.js";

type WarmProviderSelection = { backend: PaperclipRunnerProviderProfile["backend"]; acpxAgent?: unknown };

/** Providers with a session-owned home and the current instruction-grant handoff. */
export function supportsNativeWarmFiles(profile: WarmProviderSelection): boolean {
  return profile.backend === "codex_app_server" ||
    (profile.backend === "acpx_runtime" && profile.acpxAgent === "copilot");
}

/** Copilot carries a token in its fenced session environment, not a temporary auth file.
 * Credential generation changes still retire the exact warm owner before attachment. */
export function supportsManagedNativeWarmSession(
  profile: WarmProviderSelection,
  attribution: { provider: string; method: string } | undefined,
): boolean {
  return profile.backend === "codex_app_server" ||
    (profile.backend === "acpx_runtime" && profile.acpxAgent === "copilot" &&
      attribution?.provider === "github" && attribution.method === "api_key");
}
