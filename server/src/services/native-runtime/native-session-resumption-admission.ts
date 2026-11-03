import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { issueService } from "../issues.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "../recovery/pause-hold-guard.js";
import { readRunCancellation } from "../run-cancellation.js";
import { getNativeReviewAssignment } from "./native-review-participant.js";

export async function readNativeSessionResumptionAgent(db: Db, input: {
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "status" | "executionRunId" | "checkoutRunId" | "assigneeAgentId">;
  run: typeof heartbeatRuns.$inferSelect;
  coordinator: typeof nativeRunFinalizations.$inferSelect;
}) {
  const { issue, run, coordinator } = input;
  if (issue.companyId !== run.companyId || issue.id !== run.nativeIssueId ||
      coordinator.companyId !== run.companyId || coordinator.issueId !== issue.id || coordinator.runId !== run.id ||
      !["todo", "in_progress", "in_review"].includes(issue.status) ||
      (issue.executionRunId && issue.executionRunId !== run.id) ||
      (issue.checkoutRunId && issue.checkoutRunId !== run.id)) return null;
  const [agent] = await db.select().from(agents).where(and(
    eq(agents.companyId, run.companyId), eq(agents.id, run.agentId),
  )).limit(1);
  if (!agent || !(await evaluateAgentInvokabilityFromDb(db, agent)).invokable) return null;
  if (issue.assigneeAgentId !== run.agentId && !await getNativeReviewAssignment(db, {
    companyId: run.companyId, issueId: issue.id, agentId: run.agentId, contextSnapshot: run.contextSnapshot,
  })) return null;
  if (await isAutomaticRecoverySuppressedByPauseHold(db, run.companyId, issue.id)) return null;
  if (!(await issueService(db).getDependencyReadiness(issue.id, db)).isDependencyReady) return null;
  const [competing] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), ne(heartbeatRuns.id, run.id),
    inArray(heartbeatRuns.status, issue.executionRunId === run.id
      ? ["running", "scheduled_retry"] : ["queued", "running", "scheduled_retry"]),
    or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
  )).limit(1);
  if (competing) return null;
  const cancellation = readRunCancellation(run.resultJson);
  const nativeCancellation = run.resultJson?.nativeCancellation as { scope?: unknown; dispatchState?: unknown } | undefined;
  if ((cancellation?.source === "operator" && cancellation.expected) ||
      (["run", "issue"].includes(String(nativeCancellation?.scope)) &&
        ["pending", "acknowledged"].includes(String(nativeCancellation?.dispatchState))) ||
      typeof coordinator.failureDetail?.successorRunId === "string") return null;
  return agent;
}
