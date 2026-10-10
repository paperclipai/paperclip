import { executionWorkspaces, issues, type Db } from "@paperclipai/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { accessService } from "./access.js";
import { executionWorkspaceReadSqlCondition, type AuthorizationActor } from "./authorization.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type WorkspaceAccessContext = { write?: boolean; issueId?: string | null; parentIssueId?: string | null; assigneeAgentId?: string | null; assigneeUserId?: string | null };

/** Filesystem source scope is independent of a task's organizational project. */
export async function assertTaskWorkspaceSourceProjectAccess(
  db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, projectId: string | null, options: WorkspaceAccessContext = {},
) {
  if (!projectId) return;
  const decision = await accessService(db as Db).decide({
    actor, action: "project:read", resource: { type: "project", companyId, projectId },
  });
  if (!decision.allowed) throw forbidden(decision.explanation);
  if (options.write) {
    // Sharing a configured root gives the task write access to project files.
    // Use the same project-scoped authority as assigning work to that project.
    const [task] = actor.type === "board" && options.issueId
      ? await db.select({ assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId }).from(issues)
        .where(and(eq(issues.id, options.issueId), eq(issues.companyId, companyId)))
      : [];
    const assigneeAgentId = actor.type === "agent" ? actor.agentId ?? null : task?.assigneeAgentId ?? options.assigneeAgentId ?? null;
    const assigneeUserId = actor.type === "agent" ? null : task?.assigneeUserId ?? options.assigneeUserId ?? null;
    const assignment = await accessService(db as Db).decide({
      actor, action: "tasks:assign",
      resource: { type: "issue", companyId, projectId, assigneeAgentId, assigneeUserId,
        issueId: options.issueId, parentIssueId: options.parentIssueId },
      // Lineage proves low-trust containment; grants must still cover the source
      // project independently of the task's organizational project.
      scope: { projectId, assigneeAgentId, assigneeUserId },
    });
    if (!assignment.allowed) throw forbidden(assignment.explanation);
  }
}

/** Retained files keep every task's authorization boundary after rebinding. */
export async function assertTaskWorkspaceAccess(
  db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, workspaceId: string, options: WorkspaceAccessContext = {},
) {
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, companyId),
    await executionWorkspaceReadSqlCondition(db, actor),
  ));
  if (!workspace) throw forbidden("Task workspace access is no longer available");
  await assertTaskWorkspaceSourceProjectAccess(db, actor, companyId, workspace.projectId, { ...options, write: options.write && workspace.strategyType !== "git_worktree" });
  const retainedIssueIds = Object.keys(workspace.metadata?._issuePrivacySources ?? {});
  if (workspace.sourceIssueId) retainedIssueIds.push(workspace.sourceIssueId);
  const sources = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, companyId),
    or(eq(issues.executionWorkspaceId, workspaceId), retainedIssueIds.length > 0
      ? inArray(sql<string>`${issues.id}::text`, retainedIssueIds) : undefined),
  ));
  const sourceIds = new Set(sources.map(source => source.id));
  if (retainedIssueIds.some(id => !sourceIds.has(id))) throw forbidden("Task workspace source is no longer accessible");
  const access = accessService(db as Db);
  if (sources.length === 0 && !workspace.projectId) {
    const decision = await access.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } });
    if (!decision.allowed) throw forbidden("An unscoped workspace is outside this actor's authorization boundary");
  }
  for (const source of sources) {
    const decision = await access.decide({ actor, action: "issue:read", resource: { type: "issue", companyId, issueId: source.id } });
    if (!decision.allowed) throw forbidden("Task workspace retains files outside this actor's authorization boundary");
  }
}
