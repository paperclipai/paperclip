import { and, eq } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { parseNativeExecutionInput, type DurableRecoveryIdentity, type NativeExecutionInput, type PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { createNativeUsageContinuationDelivery } from "./native-usage-delivery.js";

const identityKeys = ["runId", "runnerInstanceId", "environmentLeaseId", "normalizedSessionId", "turnId", "itemId"] as const;

/** A cold handoff may discover accounting that belongs to its completed source.
 * Hydrate that producer once; never route its receipts through the new run. */
export function createNativeRecoveryUsageDelivery(input: {
  db: Db;
  execution: NativeExecutionInput;
  sourceIdentity: Record<string, unknown>;
  matchesExecution(previous: NativeExecutionInput): boolean;
}) {
  let delivery: ReturnType<typeof createNativeUsageContinuationDelivery> | undefined;
  const deny = (): never => { throw new Error("native_recovery_usage_source_unproven"); };
  const open = async (source: DurableRecoveryIdentity) => {
    const { binding } = input.execution;
    const [prior] = await input.db.select({ run: heartbeatRuns, owner: nativeRunFinalizations })
      .from(heartbeatRuns).innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
      .where(and(eq(heartbeatRuns.id, source.runId), eq(heartbeatRuns.companyId, binding.companyId),
        eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId)));
    if (!prior || prior.run.status !== "succeeded" || prior.run.finishedAt === null ||
        prior.run.runtimeMode !== "native" || prior.run.runnerInstanceId !== source.runnerInstanceId ||
        prior.run.nativeSessionId !== source.normalizedSessionId || prior.owner.phase !== "committed" ||
        !prior.owner.resultId || prior.owner.leaseOwner || prior.owner.companyId !== binding.companyId ||
        prior.owner.issueId !== binding.issueId) return deny();
    const previous = parseNativeExecutionInput(prior.run.runnerProfileJson?.nativeExecutionInput);
    if (previous.binding.companyId !== binding.companyId || previous.binding.agentId !== binding.agentId ||
        previous.binding.issueId !== binding.issueId || previous.binding.runId !== source.runId ||
        !input.matchesExecution(previous)) return deny();
    return createNativeUsageContinuationDelivery(input.db, {
      companyId: binding.companyId, runId: source.runId,
      runnerInstanceId: source.runnerInstanceId, provider: previous.provider,
    });
  };
  return async (event: PrpEvent, source: DurableRecoveryIdentity) => {
    if (source.runId === input.execution.binding.runId ||
        identityKeys.some(key => typeof input.sourceIdentity[key] !== "string" ||
          !input.sourceIdentity[key] || source[key] !== input.sourceIdentity[key]) ||
        event.runId !== source.runId || event.sourceInstanceId !== source.runnerInstanceId ||
        event.normalizedSessionId !== source.normalizedSessionId) return deny();
    delivery ??= open(source);
    await (await delivery).capture(event);
  };
}
