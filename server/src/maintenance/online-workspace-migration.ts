import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { closeRegisteredClients, createDb, executionWorkspaces, inspectMigrations, type Db } from "@paperclipai/db";
import { z } from "zod";
import { readBuildCommit } from "../build-commit.js";
import { loadCloudBootstrapConfig, loadConfig } from "../config.js";
import { cloudRuntimeConfigService } from "../services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../services/cloud-runtime-config-snapshot.js";
import * as migration from "../services/remote-workspace-migration.js";
import { inspectOnlineWorkspaceSource } from "../services/online-workspace-source.js";
import { withWorkspaceSourceLocks } from "../services/workspace-source-lock.js";
import { getStorageService } from "../storage/index.js";
import type { StorageService } from "../storage/types.js";
import { initializeNativeHarnessPrestageKey } from "./native-harness-prestage-runtime.js";

const commit = z.string().regex(/^[a-f0-9]{40}$/);
const requestSchema = z.object({
  schema: z.literal("paperclip.online-workspace-migration.v1"),
  toolCommit: commit,
  toolRoot: z.string().min(1).max(4096),
  source: z.object({ commit, deploymentId: z.string().uuid() }).strict(),
  companyId: z.string().uuid(),
  workspaceIds: z.array(z.string().uuid()).min(1).max(8),
  mode: z.enum(["inspect", "single", "cohort", "resume"]),
  operationId: z.string().uuid().optional(),
  snapshotId: z.string().uuid().optional(),
  deadlineMs: z.number().int().min(1000).max(720_000),
  concurrency: z.number().int().min(1).max(8),
}).strict();

export type OnlineWorkspaceMigrationRequest = z.infer<typeof requestSchema>;

export function parseOnlineWorkspaceMigrationRequest(value: unknown): OnlineWorkspaceMigrationRequest {
  const request = requestSchema.parse(value);
  request.companyId = request.companyId.toLowerCase();
  request.source.deploymentId = request.source.deploymentId.toLowerCase();
  if (request.operationId) request.operationId = request.operationId.toLowerCase();
  if (request.snapshotId) request.snapshotId = request.snapshotId.toLowerCase();
  request.workspaceIds = request.workspaceIds.map(id => id.toLowerCase()).sort();
  if (new Set(request.workspaceIds).size !== request.workspaceIds.length) throw new Error("online_migration_duplicate_workspace");
  if (!path.isAbsolute(request.toolRoot) || path.normalize(request.toolRoot) !== request.toolRoot
    || request.toolRoot === "/" || request.toolRoot === "/app" || request.toolRoot.startsWith("/app/")) {
    throw new Error("online_migration_private_tool_root_required");
  }
  if (["single", "resume"].includes(request.mode) && (request.workspaceIds.length !== 1 || request.concurrency !== 1)) {
    throw new Error("online_migration_single_workspace_required");
  }
  if (request.mode === "resume" ? !request.operationId || !request.snapshotId : request.operationId || request.snapshotId) {
    throw new Error("online_migration_exact_resume_identity_required");
  }
  return request;
}

export async function assertOnlineMigrationManifest(url: string) {
  const state = await inspectMigrations(url);
  if (state.status !== "upToDate") throw new Error("online_migration_schema_manifest_pending");
}

export async function assertOnlineMigrationSchema(db: Pick<Db, "execute">) {
  const rows = await db.execute(sql`select a.attname, format_type(a.atttypid,a.atttypmod) type,
    a.attnotnull not_null from pg_attribute a
    where a.attrelid=to_regclass('native_run_finalizations')
      and a.attname='controller_host_hash' and a.attnum>0 and not a.attisdropped`);
  if (rows.length !== 1 || rows[0]?.type !== "text" || rows[0]?.not_null !== false) {
    throw new Error("online_migration_schema_incompatible");
  }
}

const readOnly = <T>(db: Db, action: (tx: Db) => Promise<T>) => db.transaction(async tx => {
  await tx.execute(sql`set transaction read only`);
  await tx.execute(sql`set local statement_timeout='8s'`);
  await tx.execute(sql`set local lock_timeout='1s'`);
  return action(tx as unknown as Db);
}, { accessMode: "read only" });

