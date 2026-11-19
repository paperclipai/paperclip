import { and, asc, desc, eq, gt, isNotNull, notExists, sql } from "drizzle-orm";
import { agents, environments, executionWorkspaces, type Db } from "@paperclipai/db";

export function localWorkspaceDependencyWhere(db: Pick<Db, "select">) {
  const taskOwner = sql`${executionWorkspaces.metadata}->'runnerTaskWorkspaceOwner'`;
  const pluginTaskWorkspace = db.select({ id: agents.id }).from(agents).innerJoin(environments,
    sql`${environments.id}::text = ${taskOwner}->>'environmentId'`).where(and(
    eq(executionWorkspaces.providerType, "adapter_managed"),
    eq(agents.companyId, executionWorkspaces.companyId), eq(agents.adapterType, "paperclip_runner"),
    sql`${agents.id}::text = ${taskOwner}->>'agentId'`, eq(environments.driver, "plugin"),
    sql`jsonb_typeof(${taskOwner}) = 'object'`,
    sql`jsonb_typeof(${taskOwner}->'agentId') = 'string'`,
    sql`jsonb_typeof(${taskOwner}->'environmentId') = 'string'`,
    sql`jsonb_typeof(${taskOwner}->'pluginKey') = 'string'`,
    sql`jsonb_typeof(${taskOwner}->'driverKey') = 'string'`,
    sql`jsonb_typeof(${environments.config}->'pluginKey') = 'string'`,
    sql`jsonb_typeof(${environments.config}->'driverKey') = 'string'`,
    sql`btrim(${taskOwner}->>'pluginKey') <> ''`, sql`btrim(${taskOwner}->>'driverKey') <> ''`,
    sql`${environments.config}->>'pluginKey' = ${taskOwner}->>'pluginKey'`,
    sql`${environments.config}->>'driverKey' = ${taskOwner}->>'driverKey'`,
  ));
  return and(
    isNotNull(executionWorkspaces.cwd), sql`${executionWorkspaces.providerType} <> 'plugin'`,
    sql`coalesce(${executionWorkspaces.metadata}->'remoteWorkspace'->>'schema', '') <> 'paperclip.remote-workspace.v1'`,
    notExists(pluginTaskWorkspace),
  );
}

export async function listLocalWorkspaceCompanies(db: Pick<Db, "selectDistinct" | "select">, input: { after?: string; limit: number }) {
  const rows = await db.selectDistinct({ companyId: executionWorkspaces.companyId }).from(executionWorkspaces)
    .where(and(localWorkspaceDependencyWhere(db), input.after ? gt(executionWorkspaces.companyId, input.after) : undefined))
    .orderBy(asc(executionWorkspaces.companyId)).limit(input.limit);
  return rows.map(row => row.companyId);
}

export async function listLocalWorkspaces(db: Pick<Db, "select">, input: { after?: string; limit: number }) {
  const depth = sql<number>`length(${executionWorkspaces.cwd})`;
  const cursor = input.after?.match(/^(\d{1,9}):([0-9a-f-]{36})$/);
  if (input.after && !cursor) throw new Error("local_workspace_cursor_invalid");
  const rows = await db.select({ companyId: executionWorkspaces.companyId, workspaceId: executionWorkspaces.id, depth })
    .from(executionWorkspaces).where(and(localWorkspaceDependencyWhere(db), cursor
      ? sql`(${depth} < ${Number(cursor[1])} or (${depth} = ${Number(cursor[1])} and ${executionWorkspaces.id} > ${cursor[2]}::uuid))`
      : undefined))
    .orderBy(desc(depth), asc(executionWorkspaces.id)).limit(input.limit);
  return rows.map(row => ({ companyId: row.companyId, workspaceId: row.workspaceId, cursor: `${Number(row.depth)}:${row.workspaceId}` }));
}
