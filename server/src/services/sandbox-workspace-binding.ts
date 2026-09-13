import { and, eq } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { issueExecutionWorkspaceModeForPersistedWorkspace } from "./execution-workspace-policy.js";

/** Host runtime state must survive even when user-configurable worktrees are disabled. */
export async function bindWarmSandboxWorkspace(db: Db, input: {
  companyId: string; issueId: string; runId: string; agentId: string; workspaceId: string;
}) {
  const publications: ActivityPublication[] = [];
  await db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
      eq(issues.executionRunId, input.runId),
    )).for("update");
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId),
    )).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "running"),
    )).for("update");
    if (!issue || !run || !workspace || workspace.projectId !== issue.projectId || workspace.status !== "active"
      || (workspace.sourceIssueId !== null && workspace.sourceIssueId !== issue.id)) {
      throw new Error("Warm sandbox workspace no longer belongs to this active task run");
    }
    await tx.update(issues).set({
      executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        ...(issue.executionWorkspaceSettings ?? {}),
        mode: issueExecutionWorkspaceModeForPersistedWorkspace(workspace.mode),
      },
      ...(workspace.projectWorkspaceId ? { projectWorkspaceId: workspace.projectWorkspaceId } : {}),
      updatedAt: new Date(),
    }).where(eq(issues.id, issue.id));
    await logActivity(tx as unknown as Db, {
      companyId: input.companyId, actorType: "agent", actorId: input.agentId, agentId: input.agentId,
      runId: input.runId, issueId: issue.id, action: "execution_workspace.sandbox_bound",
      entityType: "execution_workspace", entityId: workspace.id,
      details: { issueId: issue.id, reason: "warm_sandbox_reuse" },
    }, publications);
  });
  for (const publication of publications) publishActivity(publication);
}
