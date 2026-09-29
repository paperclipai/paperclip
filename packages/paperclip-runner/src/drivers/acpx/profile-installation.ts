import { verifyPiInstallation } from "./pi-installation.js";
import { assertCopilotCredentials, classifyCopilotFailure } from "./copilot-profile.js";
import { verifyCopilotInstallation } from "./copilot-installation.js";
import { verifyCursorInstallation } from "./cursor-installation.js";
import { assertCursorWorkspacePolicy } from "./cursor-launch-policy.js";
import type { QualifiedAcpxAgent, QualifiedAcpxProfile } from "./qualified-profiles.js";
import { verifyQualifiedAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";

/** Closed build-owned registry. Provider branches add their pinned installations here. */
export async function verifyAcpxProfileInstallation(profile: QualifiedAcpxProfile): Promise<VerifiedAcpxInstallation> {
  if (profile.agent === "pi") return verifyPiInstallation(profile);
  if (profile.agent === "copilot") return verifyCopilotInstallation(profile);
  if (profile.agent === "cursor") return verifyCursorInstallation(profile);
  if (profile.agent !== "claude" && profile.agent !== "codex" && profile.agent !== "grok") {
    throw new Error(`ACPX ${profile.agent} verified candidate distribution is not installed in this build`);
  }
  return verifyQualifiedAcpxInstallation(profile);
}

/** Provider policy admission is repeated immediately before each process launch. */
export async function assertAcpxProfileWorkspace(agent: QualifiedAcpxAgent, workspace: string): Promise<void> {
  if (agent === "cursor") await assertCursorWorkspacePolicy(workspace);
}

/** Called with the sanitized launch environment, never ambient process.env. */
export function assertAcpxProfileEnvironment(agent: QualifiedAcpxAgent, environment: Readonly<NodeJS.ProcessEnv>): void {
  if (agent === "copilot") assertCopilotCredentials(environment);
}

/** Provider admission diagnostics expose no raw provider strings or credentials. */
export function classifyAcpxProfileError(agent: QualifiedAcpxAgent, error: unknown): Error | null {
  if (agent !== "copilot") return null;
  const failure = classifyCopilotFailure(error);
  if (failure.code === "COPILOT_REQUEST_FAILED") return null;
  return Object.assign(new Error(failure.message), { code: failure.code, retryable: false });
}
