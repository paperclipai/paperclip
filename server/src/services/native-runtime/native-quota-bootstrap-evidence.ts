import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { AiConnectionRouterSelection } from "@paperclipai/shared";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Locks and checks only the predecessor's bootstrap evidence. This is not an
 * admission decision: the caller must, in this same transaction, establish
 * session and action safety, current authority, pool/pin CAS, and successor
 * ownership. The locks last only until the caller's transaction completes.
 */
export async function lockNativeQuotaBootstrapEvidence(tx: Transaction, input: {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  expectedSelection: AiConnectionRouterSelection;
}) {
  const [issue] = await tx.select().from(issues).where(and(
    eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
  )).for("update");
  const [run] = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.agentId, input.agentId),
  )).for("update");
  if (!issue || !run || issue.assigneeAgentId !== input.agentId ||
      !["todo", "in_progress", "in_review"].includes(issue.status) ||
      (issue.executionRunId !== null && issue.executionRunId !== run.id) ||
      (issue.checkoutRunId !== null && issue.checkoutRunId !== run.id) ||
      run.runtimeMode !== "native" || run.status !== "failed" || !run.finishedAt ||
      run.scopeKind !== "issue" || run.issueId !== issue.id || run.nativeIssueId !== issue.id ||
      run.nativeSessionId || run.runnerInstanceId || run.processPid || run.processGroupId ||
      run.sessionIdBefore || run.sessionIdAfter) return null;
  const result = run.resultJson ?? {};
  const recovery = result.executionRecovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery) ||
      (recovery as Record<string, unknown>).kind !== "bootstrap" ||
      (recovery as Record<string, unknown>).providerWorkStarted !== false ||
      (run.errorCode !== "provider_quota" && result.errorFamily !== "provider_quota") ||
      result.startupCancellation != null || result.nativeCancellation != null ||
      result.executionCancellation != null ||
      run.contextSnapshot?.aiRouterTaskKey !== issue.id ||
      !isDeepStrictEqual(run.contextSnapshot?.aiRouterSelection, input.expectedSelection)) return null;
  // Any environment may retain resources or provider ownership. Bootstrap
  // evidence alone cannot prove its cleanup, so this restricted path waits.
  const [lease] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  )).limit(1);
  if (lease) return null;
  const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.retryOfRunId, run.id),
  )).limit(1);
  if (successor) return null;
  return { runId: run.id, issueId: issue.id, companyId: run.companyId, agentId: run.agentId };
}
