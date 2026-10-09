import { verifyCursorInstallation } from "./cursor-installation.js";
import { assertCursorWorkspacePolicy } from "./cursor-launch-policy.js";
import { resolveQualifiedAcpxProfile, type QualifiedAcpxAgent, type QualifiedAcpxProfile } from "./qualified-profiles.js";
import { verifyQualifiedAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";
import { verifyHermesInstallation } from "./hermes-installation.js";

/** Closed build-owned registry. Provider branches add their pinned installations here. */
export async function verifyAcpxProfileInstallation(profile: QualifiedAcpxProfile): Promise<VerifiedAcpxInstallation> {
  if (profile.agent === "cursor") {
    try { return await verifyCursorInstallation(profile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error("Cursor runtime assets are missing. Run paperclipai runtime setup cursor on this execution host."), { code: "CURSOR_RUNTIME_MISSING", retryable: false });
      throw error;
    }
  }
  if (profile.agent === "hermes") return verifyHermesInstallation(profile);
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
  if (agent === "cursor" && !environment.CURSOR_API_KEY?.trim() && !environment.CURSOR_AUTH_TOKEN?.trim()) {
    throw Object.assign(new Error("Cursor credentials are missing. Bind a company secret to CURSOR_API_KEY or CURSOR_AUTH_TOKEN in the agent environment."), { code: "CURSOR_CREDENTIALS_MISSING", retryable: false });
  }
}

/** Provider admission diagnostics expose no raw provider strings or credentials. */
export function classifyAcpxProfileError(agent: QualifiedAcpxAgent, error: unknown): Error | null {
  if (agent !== "cursor" || !(error instanceof Error)) return null;
  const message = error.message;
  let code: string;
  let detail: string;
  if (/usage limit|quota exceeded|insufficient credits|entitlement|subscription required|upgrade (?:your|the) plan/i.test(message)) {
    code = "CURSOR_ENTITLEMENT_UNAVAILABLE";
    detail = "Cursor declined access because of account entitlement or quota. Check the subscription, selected model access, and account spending cap.";
  } else if (/invalid (?:api key|auth(?:entication)? token)|authentication failed|unauthenticated|unauthorized|not authenticated/i.test(message)) {
    code = "CURSOR_AUTHENTICATION_FAILED";
    detail = "Cursor rejected the bound credential. Update the company secret used by CURSOR_API_KEY or CURSOR_AUTH_TOKEN.";
  } else if (/(?:model.*(?:not found|unavailable|unsupported|not available|not allowed)|(?:unknown|invalid) model|effective model mismatch)/i.test(message)) {
    code = "CURSOR_MODEL_UNAVAILABLE";
    detail = "Cursor could not use the explicitly selected model. Verify its exact identifier and account access, then select a supported model explicitly.";
  } else return null;
  return Object.assign(new Error(detail), { code, retryable: false });
}

/** Probe trusted installed bytes without credentials or a billable prompt. */
export async function probeAcpxCursorInstallation(model: string): Promise<void> {
  const installation = await verifyAcpxProfileInstallation(resolveQualifiedAcpxProfile("cursor", model));
  await (await installation.openCommand()).close();
}
