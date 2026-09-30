import type { MatrixExecution } from "./types.js";

/** Explicit-only profiles blocked until complete identity/auth/session/billing qualification. */
export const PENDING_PROFILE_PREREQUISITES = {
  "legacy-kimi-cli": "Kimi CLI identity/auth/skills/session/billing qualification is pending",
  "legacy-kimi-acp": "Kimi ACP identity/auth/skills/session/billing qualification is pending",
  "legacy-grok": "Grok identity/auth/skills/session/billing qualification is pending",
} as const;

/** Pi is intentionally absent: no qualified model source exists for a valid profile. */
export const UNQUALIFIED_PROFILE_GAPS = {
  pi: "Pi has no qualified model source, so no valid Product E2E profile is registered.",
} as const;

/** Reject missing remote observer authority before creating a company or run. */
export function assertRemoteNativeEvidencePrerequisites(
  executions: readonly MatrixExecution[],
  environment: NodeJS.ProcessEnv,
): void {
  if (!executions.some(execution => execution.environment.id === "daytona"
    && ["cursor_native", "pi_native", "copilot_protection"].includes(execution.task.flow))) return;
  const names = ["PAPERCLIP_E2E_DAYTONA_NODE_SHA256", "PAPERCLIP_E2E_DAYTONA_RUNNERD_SHA256"];
  const invalid = names.filter(name => !/^sha256:[a-f0-9]{64}$/u.test(environment[name] ?? ""));
  if (invalid.length) throw new Error(`Native Daytona evidence requires exact image executable digests: ${invalid.join(", ")}`);
}

export function assertRunnerE2EPrerequisites(
  executions: readonly MatrixExecution[],
): void {
  const blocked = [...new Set(
    executions
      .map((execution) => execution.profile.id)
      .filter((profileId): profileId is keyof typeof PENDING_PROFILE_PREREQUISITES =>
        profileId in PENDING_PROFILE_PREREQUISITES,
      ),
  )];
  if (blocked.length === 0) return;
  throw new Error(
    `Selected runner E2E profile prerequisite(s) are pending: ${blocked
      .map((profileId) => `${profileId} (${PENDING_PROFILE_PREREQUISITES[profileId]})`)
      .join("; ")}. No provider credentials were loaded or sent.`,
  );
}