async function assertResumeIdentity(db: Db, request: OnlineWorkspaceMigrationRequest) {
  const [row] = await db.execute(sql`select w.metadata#>>'{remoteWorkspaceMigration,operationId}' marker,
    w.metadata#>>'{remoteWorkspace,snapshotId}' authority,
    o.id operation_id,o.status operation_status,o.finished_at,
    s.id snapshot_id,s.status snapshot_status from execution_workspaces w
    left join workspace_operations o on o.company_id=w.company_id and o.execution_workspace_id=w.id
      and o.id=${request.operationId}::uuid and o.phase='remote_workspace_migration'
    left join execution_workspace_snapshots s on s.company_id=w.company_id and s.execution_workspace_id=w.id
      and s.source_operation_id=o.id and s.id=${request.snapshotId}::uuid
    where w.company_id=${request.companyId}::uuid and w.id=${request.workspaceIds[0]}::uuid`);
  if (!row || row.marker !== request.operationId || row.operation_id !== request.operationId
    || row.snapshot_id !== request.snapshotId || row.authority !== null || row.operation_status !== "running"
    || row.finished_at !== null || !["pending", "uploaded"].includes(String(row.snapshot_status))) {
    throw new Error("online_migration_resume_identity_changed");
  }
}

export async function runOnlineWorkspaceMigration(input: {
  db: Db; storage: StorageService; request: OnlineWorkspaceMigrationRequest; signal: AbortSignal;
}) {
  const request = parseOnlineWorkspaceMigrationRequest(input.request);
  input.signal.throwIfAborted();
  await assertOnlineMigrationSchema(input.db);
  if (input.storage.provider !== "s3") throw new Error("online_migration_shared_storage_required");
  if (request.mode === "inspect") {
    const members = await readOnly(input.db, async db => {
      const result = [];
      for (const workspaceId of request.workspaceIds) {
        input.signal.throwIfAborted();
        const row = await migration.inventoryRemoteWorkspaceMigration(db, { companyId: request.companyId, workspaceId });
        result.push({ workspaceId: row.workspaceId, eligible: row.eligible, alreadyMigrated: row.alreadyMigrated,
          reasons: row.reasons, operationId: row.operationId, snapshotId: row.snapshotId, source: row.source });
      }
      return result;
    });
    return { companyId: request.companyId, applied: false as const, members };
  }
  if (request.mode === "cohort") {
    type Cohort = (args: { db: Db; storage: StorageService; companyId: string; workspaceIds: string[];
      apply: true; concurrency: number; signal: AbortSignal }) => Promise<unknown>;
    const owner = (migration as typeof migration & { migrateRemoteWorkspaceCohort?: Cohort }).migrateRemoteWorkspaceCohort;
    if (!owner) throw new Error("online_migration_cohort_unavailable");
    return owner({ db: input.db, storage: input.storage, companyId: request.companyId,
      workspaceIds: request.workspaceIds, apply: true, concurrency: request.concurrency, signal: input.signal });
  }
  const apply = async () => {
    input.signal.throwIfAborted();
    if (request.mode === "resume") await readOnly(input.db, db => assertResumeIdentity(db, request));
    const result = await migration.migrateRemoteWorkspace({ db: input.db, storage: input.storage,
      companyId: request.companyId, workspaceId: request.workspaceIds[0], apply: true, signal: input.signal });
    if (request.mode === "resume" && result.snapshotId !== request.snapshotId) throw new Error("online_migration_resume_result_changed");
    return result;
  };
  if (request.mode !== "resume") return apply();
  const [workspace] = await input.db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, request.companyId), eq(executionWorkspaces.id, request.workspaceIds[0])));
  const source = workspace && await inspectOnlineWorkspaceSource(input.db, workspace);
  if (!source) throw new Error("online_migration_resume_source_unproven");
  return withWorkspaceSourceLocks(input.db, { companyId: request.companyId,
    projectIds: source.projectIds, issueIds: source.issueIds }, apply, true);
}

