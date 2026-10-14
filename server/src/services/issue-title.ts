import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { setIssueTitleSchema, type SetIssueTitle } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { persistActivity, type ActivityPublication, type LogActivityInput } from "./activity-log.js";
import { issueReferenceService } from "./issue-references.js";

type TitleActor = Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId" | "agentApiKeyId">;
type TitleResult = { id: string; title: string; titleNeedsGeneration: boolean; changed: boolean };
type TitleReceipt = { issueId: string; title: string; onlyIfProvisional: boolean; result: TitleResult };

const MAX_TASK_TITLE_RECEIPTS_PER_RUN = 64;

/** Caller owns the transaction and publishes the activity only after commit. */
export async function setIssueTitle(
  tx: Db,
  companyId: string,
  issueId: string,
  input: SetIssueTitle,
  actor: TitleActor,
): Promise<{ result: TitleResult; publication: ActivityPublication | null }> {
  const { title, onlyIfProvisional, idempotencyKey } = setIssueTitleSchema.parse(input);
  const predicate = and(eq(issues.id, issueId), eq(issues.companyId, companyId));
  const [issue] = await tx.select().from(issues).where(predicate).for("update");
  if (!issue) throw notFound("Task not found");
  let authorizedRun: typeof heartbeatRuns.$inferSelect | undefined;
  if (actor.actorType === "agent") {
    if (issue.assigneeAgentId !== actor.actorId || !actor.runId) {
      throw forbidden("Setting a task title requires its assigned agent's active run");
    }
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, actor.actorId),
    )).for("update");
    const snapshot = run?.contextSnapshot ?? {};
    if (!run || run.status !== "running"
      || (run.nativeIssueId ?? snapshot.issueId ?? snapshot.taskId) !== issueId
      || (issue.executionRunId && issue.executionRunId !== run.id)
      || (issue.checkoutRunId && issue.checkoutRunId !== run.id)
      || (issue.conversationAgentId && Number(snapshot.conversationSessionGeneration ?? 0) !== issue.conversationSessionGeneration)) {
      throw forbidden("The active run no longer owns this task");
    }
    authorizedRun = run;
  }
  if (idempotencyKey && !authorizedRun) throw badRequest("Title retry keys require an authenticated agent run");
  const receipts = (authorizedRun?.resultJson?.taskTitleReceipts ?? {}) as Record<string, TitleReceipt>;
  const receiptKey = idempotencyKey ? `title:${idempotencyKey}` : null;
  const prior = receiptKey ? receipts[receiptKey] : undefined;
  if (prior) {
    if (prior.issueId !== issueId || prior.title !== title || prior.onlyIfProvisional !== onlyIfProvisional) {
      throw conflict("Task title idempotency key was already used with different arguments");
    }
    return { result: prior.result, publication: null };
  }
  // Keep all accepted keys replayable, including after a user edit. Reject new
  // keys at the limit instead of evicting receipts and allowing writes to replay.
  if (receiptKey && Object.keys(receipts).length >= MAX_TASK_TITLE_RECEIPTS_PER_RUN) {
    throw conflict("Task title retry-key limit reached for this run");
  }
  const saveReceipt = async (result: TitleResult) => {
    if (receiptKey && authorizedRun) {
      await tx.update(heartbeatRuns).set({
        resultJson: { ...authorizedRun.resultJson, taskTitleReceipts: { ...receipts, [receiptKey]: { issueId, title, onlyIfProvisional, result } } },
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, authorizedRun.id));
    }
    return result;
  };
  if ((onlyIfProvisional && !issue.titleNeedsGeneration)
    || (issue.title === title && !issue.titleNeedsGeneration)) {
    return { result: await saveReceipt({ id: issue.id, title: issue.title, titleNeedsGeneration: issue.titleNeedsGeneration, changed: false }), publication: null };
  }
  await tx.update(issues).set({ title, titleNeedsGeneration: false, updatedAt: new Date() }).where(predicate);
  await issueReferenceService(tx).syncIssue(issueId, tx);
  const { publication } = await persistActivity(tx, {
    ...actor, companyId, action: "issue.updated", entityType: "issue", entityId: issueId,
    details: { title, previous: { title: issue.title }, titleNeedsGeneration: false },
  });
  return { result: await saveReceipt({ id: issueId, title, titleNeedsGeneration: false, changed: true }), publication };
}
