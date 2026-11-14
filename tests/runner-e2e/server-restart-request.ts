import { isRollingWebDeployment } from "./controller-rolling-deployment.js";
import { readFile } from "node:fs/promises";
import { runnerMatrix } from "./catalog.js";
import { parseAcpxCandidateAdmission, type AcpxCandidateAdmission } from "../../packages/paperclip-runner/src/drivers/acpx/candidate-admission.js";
import { QUALIFIED_ACPX_PROFILES } from "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { KIMI_DISTRIBUTION_CLOSURE_SHA256 } from "../../packages/paperclip-runner/src/drivers/acpx/kimi-closure-pins.js";
import type { MatrixExecution } from "./types.js";
import { controllerOutageForExecution, parseControllerOutage, type ControllerOutage } from "./controller-outage.js";
import { parseRecoveryBinding, type RecoveryBinding } from "./controller-recovery-observer.js";
import { parseFinalizationCrashBinding, type FinalizationCrashBinding } from "./finalization-crash-boundary.js";
import { parseRestartRunnerIdentity, type RestartRunnerIdentity } from "./process-tree-owner.js";

export interface RestartRequest {
  requestId: string;
  kimiCandidateAdmission?: AcpxCandidateAdmission;
  controllerDowntimeMs?: number;
  preserveRunner?: RestartRunnerIdentity;
  discardControllerCache?: boolean;
  crashAfterResult?: FinalizationCrashBinding;
  controllerOutage?: ControllerOutage;
  rollingDeployment?: true;
  recoveryBinding?: RecoveryBinding;
}