export async function assertOnlineMigrationRuntime(request: OnlineWorkspaceMigrationRequest) {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("online_migration_node24_required");
  const root = await fs.realpath(request.toolRoot), entry = await fs.realpath(fileURLToPath(import.meta.url));
  if (root !== request.toolRoot || !["src", "dist"].some(tree => entry === path.join(root,
    "server", tree, "maintenance", `online-workspace-migration.${tree === "src" ? "ts" : "js"}`))) {
    throw new Error("online_migration_tool_root_mismatch");
  }
  if (readBuildCommit({ environmentCommit: null, buildCommitPath: path.join(root, ".paperclip-build-commit"),
    buildInfoPath: path.join(root, "server", "dist", "build-info.json") }) !== request.toolCommit) throw new Error("online_migration_tool_commit_mismatch");
  if (process.env.RAILWAY_DEPLOYMENT_ID !== request.source.deploymentId) throw new Error("online_migration_source_deployment_changed");
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3100}/api/health`, { signal: AbortSignal.timeout(5000) });
  const body = response.status === 200 ? await response.json() as { status?: string; commit?: string } : null;
  if (body?.status !== "ok" || body.commit !== request.source.commit) throw new Error("online_migration_source_health_changed");
}

export function onlineWorkspaceMigrationReceipt(result: unknown) {
  const row = result as Record<string, unknown>;
  const member = (value: unknown) => {
    const item = value as Record<string, unknown>;
    return { workspaceId: item.workspaceId, snapshotId: item.snapshotId, operationId: item.operationId,
      eligible: item.eligible, alreadyMigrated: item.alreadyMigrated, reasons: item.reasons,
      sourceSha256: createHash("sha256").update(JSON.stringify(item.source ?? null)).digest("hex") };
  };
  return { companyId: row.companyId, cohortId: row.cohortId, applied: row.applied, replayed: row.replayed,
    members: Array.isArray(row.members) ? row.members.map(member) : [member(row)] };
}

export async function runOnlineWorkspaceMigrationEntry(args = process.argv.slice(2)) {
  if (process.env.PAPERCLIP_ONLINE_WORKSPACE_MIGRATION !== "true" || args.length !== 1) {
    throw new Error("online_migration_explicit_request_required");
  }
  const file = await fs.open(args[0], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let request: OnlineWorkspaceMigrationRequest;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65_536 || (stat.mode & 0o077)) throw new Error("online_migration_private_request_required");
    const bytes = Buffer.alloc(65_537);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 65_536) throw new Error("online_migration_request_too_large");
    request = parseOnlineWorkspaceMigrationRequest(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } finally { await file.close(); }
  let url: string | undefined;
  const cancellation = new AbortController();
  const stop = () => cancellation.abort(new Error("online_migration_interrupted"));
  const deadline = setTimeout(() => cancellation.abort(new Error("online_migration_deadline")), request.deadlineMs);
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    await assertOnlineMigrationRuntime(request);
    if (!process.env.DATABASE_URL) throw new Error("online_migration_explicit_database_required");
    url = loadCloudBootstrapConfig().databaseUrl;
    await assertOnlineMigrationManifest(url);
    cancellation.signal.throwIfAborted();
    const db = createDb(url);
    await assertOnlineMigrationSchema(db);
    const config = await readOnly(db, tx => cloudRuntimeConfigService(tx).inspectStored());
    if (!config) throw new Error("cloud_runtime_configuration_missing");
    setCloudRuntimeConfigSnapshot(config);
    await initializeNativeHarnessPrestageKey(loadConfig().secretsMasterKeyFilePath);
    await assertOnlineMigrationRuntime(request);
    const result = await runOnlineWorkspaceMigration({ db, storage: getStorageService(), request, signal: cancellation.signal });
    console.log(JSON.stringify({ schema: request.schema, toolCommit: request.toolCommit, source: request.source, result: onlineWorkspaceMigrationReceipt(result),
      enrollmentReady: false, allStartedWorkAwaited: true, maxRssKiB: process.resourceUsage().maxRSS }));
    return result;
  } finally {
    clearTimeout(deadline); process.off("SIGTERM", stop); process.off("SIGINT", stop);
    if (url) await closeRegisteredClients(url, { scope: "database" });
  }
}

if (process.env.PAPERCLIP_ONLINE_WORKSPACE_MIGRATION === "true") {
  await runOnlineWorkspaceMigrationEntry().catch(error => {
    const reason = error instanceof Error && /^[a-z_]{1,120}(?::[a-z_,]{1,1000})?$/.test(error.message) ? error.message : "online_migration_failed";
    console.error(JSON.stringify({ schema: "paperclip.online-workspace-migration.v1", state: "blocked", reason, enrollmentReady: false }));
    process.exitCode = 1;
  });
}
