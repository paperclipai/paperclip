import { heartbeatRuns, issues, projectWorkspaces, type Db } from "@paperclipai/db";
import { isUuidLike, type IssueRecoveryAction, type TaskWorkspaceSelection } from "@paperclipai/shared";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { parseObject } from "../adapters/utils.js";
import { conflict } from "../errors.js";
import { RESTRICTED_WORKSPACE_SOURCE_REASON } from "./workspace-source-restriction.js";

export async function prepareRestrictedWorkspaceRetry(db: Db, issue: typeof issues.$inferSelect,
  action: IssueRecoveryAction): Promise<{ selection: TaskWorkspaceSelection | null } | null> {
  const sourceRunId = action.evidence?.latestRunId ?? action.evidence?.runId;
  if (action.ownerType !== "board" || typeof sourceRunId !== "string" || !isUuidLike(sourceRunId)) return null;
  const [run] = await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
    contextSnapshot: heartbeatRuns.contextSnapshot, resultJson: heartbeatRuns.resultJson,
    errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, sourceRunId),
  ));
  if (!run) return null;
  const result = parseObject(run.resultJson);
  const restricted = parseObject(result.configurationIncomplete).reason === RESTRICTED_WORKSPACE_SOURCE_REASON
    || (run.errorCode === "setup_failed" && run.error === "Task workspace access is no longer available");
  if (!restricted) return null;
  const context = parseObject(run.contextSnapshot);
  const execution = parseObject(result.executionRecovery);
  if (issue.status !== "blocked" || action.status !== "active" || action.ownerType !== "board"
    || !issue.assigneeAgentId || issue.assigneeAgentId !== action.returnOwnerAgentId
    || run.agentId !== issue.assigneeAgentId || run.status !== "failed"
    || context.issueId !== issue.id || (context.projectId ?? null) !== issue.projectId
    || execution.kind !== "bootstrap" || execution.providerWorkStarted !== false) {
    throw conflict("This retry no longer matches the task. Refresh and try again.");
  }
  const [latest] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId),
    or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (latest?.id !== run.id) throw conflict("A newer attempt exists. Refresh and try again.");
  if (issue.workspacePendingSelection) return { selection: null };
  const [source] = await db.select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl })
    .from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, issue.companyId),
      issue.projectWorkspaceId ? eq(projectWorkspaces.id, issue.projectWorkspaceId)
        : issue.projectId ? and(eq(projectWorkspaces.projectId, issue.projectId), eq(projectWorkspaces.isPrimary, true)) : sql`false`,
    )).limit(1);
  if (!source?.repoUrl) throw conflict("The task’s repository is unavailable. Retry after reconnecting it.");
  return { selection: { kind: "configured_source", projectWorkspaceId: source.id, mode: "managed_isolated" } };
}
