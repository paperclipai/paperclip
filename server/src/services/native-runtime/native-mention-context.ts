import { and, eq, isNull } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { extractAgentMentionIds } from "@paperclipai/shared";
import { authorizationService } from "../authorization.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

type Binding = { companyId: string; issueId: string; agentId: string; runId: string };

/** Only heartbeat preparation writes this admission; a wake snapshot alone grants nothing. */
export function isNativeMentionContextRun(run: Pick<typeof heartbeatRuns.$inferSelect,
  "runnerProfileJson" | "nativeIssueId" | "agentId" | "wakeupRequestId">): boolean {
  const context = record(record(run.runnerProfileJson).nativeMentionContext);
  return context.version === 1 && context.issueId === run.nativeIssueId
    && context.agentId === run.agentId && typeof run.wakeupRequestId === "string"
    && context.wakeupRequestId === run.wakeupRequestId;
}

/** Admit a comment-triggered response without acquiring the other assignee's task. */
export async function resolveNativeMentionContext(db: Db, binding: Binding, action: "issue:read" | "issue:comment" = "issue:read") {
  const [row] = await db.select({ run: heartbeatRuns, issue: issues, wake: agentWakeupRequests })
    .from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId)))
    .innerJoin(agentWakeupRequests, and(
      eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
      eq(agentWakeupRequests.companyId, binding.companyId),
      eq(agentWakeupRequests.agentId, binding.agentId),
      eq(agentWakeupRequests.runId, binding.runId),
    ))
    .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId))).limit(1);
  if (!row || row.issue.assigneeAgentId === binding.agentId || row.wake.reason !== "issue_comment_mentioned"
    || !["claimed", "completed"].includes(row.wake.status) || row.wake.payload?.issueId !== binding.issueId) return null;
  const commentId = row.wake.payload?.commentId;
  if (typeof commentId !== "string") return null;
  const [comment] = await db.select({ body: issueComments.body }).from(issueComments).where(and(
    eq(issueComments.id, commentId), eq(issueComments.companyId, binding.companyId),
    eq(issueComments.issueId, binding.issueId), isNull(issueComments.deletedAt),
  )).limit(1);
  if (!comment || !extractAgentMentionIds(comment.body).includes(binding.agentId)) return null;
  const decision = await authorizationService(db).decide({
    actor: { type: "agent", source: "agent_jwt", companyId: binding.companyId, agentId: binding.agentId,
      runId: binding.runId, onBehalfOfUserId: row.run.responsibleUserId },
    action, resource: { type: "issue", companyId: binding.companyId, issueId: binding.issueId,
      projectId: row.issue.projectId, parentIssueId: row.issue.parentId, assigneeAgentId: row.issue.assigneeAgentId,
      assigneeUserId: row.issue.assigneeUserId, status: row.issue.status },
  });
  return decision.allowed ? { version: 1, issueId: binding.issueId, agentId: binding.agentId, wakeupRequestId: row.wake.id } : null;
}

export async function hasNativeMentionContextAccess(db: Db, binding: Binding, action: "issue:read" | "issue:comment" = "issue:read"): Promise<boolean> {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId),
    eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId),
    eq(heartbeatRuns.nativeIssueId, binding.issueId), eq(heartbeatRuns.runtimeMode, "native"),
    eq(heartbeatRuns.status, "running"))).limit(1);
  return !!run && isNativeMentionContextRun(run) && !!await resolveNativeMentionContext(db, binding, action);
}
