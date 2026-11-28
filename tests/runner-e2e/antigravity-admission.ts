import { parseAcpxCandidateAdmission, type AcpxCandidateAdmission } from "../../packages/paperclip-runner/src/drivers/acpx/candidate-admission.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "../../packages/paperclip-runner/src/drivers/acpx/generated-profiles.js";
import { QUALIFIED_ACPX_PROFILES } from "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { ANTIGRAVITY_GEMINI4_LINEUP_SUITE, ANTIGRAVITY_MODEL_LINEUP_SUITE, ANTIGRAVITY_PROFILE_ID, ANTIGRAVITY_QUALIFICATION_SUITE } from "./antigravity-qualification-cases.js";
import type { MatrixExecution } from "./types.js";

const LINEUP_SUITES = new Set([ANTIGRAVITY_MODEL_LINEUP_SUITE, ANTIGRAVITY_GEMINI4_LINEUP_SUITE]);
/** Shared suites that admit the Antigravity profile only when it is named explicitly. */
const OPT_IN_SUITES = new Set(["chat-features", "native-completion"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** The explicit manual suites that may carry an Antigravity candidate cell. */
export function isAntigravityAdmittedExecution(execution: MatrixExecution): boolean {
  if (execution.profile.qualificationCandidate !== "antigravity" || !execution.suite.manualOnly) return false;
  if (execution.suite.id === ANTIGRAVITY_QUALIFICATION_SUITE) return execution.profile.id === ANTIGRAVITY_PROFILE_ID;
  if (LINEUP_SUITES.has(execution.suite.id)) return execution.profile.id.startsWith(`${ANTIGRAVITY_PROFILE_ID}-`);
  return OPT_IN_SUITES.has(execution.suite.id) && execution.profile.id === ANTIGRAVITY_PROFILE_ID && execution.profile.explicitOnly === true;
}

/** Remote cells execute on the pinned Linux sandbox; local cells on this host. */
export function antigravityExecutionTarget(execution: MatrixExecution, host: Pick<NodeJS.Process, "platform" | "arch"> = process) {
  return execution.environment.expectedExecutionTarget.kind === "remote"
    ? { platform: "linux", architecture: "x64" } : { platform: host.platform, architecture: host.arch };
}

/**
 * A pending profile needs trusted operator authority bound to this disposable
 * company, exact model, profile digest, closure and target, expiring within an
 * hour. Once the declaration is qualified this returns undefined: the same
 * cells then prove ordinary admission without any grant.
 */
export function antigravityCandidateAdmissionForExecution(execution: MatrixExecution, companyId: string, now = Date.now(),
  host: Pick<NodeJS.Process, "platform" | "arch"> = process): AcpxCandidateAdmission | undefined {
  if (execution.profile.qualificationCandidate !== "antigravity" || QUALIFIED_ACPX_PROFILES.antigravity.qualificationStatus !== "pending") return undefined;
  if (!isAntigravityAdmittedExecution(execution) || !UUID.test(companyId)) {
    throw new Error("Antigravity qualification requires an exact disposable company and an explicit Antigravity suite");
  }
  const target = antigravityExecutionTarget(execution, host), key = `${target.platform}-${target.architecture}`;
  const pins = ANTIGRAVITY_DISTRIBUTION_PINS as Readonly<Record<string, { closureSha256: string } | undefined>>;
  const closure = pins[key]?.closureSha256;
  if (!closure) throw new Error(`Antigravity has no admitted runtime closure for ${key}; no provider credentials were sent.`);
  return parseAcpxCandidateAdmission({ schema: "paperclip.acpx-candidate-admission.v1", companyId, agent: "antigravity",
    model: execution.profile.model, profileDigest: QUALIFIED_ACPX_PROFILES.antigravity.commandDigest,
    nativeClosureDigest: `sha256:${closure}`, platform: target.platform, architecture: target.architecture,
    expiresAt: now + 60 * 60 * 1000 }, { companyId, agent: "antigravity", model: execution.profile.model }, now);
}
