import { and, eq, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { captureLegacyDurablePrpCheckpoint, inspectUnclaimedBootstrapCheckpoint, parseNativeExecutionInput,
  type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import { loadNativeUnclaimedBootstrapCheckpoint } from "./native-runner-checkpoint.js";
import { isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";
import { isUnusedNativeSessionBootstrap, nativeSessionProviderEvidence } from "./native-session-resume.js";
import { readNativeSessionResumptionAgent } from "./native-session-resumption-admission.js";

export async function admitUnclaimedNativeBootstrapRetry(input: {
  db: Db;
  execution: NativeExecutionInput;
  leaseOwner: string;
  localStateContents: string;
  preparedExecutionAdmission?: { admissionSha256: string; preparedSha256: string };
}): Promise<boolean> {
  const { binding } = input.execution;
  return input.db.transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`);
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).for("update");
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, binding.runId), eq(nativeRunFinalizations.companyId, binding.companyId),
      eq(nativeRunFinalizations.issueId, binding.issueId), eq(nativeRunFinalizations.leaseOwner, input.leaseOwner),
      eq(nativeRunFinalizations.phase, "observed"), isNull(nativeRunFinalizations.resultId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId))).for("update");
    if (!issue || !coordinator || !run || coordinator.attempt < 1 || coordinator.attempt >= 3
      || !coordinator.leaseExpiresAt || coordinator.leaseExpiresAt.getTime() <= Date.now()
      || run.runtimeMode !== "native" || run.status !== "running" || run.finishedAt !== null
      || !run.runnerInstanceId || !run.nativeSessionId || run.nativeSessionId !== input.execution.session.normalizedSessionId
      || isNativeRunnerOwnershipHeld(run) || run.resultJson?.nativeCancellation != null
      || run.resultJson?.startupCancellation != null
      || !isUnusedNativeSessionBootstrap(run, (await nativeSessionProviderEvidence(tx, [run.id])).has(run.id))) return false;
    if (!await readNativeSessionResumptionAgent(tx as unknown as Db, { issue, run, coordinator })) return false;
    let admitted: NativeExecutionInput;
    try { admitted = parseNativeExecutionInput(run.runnerProfileJson?.nativeExecutionInput); }
    catch { return false; }
    const executionSha256 = nativeSha256(input.execution);
    if (nativeSha256(admitted) !== (input.preparedExecutionAdmission?.admissionSha256 ?? executionSha256)
      || input.preparedExecutionAdmission && executionSha256 !== input.preparedExecutionAdmission.preparedSha256) return false;
    const identity = { runnerInstanceId: run.runnerInstanceId, environmentLeaseId: binding.executionWorkspaceId,
      runId: binding.runId, normalizedSessionId: run.nativeSessionId, turnId: `turn-${binding.runId}`, itemId: `item-${binding.runId}` };
    const canonical = await loadNativeUnclaimedBootstrapCheckpoint(tx, binding, identity);
    if (!canonical) return false;
    try {
      const local = captureLegacyDurablePrpCheckpoint(input.localStateContents, identity,
        { version: canonical.runnerVersion, digest: canonical.runnerDigest });
      return inspectUnclaimedBootstrapCheckpoint(local.records, identity)?.fingerprint === canonical.fingerprint;
    } catch { return false; }
  });
}
