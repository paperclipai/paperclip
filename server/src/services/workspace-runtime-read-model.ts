import type { Db } from "@paperclipai/db";
import { workspaceRuntimeServices } from "@paperclipai/db";
import {
  listWorkspaceServiceCommandDefinitions,
  matchWorkspaceRuntimeServiceToCommand,
} from "@paperclipai/shared";
import { and, desc, eq, inArray } from "drizzle-orm";

type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;
type RuntimeServiceReadDb = Pick<Db, "select">;

function runtimeServiceIdentityKey(row: WorkspaceRuntimeServiceRow) {
  if (row.reuseKey) return row.reuseKey;
  return [
    row.scopeType,
    row.scopeId ?? "",
    row.projectWorkspaceId ?? "",
    row.executionWorkspaceId ?? "",
    row.serviceName,
    row.command ?? "",
    row.cwd ?? "",
  ].join(":");
}

export function selectCurrentRuntimeServiceRows(rows: WorkspaceRuntimeServiceRow[]) {
  const current = new Map<string, WorkspaceRuntimeServiceRow>();
  for (const row of rows) {
    const identity = runtimeServiceIdentityKey(row);
    if (!current.has(identity)) current.set(identity, row);
  }
  return [...current.values()];
}

export function selectConfiguredRuntimeServiceRows(
  rows: WorkspaceRuntimeServiceRow[],
  workspaceRuntime: Record<string, unknown> | null | undefined,
) {
  const availableRows = selectCurrentRuntimeServiceRows(rows).map((row) => ({
    ...row,
    configIndex: null as number | null,
  }));
  const selectedRows: Array<WorkspaceRuntimeServiceRow & { configIndex: number | null }> = [];

  for (const command of listWorkspaceServiceCommandDefinitions(workspaceRuntime)) {
    const reuseScope = command.rawConfig.reuseScope;
    const expectedScope =
      reuseScope === "project_workspace" ||
      reuseScope === "execution_workspace" ||
      reuseScope === "agent" ||
      reuseScope === "run"
        ? reuseScope
        : command.lifecycle === "shared"
          ? "project_workspace"
          : "run";
    const matchedRow = matchWorkspaceRuntimeServiceToCommand(
      command,
      availableRows.filter((row) => row.scopeType === expectedScope),
    );
    if (!matchedRow) continue;
    selectedRows.push({
      ...matchedRow,
      configIndex: command.serviceIndex,
    });
    availableRows.splice(availableRows.indexOf(matchedRow), 1);
  }

  return selectedRows;
}

export async function listCurrentRuntimeServicesForProjectWorkspaces(
  db: RuntimeServiceReadDb,
  companyId: string,
  projectWorkspaceIds: string[],
) {
  if (projectWorkspaceIds.length === 0) return new Map<string, WorkspaceRuntimeServiceRow[]>();

  const rows = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, companyId),
        inArray(workspaceRuntimeServices.projectWorkspaceId, projectWorkspaceIds),
        eq(workspaceRuntimeServices.scopeType, "project_workspace"),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt), desc(workspaceRuntimeServices.createdAt));

  const grouped = new Map<string, WorkspaceRuntimeServiceRow[]>();
  for (const row of rows) {
    if (!row.projectWorkspaceId) continue;
    const existing = grouped.get(row.projectWorkspaceId) ?? [];
    existing.push(row);
    grouped.set(row.projectWorkspaceId, existing);
  }

  return new Map(
    Array.from(grouped.entries()).map(([workspaceId, workspaceRows]) => [
      workspaceId,
      selectCurrentRuntimeServiceRows(workspaceRows),
    ]),
  );
}

export async function listCurrentRuntimeServicesForExecutionWorkspaces(
  db: RuntimeServiceReadDb,
  companyId: string,
  executionWorkspaceIds: string[],
) {
  if (executionWorkspaceIds.length === 0) return new Map<string, WorkspaceRuntimeServiceRow[]>();

  const rows = await db
    .select()
    .from(workspaceRuntimeServices)
    .where(
      and(
        eq(workspaceRuntimeServices.companyId, companyId),
        inArray(workspaceRuntimeServices.executionWorkspaceId, executionWorkspaceIds),
      ),
    )
    .orderBy(desc(workspaceRuntimeServices.updatedAt), desc(workspaceRuntimeServices.createdAt));

  const grouped = new Map<string, WorkspaceRuntimeServiceRow[]>();
  for (const row of rows) {
    if (!row.executionWorkspaceId) continue;
    const existing = grouped.get(row.executionWorkspaceId) ?? [];
    existing.push(row);
    grouped.set(row.executionWorkspaceId, existing);
  }

  return new Map(
    Array.from(grouped.entries()).map(([workspaceId, workspaceRows]) => [
      workspaceId,
      selectCurrentRuntimeServiceRows(workspaceRows),
    ]),
  );
}
