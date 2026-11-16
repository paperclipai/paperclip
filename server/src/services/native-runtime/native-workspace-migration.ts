import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, workspaceOperations, type Db } from "@paperclipai/db";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { findNativeSessionResumeRun } from "./native-session-resume.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

const SCHEMA = "paperclip.native-workspace-migration.v1";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const absolute = (value: unknown): value is string => typeof value === "string" && value !== "/"
  && !value.includes("\0") && path.posix.isAbsolute(value) && path.posix.normalize(value) === value;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
type Workspace = Pick<typeof executionWorkspaces.$inferSelect, "companyId" | "id">;
type SessionBinding = { sourceRunId: string; agentId: string; issueId: string; sessionId: string; logicalCwd: string };
export type NativeWorkspaceMigration = { schema: typeof SCHEMA; remoteCwd: string; sessions: SessionBinding[] };

export async function inspectNativeWorkspaceMigration(db: Db, workspace: Workspace): Promise<NativeWorkspaceMigration | null> {
  const rows = await db.execute<{ agentId: string; issueId: string; sessionId: string; createdAt: Date }>(sql`
    select s.agent_id as "agentId", r.native_issue_id as "issueId", r.native_session_id as "sessionId", r.created_at as "createdAt"
    from agent_task_sessions s join heartbeat_runs r on r.id = s.last_run_id
      and r.company_id = s.company_id and r.agent_id = s.agent_id
    where s.company_id = ${workspace.companyId} and s.adapter_type = 'paperclip_runner'
      and r.native_issue_id is not null and r.native_session_id is not null
      and r.runner_profile_json#>>'{nativeExecutionInput,binding,executionWorkspaceId}' = ${workspace.id}
    order by s.id limit 1001`);
  if (rows.length > 1000) throw new Error("native_workspace_migration_session_limit");
  const sessions: SessionBinding[] = [];
  let remoteCwd: string | null = null;
  for (const row of rows) {
    const source = await findNativeSessionResumeRun(db, { companyId: workspace.companyId, agentId: row.agentId,
      issueId: row.issueId, normalizedSessionId: row.sessionId, beforeCreatedAt: new Date(row.createdAt), includeProgressBarrier: true });
    if (!source) continue;
    const execution = parseNativeExecutionInput(source.runnerProfileJson.nativeExecutionInput);
    const [saved] = await db.select({ sync: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'` })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, workspace.companyId), eq(heartbeatRuns.id, source.id)));
    const sync = readNativeWorkspaceSyncReference(saved?.sync);
    if (execution.binding.executionWorkspaceId !== workspace.id || execution.binding.companyId !== workspace.companyId
      || execution.binding.agentId !== row.agentId || execution.binding.issueId !== row.issueId
      || execution.session.normalizedSessionId !== row.sessionId || !absolute(execution.workspace.cwd)
      || !sync || sync.workspaceId !== workspace.id || !absolute(sync.remoteCwd)) throw new Error("native_workspace_migration_identity_unproven");
    if (remoteCwd && remoteCwd !== sync.remoteCwd) throw new Error("native_workspace_migration_remote_path_conflict");
    remoteCwd = sync.remoteCwd;
    sessions.push({ sourceRunId: source.id, agentId: row.agentId, issueId: row.issueId, sessionId: row.sessionId, logicalCwd: execution.workspace.cwd });
  }
  return remoteCwd ? { schema: SCHEMA, remoteCwd, sessions } : null;
}

export async function readNativeWorkspaceMigration(db: Pick<Db, "select">, workspace: Workspace) {
  const [row] = await db.select({ workspaceMetadata: executionWorkspaces.metadata, metadata: workspaceOperations.metadata, operationId: workspaceOperations.id })
    .from(executionWorkspaces).leftJoin(workspaceOperations, and(
      eq(workspaceOperations.companyId, executionWorkspaces.companyId), eq(workspaceOperations.executionWorkspaceId, executionWorkspaces.id),
      sql`${workspaceOperations.id} = case when ${executionWorkspaces.metadata}->'nativeWorkspaceMigration'->>'operationId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
        then (${executionWorkspaces.metadata}->'nativeWorkspaceMigration'->>'operationId')::uuid end`,
      eq(workspaceOperations.phase, "remote_workspace_migration"), eq(workspaceOperations.status, "succeeded"),
    )).where(and(eq(executionWorkspaces.companyId, workspace.companyId), eq(executionWorkspaces.id, workspace.id)));
  if (!row?.workspaceMetadata?.nativeWorkspaceMigration) return null;
  const migration = object(row.metadata?.nativeSessionContinuity);
  if (object(row.workspaceMetadata.nativeWorkspaceMigration).schema !== SCHEMA || !row.operationId || row.metadata?.schema !== "paperclip.remote-workspace-migration.v1" || !uuid(row.metadata.snapshotId)
    || migration.schema !== SCHEMA || !absolute(migration.remoteCwd) || !Array.isArray(migration.sessions)
    || !migration.sessions.length || migration.sessions.length > 1000
    || !migration.sessions.every(value => {
      const session = object(value);
      return [session.sourceRunId, session.agentId, session.issueId, session.sessionId].every(uuid) && absolute(session.logicalCwd);
    })) throw new Error("native_workspace_migration_receipt_invalid");
  return { ...(migration as NativeWorkspaceMigration), operationId: row.operationId };
}

export function nativeWorkspaceMigrationMarker(operationId: string) {
  return { schema: SCHEMA, operationId };
}

export function migratedNativeExecutionCwd(migration: NativeWorkspaceMigration | null, input: { agentId: string; issueId: string; sessionId: string }) {
  return migration?.sessions.find(session => session.agentId === input.agentId && session.issueId === input.issueId
    && session.sessionId === input.sessionId)?.logicalCwd ?? null;
}

export async function canRestoreMigratedNativeSession(db: Db, input: {
  companyId: string; workspaceId: string; agentId: string; issueId: string; sessionId: string; logicalCwd: string | null; remoteCwd: string;
}) {
  if (input.logicalCwd === null) return false;
  const migration = await readNativeWorkspaceMigration(db, { companyId: input.companyId, id: input.workspaceId });
  return migration?.remoteCwd === input.remoteCwd && migratedNativeExecutionCwd(migration, input) === input.logicalCwd;
}