export function kimiCandidateAdmissionForExecution(execution: MatrixExecution, companyId: string, now = Date.now()): AcpxCandidateAdmission | undefined {
  if (execution.suite.id !== "kimi-qualification" || execution.profile.qualificationCandidate !== "kimi"
    || QUALIFIED_ACPX_PROFILES.kimi.qualificationStatus !== "pending") return undefined;
  if (!execution.suite.manualOnly || execution.profile.id !== "runner-acpx-kimi" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(companyId)) {
    throw new Error("Kimi qualification requires an exact disposable company and manual profile");
  }
  const target = execution.environment.expectedExecutionTarget.kind === "remote" ? "linux-x64" : `${process.platform}-${process.arch}`;
  if (target !== "darwin-arm64" && target !== "linux-x64") throw new Error("Kimi fixture host is unsupported");
  const [platform, architecture] = target.split("-");
  return parseAcpxCandidateAdmission({ schema: "paperclip.acpx-candidate-admission.v1", companyId, agent: "kimi",
    model: execution.profile.model, profileDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest,
    nativeClosureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256[target]}`, platform, architecture,
    expiresAt: now + 60 * 60 * 1000 }, { companyId, agent: "kimi", model: execution.profile.model }, now);
}

function selectedKimiCandidateAdmission(value: unknown, executionIds: readonly string[]): AcpxCandidateAdmission {
  const executions = executionIds.map(id => runnerMatrix.find(row => row.id === id));
  if (!executions.length || executions.some(row => !row || row.suite.id !== "kimi-qualification"
    || !row.suite.manualOnly || row.profile.id !== "runner-acpx-kimi" || row.profile.qualificationCandidate !== "kimi")) {
    throw new Error("Kimi authority staging requires an explicit Kimi qualification selection");
  }
  const record = value as Partial<AcpxCandidateAdmission> | null;
  if (!record || typeof record.companyId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.companyId)) throw new Error("Invalid Kimi fixture company");
  const admission = parseAcpxCandidateAdmission(value, { companyId: record.companyId, agent: "kimi", model: executions[0]!.profile.model });
  if (!executions.some(row => row!.environment.expectedExecutionTarget.kind === "remote"
    ? admission.platform === "linux" && admission.architecture === "x64"
    : admission.platform === process.platform && admission.architecture === process.arch)) throw new Error("Kimi fixture target does not match the selected execution");
  return admission;
}

export async function readRestartRequest(restartRequestPath: string, executionIds: readonly string[]): Promise<RestartRequest | null> {
  let encoded: string;
  try {
    encoded = await readFile(restartRequestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    // The writer may not have completed its atomic replacement yet.
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const requestId = (value as { requestId?: unknown }).requestId;
  if (
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)
  ) {
    return null;
  }
  const kimiAuthority = (value as { kimiCandidateAdmission?: unknown }).kimiCandidateAdmission;
  const kimiCandidateAdmission = kimiAuthority === undefined ? undefined : selectedKimiCandidateAdmission(kimiAuthority, executionIds);
  if (kimiCandidateAdmission && Object.keys(value).some(key => !["requestId", "kimiCandidateAdmission", "discardControllerCache"].includes(key))) {
    throw new Error("Kimi startup authority staging cannot combine another restart operation");
  }
  if (kimiCandidateAdmission && (value as { discardControllerCache?: unknown }).discardControllerCache === true) {
    throw new Error("Kimi startup authority staging cannot replace controller state");
  }
  const preserveRunner = (value as { preserveRunner?: unknown }).preserveRunner;
  const controllerDowntimeMs = (value as { controllerDowntimeMs?: unknown }).controllerDowntimeMs;
  if (controllerDowntimeMs !== undefined && (!Number.isSafeInteger(controllerDowntimeMs)
    || Number(controllerDowntimeMs) < 0 || Number(controllerDowntimeMs) > 300_000)) {
    throw new Error("Controller downtime must be an integer between zero and five minutes");
  }
  const rollingDeployment = (value as { rollingDeployment?: unknown }).rollingDeployment;
  if (rollingDeployment !== undefined && (rollingDeployment !== true || executionIds.length !== 1
    || !executionIds.every(id => { const execution = runnerMatrix.find(row => row.id === id); return execution && isRollingWebDeployment(execution); }))) {
    throw new Error("Rolling deployment requires its explicit isolated cell");
  }
  const discardControllerCache = (value as { discardControllerCache?: unknown }).discardControllerCache === true;
  if (discardControllerCache && !executionIds.some(id => {
    const execution = runnerMatrix.find(row => row.id === id);
    return execution !== undefined && (controllerOutageForExecution(execution, {}) !== undefined || isRollingWebDeployment(execution));
  })) throw new Error("Controller cache replacement requires an explicit remote controller-outage cell");
  const crashAfterResult = (value as { crashAfterResult?: unknown }).crashAfterResult;
  const controllerOutage = (value as { controllerOutage?: unknown }).controllerOutage;
  const recoveryBinding = (value as { recoveryBinding?: unknown }).recoveryBinding;
  if (recoveryBinding !== undefined && controllerOutage === undefined && !rollingDeployment) throw new Error("Recovery observation requires a controller outage");
  if (rollingDeployment && (!discardControllerCache || controllerOutage !== undefined || controllerDowntimeMs !== undefined
    || preserveRunner !== undefined || crashAfterResult !== undefined)) throw new Error("Rolling deployment cannot combine an outage or another fault");
  if (controllerOutage !== undefined && (!discardControllerCache || preserveRunner !== undefined || crashAfterResult !== undefined)) {
    throw new Error("Controller outage requires the explicit remote cache-replacement cell without another crash boundary");
  }
  if (crashAfterResult !== undefined && (preserveRunner !== undefined || discardControllerCache)) {
    throw new Error("A finalization crash cannot preserve a running provider or discard its controller cache");
  }
  return { requestId, discardControllerCache, ...(rollingDeployment ? { rollingDeployment: true as const } : {}), ...(kimiCandidateAdmission ? { kimiCandidateAdmission } : {}), ...(controllerDowntimeMs === undefined ? {} : { controllerDowntimeMs: Number(controllerDowntimeMs) }),
    ...(recoveryBinding === undefined ? {} : { recoveryBinding: parseRecoveryBinding(recoveryBinding) }),
    ...(controllerOutage === undefined ? {} : { controllerOutage: parseControllerOutage(controllerOutage) }),
    ...(preserveRunner === undefined ? {} : { preserveRunner: parseRestartRunnerIdentity(preserveRunner) }),
    ...(crashAfterResult === undefined ? {} : { crashAfterResult: parseFinalizationCrashBinding(crashAfterResult) }) };

}
