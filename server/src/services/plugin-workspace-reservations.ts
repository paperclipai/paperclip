import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { workspaceProviderOperationSchema } from "@paperclipai/plugin-sdk";
import { logger } from "../middleware/logger.js";
import { notifyTerminalWorkspaceWork } from "./terminal-workspace-work.js";

type Workspace = typeof executionWorkspaces.$inferSelect;

export async function retireAbandonedPluginWorkspaceReservation(db: Db, workspace: Workspace): Promise<Workspace | null> {
  if (!workspace.sourceIssueId) return null;
  const previous = typeof workspace.metadata?.lifecycleGeneration === "number" ? workspace.metadata.lifecycleGeneration : 0;
  const generation = previous + 1;
  const operation = workspaceProviderOperationSchema.parse({ kind: "remove", binding: null, expectedHeadSha: null });
  const operationId = createHash("sha256").update(JSON.stringify([workspace.id, generation, operation])).digest("hex");
  const abandoned = and(
    eq(executionWorkspaces.id, workspace.id),
    eq(executionWorkspaces.companyId, workspace.companyId),
    isNull(executionWorkspaces.providerRef),
    sql`coalesce((${executionWorkspaces.metadata}->>'lifecycleGeneration')::int, 0) = ${previous}`,
    sql`EXISTS (SELECT 1 FROM ${issues} WHERE ${issues.companyId} = ${workspace.companyId}
      AND ${issues.id} = ${workspace.sourceIssueId} AND ${issues.status} IN ('done', 'cancelled'))`,
    sql`NOT EXISTS (SELECT 1 FROM ${issues} WHERE ${issues.companyId} = ${workspace.companyId}
      AND ${issues.executionWorkspaceId} = ${workspace.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${heartbeatRuns} WHERE ${heartbeatRuns.companyId} = ${workspace.companyId}
      AND ${heartbeatRuns.issueId} = ${workspace.sourceIssueId} AND ${heartbeatRuns.status} IN ('queued', 'running'))`,
  );
  const [candidate] = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(abandoned);
  if (!candidate) return null;
  const closedAt = new Date();
  return db.transaction(async (tx) => {
    await notifyTerminalWorkspaceWork(tx, `workspace:${workspace.id}`);
    const [retired] = await tx.update(executionWorkspaces).set({
      status: "archived",
      closedAt: workspace.closedAt ?? closedAt,
      cleanupEligibleAt: workspace.cleanupEligibleAt ?? closedAt,
      cleanupReason: "issue_terminal",
      updatedAt: closedAt,
      metadata: { ...workspace.metadata, lifecycleGeneration: generation, workspaceProviderRemoval: { generation, operation, operationId } },
    }).where(abandoned).returning();
    if (!retired) return null;
    logger.info({ event: "execution_workspace.reservation_retired", executionWorkspaceId: workspace.id, sourceIssueId: workspace.sourceIssueId },
      "Unused workspace storage reservation is being removed");
    return retired;
  });
}
