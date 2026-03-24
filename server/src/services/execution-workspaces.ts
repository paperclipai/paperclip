import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai_dld/db";
import { executionWorkspaces } from "@paperclipai_dld/db";
import type { ExecutionWorkspace } from "@paperclipai_dld/shared";

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;

function toExecutionWorkspace(row: ExecutionWorkspaceRow): ExecutionWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    sourceIssueId: row.sourceIssueId ?? null,
    mode: row.mode as ExecutionWorkspace["mode"],
    strategyType: row.strategyType as ExecutionWorkspace["strategyType"],
    name: row.name,
    status: row.status as ExecutionWorkspace["status"],
    cwd: row.cwd ?? null,
    repoUrl: row.repoUrl ?? null,
    baseRef: row.baseRef ?? null,
    branchName: row.branchName ?? null,
    providerType: row.providerType as ExecutionWorkspace["providerType"],
    providerRef: row.providerRef ?? null,
    derivedFromExecutionWorkspaceId: row.derivedFromExecutionWorkspaceId ?? null,
    lastUsedAt: row.lastUsedAt,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? null,
    cleanupEligibleAt: row.cleanupEligibleAt ?? null,
    cleanupReason: row.cleanupReason ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function executionWorkspaceService(db: Db) {
  return {
    list: async (companyId: string, filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    }) => {
      const conditions = [eq(executionWorkspaces.companyId, companyId)];
      if (filters?.projectId) conditions.push(eq(executionWorkspaces.projectId, filters.projectId));
      if (filters?.projectWorkspaceId) {
        conditions.push(eq(executionWorkspaces.projectWorkspaceId, filters.projectWorkspaceId));
      }
      if (filters?.issueId) conditions.push(eq(executionWorkspaces.sourceIssueId, filters.issueId));
      if (filters?.status) {
        const statuses = filters.status.split(",").map((value) => value.trim()).filter(Boolean);
        if (statuses.length === 1) conditions.push(eq(executionWorkspaces.status, statuses[0]!));
        else if (statuses.length > 1) conditions.push(inArray(executionWorkspaces.status, statuses));
      }
      if (filters?.reuseEligible) {
        conditions.push(inArray(executionWorkspaces.status, ["active", "idle", "in_review"]));
      }

      const rows = await db
        .select()
        .from(executionWorkspaces)
        .where(and(...conditions))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt));
      return rows.map(toExecutionWorkspace);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspace(row) : null;
    },

    create: async (data: typeof executionWorkspaces.$inferInsert) => {
      const row = await db
        .insert(executionWorkspaces)
        .values(data)
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspace(row) : null;
    },

    update: async (id: string, patch: Partial<typeof executionWorkspaces.$inferInsert>) => {
      const row = await db
        .update(executionWorkspaces)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(executionWorkspaces.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspace(row) : null;
    },
  };
}

export { toExecutionWorkspace };
