import { verifyCursorInstallation } from "./cursor-installation.js";
import { assertCursorWorkspacePolicy } from "./cursor-launch-policy.js";
import type { QualifiedAcpxAgent, QualifiedAcpxProfile } from "./qualified-profiles.js";
import { verifyQualifiedAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";

/** Closed build-owned registry. Provider branches add their pinned installations here. */
export async function verifyAcpxProfileInstallation(profile: QualifiedAcpxProfile): Promise<VerifiedAcpxInstallation> {
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

/** Candidate branches validate only explicitly bound, sanitized launch credentials. */
export function assertAcpxProfileEnvironment(_agent: QualifiedAcpxAgent, _environment: Readonly<NodeJS.ProcessEnv>): void {}

/** Optional provider-specific classification; never changes whether admission succeeded. */
export function classifyAcpxProfileError(_agent: QualifiedAcpxAgent, _error: unknown): Error | null {
  return null;
}
