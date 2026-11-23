import {
  NativeProviderStateIncompatibleError,
  QUALIFIED_ACPX_PROFILES,
  type NativeExecutionInput,
} from "../../vendor/paperclip-runner/index.js";
import { resolveAntigravityCandidateAdmission } from "./acpx-qualification.js";

/**
 * Google Antigravity's server gates while its Runner profile is pending, and
 * the general qualified ACPX path after the release flip. Every gate reads the
 * release declaration at call time, the way Kimi's do, never the agent name
 * alone, so the flip needs no change here.
 */
export function antigravityReleasePending(): boolean {
  return QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus === "pending";
}

export function isAntigravityProvider(
  provider: NativeExecutionInput["provider"] | undefined,
): provider is Extract<NativeExecutionInput["provider"], { kind: "acpx" }> {
  return provider?.kind === "acpx" && provider.agent === "antigravity";
}

/** Only the pending candidate owns a fresh daemon and state root per run. A
 * qualified release keeps the ordinary per-session scope (company, agent,
 * workspace and task session), so subtasks still never share a root. */
export function antigravityUsesRunScopedState(execution: NativeExecutionInput): boolean {
  return isAntigravityProvider(execution.provider) && antigravityReleasePending();
}

/** The candidate keeps its saved conversation to the same session. A qualified
 * release uses the ordinary recovery policy, including the automatic
 * replacement conversation after a failed resume. */
export function antigravityForcesSameSessionRecovery(provider: NativeExecutionInput["provider"] | undefined): boolean {
  return isAntigravityProvider(provider) && antigravityReleasePending();
}

export const ANTIGRAVITY_EARLIER_RELEASE_STATE_REASON =
  "Google Antigravity session state was saved by an earlier release";

// The persisted profile snapshot carries no qualification status. The flip
// bumps agentProfileVersion, so candidate-era state differs here by version.
const RELEASE_IDENTITY_FIELDS = [
  "agentProfileVersion", "commandDigest", "acpxVersion", "agentServerPackage", "agentServerVersion",
  "agentRuntimePackage", "agentRuntimeVersion",
] as const;

/**
 * Saved Antigravity state binds the release profile it was created under. State
 * from another release (the pending candidate's per-run root and grant under
 * its profile version, or any older profile) is refused permanently and by
 * name. The run keeps its saved session and workspace, and the next run starts
 * a replacement conversation in the same workspace instead of repeating it.
 */
export function assertAntigravitySavedStateCurrent(execution: NativeExecutionInput): void {
  if (!isAntigravityProvider(execution.provider)) return;
  const saved = (execution.provider as { profile?: Record<string, unknown> }).profile ?? {};
  const current = QUALIFIED_ACPX_PROFILES.antigravity as unknown as Record<string, unknown>;
  if (RELEASE_IDENTITY_FIELDS.some(field => saved[field] !== current[field])) {
    throw new NativeProviderStateIncompatibleError(ANTIGRAVITY_EARLIER_RELEASE_STATE_REASON);
  }
}

/**
 * Executor admission. While pending, only an exact local per-turn candidate
 * grant may run. After the flip no grant is needed and Antigravity takes the
 * same path as Kimi and Copilot; only state saved by another release is refused.
 */
export function assertAntigravityExecutionAdmissible(input: {
  execution: NativeExecutionInput;
  useRunnerd?: boolean;
  backend?: unknown;
  restartRecovery?: unknown;
  remoteTarget: boolean;
  hostEnvironment?: NodeJS.ProcessEnv;
}): void {
  const { execution } = input;
  if (!isAntigravityProvider(execution.provider)) return;
  if (!antigravityReleasePending()) {
    assertAntigravitySavedStateCurrent(execution);
    return;
  }
  const candidate = resolveAntigravityCandidateAdmission({
    companyId: execution.binding.companyId, model: execution.provider.model,
  }, input.hostEnvironment ?? process.env);
  if (!candidate || !input.useRunnerd || input.backend || input.restartRecovery || input.remoteTarget
    || execution.session.lifecyclePolicy.mode !== "per_turn"
    || ("homeMode" in execution && execution.homeMode === "preconfigured")) {
    throw new Error("paperclip_runner_antigravity_candidate_ineligible: exact local per-turn candidate admission is required");
  }
}
