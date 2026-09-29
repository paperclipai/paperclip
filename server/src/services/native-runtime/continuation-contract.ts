import type { NativeRestartRecoveryClaim } from "./native-restart-recovery.js";
import { and, eq, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  type Db,
} from "@paperclipai/db";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

/** Revise an uncompleted contract at a fenced dispatch boundary; retain its old revision for audit. */
export async function rebindContinuationContract(
  db: Db,
  expected: NativeExecutionInput,
  next: NativeExecutionInput,
  recoveryClaim?: NativeRestartRecoveryClaim,
) {
  const binding = expected.binding;
  if (JSON.stringify(binding) !== JSON.stringify(next.binding))
    throw new Error("continuation_contract_binding_changed");
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
    );
    const [task] = await tx
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, binding.companyId),
          eq(issues.id, binding.issueId),
        ),
      )
      .for("update");
    const [coordinator] = await tx
      .select()
      .from(nativeRunFinalizations)
      .where(
        and(
          eq(nativeRunFinalizations.companyId, binding.companyId),
          eq(nativeRunFinalizations.runId, binding.runId),
        ),
      )
      .for("update");
    const [run] = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, binding.companyId),
          eq(heartbeatRuns.id, binding.runId),
        ),
      )
      .for("update");
    if (
      !task ||
      task.assigneeAgentId !== binding.agentId ||
      !["in_progress", "in_review"].includes(task.status) ||
      (task.executionRunId && task.executionRunId !== binding.runId) ||
      (task.checkoutRunId && task.checkoutRunId !== binding.runId) ||
      !run ||
      run.agentId !== binding.agentId ||
      run.nativeIssueId !== binding.issueId ||
      run.status !== "running"
    ) {
      throw new Error("continuation_contract_ownership_changed");
    }
    if (
      run.completionContractId === next.completionContract.id &&
      run.completionContractSha256 === next.completionContract.sha256
    )
      return;
    const [result] = await tx
      .select({ id: nativeRunResults.id })
      .from(nativeRunResults)
      .where(
        and(
          eq(nativeRunResults.companyId, binding.companyId),
          eq(nativeRunResults.runId, binding.runId),
        ),
      )
      .limit(1);
    const ownsFencedRecovery = recoveryClaim
      && recoveryClaim.kind !== "reattach_existing_runner"
      && recoveryClaim.runId === binding.runId
      && coordinator?.leaseOwner === recoveryClaim.leaseOwner
      && coordinator.controllerGeneration === recoveryClaim.controllerGeneration
      && coordinator.phase === "observed"
      && ["resuming_session", "bootstrap_incomplete"].includes(coordinator.recoveryState ?? "");
    if ((coordinator?.leaseOwner && !ownsFencedRecovery) || coordinator?.resultId || result)
      throw new Error("continuation_contract_requires_fenced_uncompleted_run");
    if (
      run.completionContractId !== expected.completionContract.id ||
      run.completionContractSha256 !== expected.completionContract.sha256
    ) {
      throw new Error("continuation_contract_revision_changed");
    }
    await tx
      .update(heartbeatRuns)
      .set({
        completionContractId: next.completionContract.id,
        completionContractSha256: next.completionContract.sha256,
        runnerProfileJson: {
          ...run.runnerProfileJson,
          nativeExecutionInput: next,
        },
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, binding.runId));
  });
}
