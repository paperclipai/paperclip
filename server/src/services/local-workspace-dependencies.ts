import { and, eq, isNotNull, notExists, sql } from "drizzle-orm";
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
