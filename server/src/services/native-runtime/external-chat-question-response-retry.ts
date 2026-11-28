import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { INTERACTION_CONTINUATION_INFRA_RETRY_REASON } from "../../modules/run-dispatch/index.js";
import { executionFailureRetryCount } from "../execution-recovery-attempt.js";
import { REVIEWED_CHAT_BINDING_NOT_READY } from "../reviewed-chat-binding-diagnostics.js";
import { nativeSha256 } from "./canonical.js";

export const EXTERNAL_CHAT_ANSWER_ADMISSION_KEYS = [
  "source", "issueId", "interactionId", "interactionKind", "interactionStatus",
  "sourceRunId", "sourceCommentId", "externalChatContinuation",
  "wakeCommentId", "wakeCommentIds", "commentId",
] as const;

type Run = typeof heartbeatRuns.$inferSelect;
type LockMode = "blocking" | "nonblocking" | "read";
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function resolveQuestionResponseRetryAdmission(
  tx: Db,
  run: Run,
  lockMode: LockMode,
): Promise<Run | null> {
  const seen = new Set<string>();
  let current = run;
  while (current.retryOfRunId) {
    const context = record(current.contextSnapshot);
    if (seen.size >= 2 || seen.has(current.id) || current.scopeKind !== "issue" || current.issueId !== context.issueId ||
        current.issueId !== run.issueId || current.scheduledRetryReason !== INTERACTION_CONTINUATION_INFRA_RETRY_REASON ||
        context.retryOfRunId !== current.retryOfRunId || context.retryReason !== INTERACTION_CONTINUATION_INFRA_RETRY_REASON ||
        context.wakeReason !== INTERACTION_CONTINUATION_INFRA_RETRY_REASON ||
        context.scheduledRetryAttempt !== current.scheduledRetryAttempt ||
        current.scheduledRetryAttempt === null || current.scheduledRetryAttempt < 1 || current.scheduledRetryAttempt > 2) return null;
    seen.add(current.id);
    const query = tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, current.retryOfRunId),
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId)));
    const [parent] = await (lockMode === "read" ? query : lockMode === "nonblocking"
      ? query.for("update", { noWait: true }) : query.for("update"));
    if (!parent || seen.has(parent.id)) return null;
    const parentContext = record(parent.contextSnapshot);
    const recovery = record(record(parent.resultJson).executionRecovery);
    if (parent.scopeKind !== "issue" || parent.issueId !== run.issueId || parent.status !== "failed" || !parent.finishedAt ||
        parent.errorCode !== REVIEWED_CHAT_BINDING_NOT_READY || parent.runtimeMode !== "legacy" ||
        parent.nativeIssueId !== null || parent.nativeSessionId !== null || parent.runnerInstanceId !== null ||
        parent.processPid !== null || parent.processGroupId !== null || parent.externalRunId !== null ||
        recovery.kind !== "bootstrap" || recovery.providerWorkStarted !== false ||
        executionFailureRetryCount(parent) + 1 !== current.scheduledRetryAttempt ||
        EXTERNAL_CHAT_ANSWER_ADMISSION_KEYS.some(key => nativeSha256(parentContext[key] ?? null) !== nativeSha256(context[key] ?? null))) return null;
    current = parent;
  }
  return record(current.contextSnapshot).wakeReason === "issue_commented" ? current : null;
}
