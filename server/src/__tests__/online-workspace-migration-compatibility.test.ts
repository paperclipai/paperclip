import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, executionWorkspaceSnapshots, executionWorkspaces,
  issues, projects, workspaceOperations, type Db } from "@paperclipai/db";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { runOnlineWorkspaceMigration, type OnlineWorkspaceMigrationRequest } from "../maintenance/online-workspace-migration.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { migrateRemoteWorkspace } from "../services/remote-workspace-migration.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type OldProtocol = Pick<typeof import("../services/workspace-source-lock.js"), "withWorkspaceSourceLocks">
  & Pick<typeof import("@paperclipai/shared"), "readRemoteWorkspaceAuthority">
  & Pick<typeof import("../services/remote-workspace-snapshot-storage.js"), "getWorkspaceSnapshot" | "loadWorkspaceSnapshotArchive">
  & Pick<typeof import("../services/remote-workspace-snapshot-archive.js"), "restoreRemoteWorkspaceArchive">;
const support = await getEmbeddedPostgresTestSupport();
const oldCommit = "e2d490c61bbf12290b35af65f6e12648f5f2af75";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(ready => { resolve = ready; }); return { promise, resolve }; }

describe.skipIf(!support.supported)("versioned online migration compatibility with serving e2d", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, old: OldProtocol, home: string, storage: StorageService;
  beforeAll(async () => {
    const fixture = new URL("./fixtures/online-workspace-e2d-protocol.mjs", import.meta.url);
    const provenance = JSON.parse(await fs.readFile(new URL("./fixtures/online-workspace-e2d-protocol.provenance.json", import.meta.url), "utf8"));
    expect(provenance.commit).toBe(oldCommit);
    expect(provenance.sourceFiles["server/src/services/workspace-source-lock.ts"])
      .toBe("f01502b1432e896a922fbf0b3526d15b1a987f785afe89c3e8992d05a21c8040");
    expect(Object.keys(provenance.sourceFiles)).toHaveLength(15);
    expect(provenance.bundleSha256).toBe("b668e53a48c6b8cd6c3ce6a8d935144fdedb74de43970607e740f3bfd45bb218");
    expect(createHash("sha256").update(await fs.readFile(fixture)).digest("hex")).toBe(provenance.bundleSha256);
    old = await import(pathToFileURL(fixture.pathname).href) as OldProtocol;
    database = await startEmbeddedPostgresTestDatabase("online-migration-compatibility-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    await db.execute(sql`set client_min_messages = warning`);
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "online-migration-compatibility-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    const disk = createLocalDiskStorageProvider(path.join(home, "controlled-s3-backend"));
    storage = createStorageService({ ...disk, id: "s3" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog); await db.delete(workspaceOperations); await db.delete(executionWorkspaceSnapshots);
    await db.delete(issues); await db.delete(executionWorkspaces); await db.delete(projects); await db.delete(companies);
    vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true });
  });
  async function fixture(companyId = randomUUID()) {
    if (!(await db.select().from(companies).where(eq(companies.id, companyId)))[0])
      await db.insert(companies).values({ id: companyId, name: "Compatibility", issuePrefix: `C${companyId.slice(0, 6)}` });
    const [project] = await db.insert(projects).values({ companyId, name: "Managed original source" }).returning();
    const cwd = resolveManagedProjectWorkspaceDir({ companyId, projectId: project.id });
    await fs.mkdir(cwd, { recursive: true }); await fs.writeFile(path.join(cwd, "saved.txt"), "original user edits\n", { mode: 0o640 });
    const [issue] = await db.insert(issues).values({ companyId, projectId: project.id, title: "Retained task" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project.id, sourceIssueId: issue.id,
      name: "Managed directory", mode: "shared_workspace", strategyType: "project_primary", providerType: "local_fs", cwd, providerRef: cwd,
      metadata: { retainedHistory: "do not rewrite" } }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
    return { companyId, projectId: project.id, workspaceId: workspace.id, cwd };
  }
  function request(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<OnlineWorkspaceMigrationRequest> = {}): OnlineWorkspaceMigrationRequest {
    return { schema: "paperclip.online-workspace-migration.v1", toolCommit: "1".repeat(40), toolRoot: path.join(home, "versioned-tool"),
      source: { commit: oldCommit, deploymentId: "11111111-1111-4111-8111-111111111111" }, companyId: f.companyId,
      workspaceIds: [f.workspaceId], mode: "single", deadlineMs: 60_000, concurrency: 1, ...extra };
  }
  const apply = (r: OnlineWorkspaceMigrationRequest) => runOnlineWorkspaceMigration({ db, storage, request: r, signal: AbortSignal.timeout(60_000) });
  const workspace = async (id: string) => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0];
  async function oldColdRestore(f: Awaited<ReturnType<typeof fixture>>, expected: string) {
    const row = await workspace(f.workspaceId), authority = old.readRemoteWorkspaceAuthority(row.metadata)!;
    const reference = (await old.getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! }))!;
    const parked = path.join(home, "parked-original"); await fs.rename(f.cwd, parked);
    try {
      const archivePath = path.join(home, "old-reader.pcws"), targetDir = path.join(home, "old-reader-restored");
      await old.loadWorkspaceSnapshotArchive({ storage, reference, targetPath: archivePath });
      await old.restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: reference.manifestDigest });
      expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe(expected);
      expect((await fs.stat(path.join(targetDir, "saved.txt"))).mode & 0o777).toBe(0o640);
    } finally { await fs.rename(parked, f.cwd); }
    expect((await workspace(f.workspaceId)).metadata?.retainedHistory).toBe("do not rewrite");
  }
  it("honors the actual old writer lock, admits an unrelated writer, then lets old readers cold-restore new authority", async () => {
    const f = await fixture(), other = await fixture(f.companyId), held = deferred(), release = deferred();
    const writer = old.withWorkspaceSourceLocks(db, { companyId: f.companyId, projectIds: [f.projectId] }, async () => {
      held.resolve(); await release.promise; await fs.writeFile(path.join(f.cwd, "saved.txt"), "saved by old writer\n");
    });
    await held.promise;
    try {
      await expect(apply(request(f))).rejects.toThrow("workspace_source_busy");
      expect(await db.select().from(workspaceOperations)).toEqual([]);
      expect(await db.select().from(executionWorkspaceSnapshots)).toEqual([]);
      await old.withWorkspaceSourceLocks(db, { companyId: other.companyId, projectIds: [other.projectId] }, async () => {
        await fs.writeFile(path.join(other.cwd, "unrelated.txt"), "unrelated writer admitted\n");
      }, true);
      expect(await fs.readFile(path.join(other.cwd, "unrelated.txt"), "utf8")).toBe("unrelated writer admitted\n");
    } finally { release.resolve(); await writer; }
    await expect(apply(request(f))).resolves.toMatchObject({ applied: true });
    await oldColdRestore(f, "saved by old writer\n");
  }, 60_000);
  it.each(["pending", "uploaded"])("resumes the old migration.v1 journal shape with the same operation and snapshot IDs (%s)", async state => {
    const f = await fixture(), abort = new AbortController();
    if (state === "pending") {
      const transaction = db.transaction.bind(db);
      vi.spyOn(db, "transaction").mockImplementation((async (action, config) => {
        const result = await transaction(action, config);
        if ((result as { operation?: { phase?: string } })?.operation?.phase === "remote_workspace_migration")
          abort.abort(new Error("fixture_old_format_pending_capture"));
        return result;
      }) as Db["transaction"]);
    } else {
      await db.execute(sql`create function fixture_refuse_migration_publication() returns trigger language plpgsql as $$
        begin if new.metadata->'remoteWorkspace' is not null then raise exception 'fixture_old_format_uploaded_publication'; end if; return new; end $$`);
      await db.execute(sql`create trigger fixture_refuse_migration_publication before update on execution_workspaces
        for each row execute function fixture_refuse_migration_publication()`);
    }
    try {
      await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true, signal: abort.signal })).rejects.toThrow();
    } finally {
      if (state === "uploaded") {
        await db.execute(sql`drop trigger fixture_refuse_migration_publication on execution_workspaces`);
        await db.execute(sql`drop function fixture_refuse_migration_publication()`);
      }
    }
    vi.restoreAllMocks();
    const [operation] = await db.select().from(workspaceOperations), [snapshot] = await db.select().from(executionWorkspaceSnapshots);
    expect(operation.status).toBe("running"); expect(operation.finishedAt).toBeNull();
    expect(operation.metadata?.nestedWorkspaceScope).toMatchObject({ version: 1, state: state === "pending" ? "pending" : "fixed" });
    expect(snapshot.status).toBe(state);
    const before = await workspace(f.workspaceId);
    expect(before.metadata?.remoteWorkspaceMigration).toMatchObject({ schema: "paperclip.remote-workspace-migration.v1", operationId: operation.id });
    expect(old.readRemoteWorkspaceAuthority(before.metadata)).toBeNull();
    await expect(apply(request(f, { mode: "resume", operationId: operation.id, snapshotId: snapshot.id }))).resolves.toMatchObject({ applied: true, snapshotId: snapshot.id });
    expect((await db.select().from(workspaceOperations)).map(o => o.id)).toEqual([operation.id]);
    expect((await db.select().from(executionWorkspaceSnapshots)).map(s => s.id)).toEqual([snapshot.id]);
    await oldColdRestore(f, "original user edits\n");
  }, 60_000);
  it.each(["missing", "wrong-type"])("refuses a real incompatible schema before any journal, storage or authority write (%s)", async mode => {
    const f = await fixture(), put = vi.spyOn(storage, "putFile");
    await db.execute(sql`alter table native_run_finalizations rename column controller_host_hash to fixture_original_controller_host_hash`);
    try {
      if (mode === "wrong-type") await db.execute(sql`alter table native_run_finalizations add column controller_host_hash integer`);
      await expect(apply(request(f))).rejects.toThrow("online_migration_schema_incompatible");
      expect(put).not.toHaveBeenCalled(); expect(await db.select().from(workspaceOperations)).toEqual([]);
      expect(await db.select().from(executionWorkspaceSnapshots)).toEqual([]);
      expect(old.readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    } finally {
      if (mode === "wrong-type") await db.execute(sql`alter table native_run_finalizations drop column controller_host_hash`);
      await db.execute(sql`alter table native_run_finalizations rename column fixture_original_controller_host_hash to controller_host_hash`);
    }
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original user edits\n");
  });
});
