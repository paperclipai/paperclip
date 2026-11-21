import { resolvePaperclipRunnerProviderProfile, type PaperclipRunnerProviderProfile } from "./provider-profile.js";

type WarmProviderSelection = { backend: PaperclipRunnerProviderProfile["backend"]; acpxAgent?: unknown };

/**
 * The harness an agent config selects, resolved exactly as the runtime resolves
 * it (an omitted provider is Codex; ACPX without an agent is Claude). Null when
 * the runtime would refuse the config.
 */
export function resolveWarmProviderSelection(adapterConfig: unknown, companyId?: string): WarmProviderSelection | null {
  try {
    const profile = resolvePaperclipRunnerProviderProfile(adapterConfig, { companyId });
    return { backend: profile.backend, acpxAgent: profile.provider === "acpx" ? profile.acpxAgent : undefined };
  } catch {
    return null;
  }
}

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

/**
 * Harnesses measured to start a follow-up turn faster on a live runner
 * (doc/plans/2026-11-07-warm-follow-up-ttft.md, doc/plans/2026-11-08-large-workspace-speed.md).
 * Locally, ACPX harnesses (Claude) relaunch their provider process on every
 * follow-up turn, so warm does not shorten their follow-up. On a remote sandbox
 * the dominant cost is a new sandbox and a full workspace upload, so Claude
 * gains from warm there too.
 */
export function defaultsToWarmFollowUp(profile: WarmProviderSelection, target: "local" | "remote_sandbox"): boolean {
  if (profile.backend === "codex_app_server" || profile.backend === "opencode_server") return true;
  return target === "remote_sandbox" && profile.backend === "acpx_runtime" && profile.acpxAgent === "claude";
}

/**
 * The one rule for the remote-sandbox warm default. The run-scoped environment
 * view (lease retention) and the native session policy (runner retention) both
 * call it, and apply it only when no lifecycle was chosen anywhere (admitted
 * session, environment, agent). It holds only when the sandbox provider keeps
 * reusable leases, so a default never turns a run that works per-turn into a
 * refused warm run, and only when a selected managed AI account supports a
 * warm session.
 */
export function defaultsRemoteSandboxRunToWarm(input: {
  profile: WarmProviderSelection;
  reusableLeaseSupported: boolean;
  managedAi: { attribution?: { provider: string; method: string } } | null;
}): boolean {
  return input.reusableLeaseSupported
    && defaultsToWarmFollowUp(input.profile, "remote_sandbox")
    && (input.managedAi === null || supportsManagedNativeWarmSession(input.profile, input.managedAi.attribution));
}
