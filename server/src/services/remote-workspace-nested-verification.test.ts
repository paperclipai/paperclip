import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, executionWorkspaceSnapshots, executionWorkspaces, issues, projects, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { getWorkspaceSnapshot } from "./remote-workspace-snapshot-storage.js";
import { nestedWorkspaceVerificationCheckpoint } from "./remote-workspace-verification-checkpoint.js";
import * as checkpointOwner from "./remote-workspace-verification-checkpoint.js";
import * as workspaceArchive from "./remote-workspace-snapshot-archive.js";
import { createNestedWorkspaceImportVerifier } from "./remote-workspace-migration-tree.js";
import { inspectOnlineWorkspaceSource } from "./online-workspace-source.js";
import { tryAcquireExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { lockOnlineLegacyWorkspaceRecoverySources } from "./online-legacy-workspace-recovery.js";
import { IsolatedRepositorySourceBusy, withWorkspaceSourceLocks } from "./workspace-source-lock.js";

const support = await getEmbeddedPostgresTestSupport(), execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Nested verification", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Nested verification", GIT_COMMITTER_EMAIL: "fixture@example.test" },
})).stdout.trim();

describe.skipIf(!support.supported)("bounded nested workspace verification", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string, storage: StorageService, server: Server;
  let headEtags: Map<string, string | null>;
  let headFailures: Map<string, () => boolean>;
  let storageNamespace: string | undefined;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("nested-verification-"); db = createDb(database.connectionString, { maxConnections: 8 }); }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-nested-verification-")));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture"); vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture");
    vi.stubEnv("AWS_SESSION_TOKEN", "fixture"); vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
    storage = createStorageService(createLocalDiskStorageProvider(path.join(home, "objects")));
    headEtags = new Map();
    headFailures = new Map();
    server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "HEAD") { response.writeHead(405).end(); return; }
        const key = decodeURIComponent(new URL(request.url!, "http://localhost").pathname).slice("/fixture/".length);
        const root = path.join(home, "objects"), file = path.resolve(root, key);
        if (!file.startsWith(root + path.sep)) { response.writeHead(400).end(); return; }
        const bytes = await fs.readFile(file).catch(() => null);
        if (!bytes) { response.writeHead(404).end(); return; }
        if (headFailures.get(key)?.()) { response.writeHead(503).end(); return; }
        const etag = headEtags.has(key) ? headEtags.get(key) : `"${createHash("sha256").update(bytes).digest("hex")}"`;
        response.writeHead(200, { ...(etag == null ? {} : { ETag: etag }), "Content-Length": bytes.length }).end();
      })().catch(() => { response.writeHead(500).end(); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address_missing");
    const heads = createStorageService(createS3StorageProvider({ bucket: "fixture", region: "us-east-1",
      endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true }));
    vi.spyOn(storage, "headObject").mockImplementation(heads.headObject.bind(heads));
    storageNamespace = heads.immutableObjectNamespace;
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await db.delete(activityLog); await db.delete(workspaceOperations); await db.delete(executionWorkspaceSnapshots);
    await db.delete(issues); await db.delete(executionWorkspaces); await db.delete(projects); await db.delete(companies);
    server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve()));
    vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true });
  });
  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID(), root = resolveManagedProjectWorkspaceDir({ companyId, projectId });
    await db.insert(companies).values({ id: companyId, name: "Cohort", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Shared Git" });
    await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, "saved.txt"), "committed base\n");
    await git(root, "init", "-qb", "main"); await git(root, "add", "."); await git(root, "commit", "-qm", "Original history");
    const repoUrl = "https://example.invalid/cohort.git"; await git(root, "remote", "add", "origin", repoUrl);
    const members = [];
    for (const name of ["base", "one", "two"]) {
      const cwd = name === "base" ? root : path.join(root, ".paperclip", "worktrees", name);
      if (name !== "base") await git(root, "worktree", "add", "-qb", name, cwd);
      const [issue] = await db.insert(issues).values({ companyId, projectId, title: name }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId: issue.id, name,
        mode: name === "base" ? "shared_workspace" : "isolated_workspace", strategyType: name === "base" ? "project_primary" : "git_worktree",
        providerType: name === "base" ? "local_fs" : "git_worktree", cwd, providerRef: cwd, repoUrl, branchName: name === "base" ? "main" : name }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
      if (name !== "base") { await fs.writeFile(path.join(cwd, "saved.txt"), `${name} dirty tracked work\n`); await fs.writeFile(path.join(cwd, "untracked.txt"), `${name} untracked work\n`); }
      members.push(workspace);
    }
    return { companyId, projectId, root, parent: members[0], leaves: members.slice(1) };
  }
  async function imported(grandchildren = false) {
    const f = await fixture();
    const descendants = [];
    if (grandchildren) for (const child of f.leaves) {
      const cwd = path.join(child.cwd!, ".paperclip", "worktrees", "nested"), name = `nested-${child.name}`;
      await git(f.root, "worktree", "add", "-qb", name, cwd);
      const [issue] = await db.insert(issues).values({ companyId: f.companyId, projectId: f.projectId, title: name }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: f.projectId,
        sourceIssueId: issue.id, name, mode: "isolated_workspace", strategyType: "git_worktree", providerType: "git_worktree",
        cwd, providerRef: cwd, repoUrl: child.repoUrl, branchName: name }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
      await fs.writeFile(path.join(cwd, "untracked.txt"), name); descendants.push(workspace);
    }
    for (const workspace of descendants) {
      await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: workspace.id, apply: true,
        signal: AbortSignal.timeout(50_000) });
    }
    for (const workspace of f.leaves) await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: workspace.id,
      apply: true, signal: AbortSignal.timeout(50_000) });
    const snapshots = await db.select().from(executionWorkspaceSnapshots);
    return { ...f, snapshots, descendants, keys: new Set(snapshots.map(snapshot => snapshot.objectKey!)) };
  }
  const parent = (f: Awaited<ReturnType<typeof imported>>, signal = AbortSignal.timeout(50_000)) =>
    migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.parent.id, apply: true, signal });
  function checkpointFailure(phase: "read" | "save", failure: Error, beforeFailure?: () => void) {
    const original = checkpointOwner.nestedWorkspaceVerificationCheckpoint;
    let faults = 0;
    const decorate = (target: Db): Db => new Proxy(target, { get(object, key) {
      if (key === (phase === "read" ? "select" : "update")) return () => { faults++; beforeFailure?.(); throw failure; };
      if (key === "transaction") return (callback: (tx: Db) => Promise<unknown>, options: unknown) =>
        object.transaction(tx => callback(decorate(tx as unknown as Db)), options as never);
      const value = Reflect.get(object, key, object); return typeof value === "function" ? value.bind(object) : value;
    } });
    vi.spyOn(checkpointOwner, "nestedWorkspaceVerificationCheckpoint").mockImplementation((source, namespace, signal) =>
      original(decorate(source), namespace, signal));
    return () => faults;
  }
  it.each([{ phase: "read", code: "57014" }, { phase: "save", code: "57014" },
    { phase: "save", code: "40P01" }, { phase: "read", code: "40001" }])(
    "keeps import resumable after checkpoint $phase $code failure", async ({ phase, code }) => {
      const f = await imported(), get = storage.getObject.bind(storage), counts = new Map<string, number>();
      storage = { ...storage, immutableObjectNamespace: storageNamespace };
      vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
        if (f.keys.has(args[1])) counts.set(args[1], (counts.get(args[1]) ?? 0) + 1);
        return get(...args);
      });
      if (phase === "read") {
        const capture = workspaceArchive.captureRemoteWorkspaceDirectory;
        const stop = vi.spyOn(workspaceArchive, "captureRemoteWorkspaceDirectory").mockImplementation(async input => {
          if (input.cwd === f.root) throw new Error("simulated_container_restart");
          return capture(input);
        });
        await expect(parent(f)).rejects.toThrow("simulated_container_restart"); stop.mockRestore();
        expect((await db.select().from(executionWorkspaceSnapshots)).filter(row => row.metadata?.nestedImportVerification)).toHaveLength(f.keys.size);
        counts.clear();
      }
      const pgError = Object.assign(new Error("injected_checkpoint_database_failure"), { code });
      const failure = code === "40001" ? new Error("checkpoint_query_failed", { cause: pgError }) : pgError;
      const faults = checkpointFailure(phase as "read" | "save", failure);
      await expect(parent(f)).resolves.toMatchObject({ applied: true });
      expect(faults()).toBeGreaterThan(0); expect([...counts.values()]).toEqual([1, 1]);
      if (phase === "save") expect((await db.select().from(executionWorkspaceSnapshots)).filter(row => row.metadata?.nestedImportVerification)).toEqual([]);
      const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.parent.id));
      expect(operations).toHaveLength(1); expect(operations[0].status).toBe("succeeded");
      expect((await db.select().from(activityLog)).filter(row => row.action === "workspace.remote_storage_migrated" && row.entityId === f.parent.id)).toHaveLength(1);
      for (const child of f.leaves) expect(await fs.readFile(path.join(child.cwd!, "untracked.txt"), "utf8")).toBe(`${child.name} untracked work\n`);
    }, 60_000);
  it.each([{ phase: "read", code: "42P01", message: "checkpoint_table_missing" },
    { phase: "save", code: "08006", message: "checkpoint_connection_lost" },
    { phase: "save", code: null, message: "nested_workspace_snapshot_changed" },
    { phase: "read", code: null, message: "unexpected_checkpoint_state" }])(
    "refuses checkpoint $phase failure $code without hiding the cause", async ({ phase, code, message }) => {
      const f = await imported(); storage = { ...storage, immutableObjectNamespace: storageNamespace };
      const failure = Object.assign(message === "unexpected_checkpoint_state" ? new TypeError(message) : new Error(message), code ? { code } : {});
      const faults = checkpointFailure(phase as "read" | "save", failure);
      await expect(parent(f)).rejects.toBe(failure); expect(faults()).toBeGreaterThan(0);
      expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.parent.id)))[0].metadata)).toBeNull();
      expect((await db.select().from(activityLog)).filter(row => row.action === "workspace.remote_storage_migrated" && row.entityId === f.parent.id)).toHaveLength(0);
      for (const child of f.leaves) expect(await fs.readFile(path.join(child.cwd!, "untracked.txt"), "utf8")).toBe(`${child.name} untracked work\n`);
    }, 60_000);
  it("preserves cancellation over a retryable checkpoint database error", async () => {
    const f = await imported(), controller = new AbortController(), stopped = new Error("cancelled_during_checkpoint_read");
    storage = { ...storage, immutableObjectNamespace: storageNamespace };
    const reference = (await getWorkspaceSnapshot(db, { companyId: f.companyId, workspaceId: f.snapshots[0].executionWorkspaceId, snapshotId: f.snapshots[0].id }))!;
    const original = checkpointOwner.nestedWorkspaceVerificationCheckpoint;
    checkpointFailure("read", Object.assign(new Error("query_cancelled"), { code: "57014" }), () => controller.abort(stopped));
    const checkpoint = checkpointOwner.nestedWorkspaceVerificationCheckpoint(db, storageNamespace, controller.signal)!;
    await expect(checkpoint.read({ reference, children: [], operationId: f.snapshots[0].sourceOperationId, etag: '"fixture"' })).rejects.toBe(stopped);
    expect(original(db, storageNamespace, controller.signal)).toBeDefined();
  }, 60_000);
  it("treats checkpoint row contention as a bounded optional cache miss", async () => {
    const f = await imported(), snapshot = f.snapshots[0];
    const reference = (await getWorkspaceSnapshot(db, { companyId: f.companyId, workspaceId: snapshot.executionWorkspaceId, snapshotId: snapshot.id }))!;
    const head = await storage.headObject(f.companyId, reference.objectKey), checkpoint = nestedWorkspaceVerificationCheckpoint(db, storageNamespace)!;
    const binding = { reference, children: [], operationId: snapshot.sourceOperationId, etag: head.etag! };
    await db.transaction(async tx => {
      await tx.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, snapshot.id)).for("update");
      const started = performance.now();
      await expect(checkpoint.save(binding)).resolves.toBeUndefined();
      expect(performance.now() - started).toBeLessThan(2500);
      expect(await checkpoint.read(binding)).toBe(false);
    });
    expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, snapshot.id)))[0]).toEqual(snapshot);
  }, 10_000);
  it.skipIf(process.platform === "win32").each(["partial", "changed-master-key"] as const)("resumes a killed import with %s checkpoints and the current key authority", async mode => {
    const f = await imported(), repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address_missing");
    const keys = [...f.keys], endpoint = `http://127.0.0.1:${address.port}`, temporary = path.join(home, "process-scratch");
    await fs.mkdir(temporary);
    const body = String.raw`
      const {createDb,closeRegisteredClients}=await import('@paperclipai/db');
      const {createLocalDiskStorageProvider}=await import('./src/storage/local-disk-provider.ts');
      const {createS3StorageProvider}=await import('./src/storage/s3-provider.ts');
      const {createStorageService}=await import('./src/storage/service.ts');
      const {migrateRemoteWorkspace}=await import('./src/services/remote-workspace-migration.ts');
      const input=JSON.parse(process.env.IMPORT_FIXTURE);
      const db=createDb(process.env.DATABASE_URL,{maxConnections:8});
      const local=createStorageService(createLocalDiskStorageProvider(input.objects));
      const heads=createStorageService(createS3StorageProvider({bucket:'fixture',region:'us-east-1',endpoint:input.endpoint,forcePathStyle:true}));
      const storage={...local,immutableObjectNamespace:heads.immutableObjectNamespace,headObject:heads.headObject.bind(heads),
        async getObject(companyId,key,options){
          if(input.pauseKey===key)await new Promise(()=>{});
          if(input.keys.includes(key))process.send?.({read:key});
          return local.getObject(companyId,key,options);
        },async putFile(value){
          if(input.pauseParentPut)await new Promise(()=>{});
          return local.putFile(value);
        }};
      process.send?.({ready:true});
      try{const result=await migrateRemoteWorkspace({db,storage,companyId:input.companyId,workspaceId:input.workspaceId,
        apply:true,signal:AbortSignal.timeout(30000)});process.send?.({result});}
      catch(error){process.send?.({failed:true,message:error.message});process.exitCode=1;}
      finally{await closeRegisteredClients();process.exit(process.exitCode??0);}
    `;
    const launch = (pauseKey: string | null, pauseParentPut = false, masterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY) => {
      const reads: string[] = [], results: unknown[] = [], failures: string[] = [];
      let ready = false;
      const child = spawn(process.execPath, ["--import", path.join(repoRoot, "cli/node_modules/tsx/dist/loader.mjs"),
        "--input-type=module", "--eval", body], { cwd: path.join(repoRoot, "server"), detached: true,
        env: { ...process.env, PAPERCLIP_SECRETS_MASTER_KEY: masterKey, TMPDIR: temporary, DATABASE_URL: database.connectionString, IMPORT_FIXTURE: JSON.stringify({
          companyId: f.companyId, workspaceId: f.parent.id, objects: path.join(home, "objects"), endpoint, keys, pauseKey, pauseParentPut }) },
        stdio: ["ignore", "pipe", "pipe", "ipc"] });
      let stderr = ""; child.stderr!.on("data", bytes => { stderr += bytes; });
      child.stdout!.resume(); child.on("message", (message: { read?: string; result?: unknown; failed?: boolean; message?: string; ready?: boolean }) => {
        if (message.ready) ready = true;
        if (message.read) reads.push(message.read); if (message.result) results.push(message.result);
        if (message.failed && message.message) failures.push(message.message);
      });
      const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
      });
      return { child, reads, results, failures, closed, ready: () => ready, error: () => stderr };
    };
    const first = mode === "partial" ? launch(keys[1]) : launch(null, true);
    try {
      const prematureExit = first.closed.then(result => { throw new Error(`import_ended_before_checkpoint:${result.code}:${first.error()}`); });
      await Promise.race([vi.waitFor(() => {
        expect(first.ready(), `import_startup_not_ready:${first.error()}`).toBe(true);
      }, { timeout: 30_000, interval: 25 }), prematureExit]);
      await Promise.race([vi.waitFor(async () => {
        const [snapshot] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, f.snapshots[0].id));
        const completed = (await db.select().from(executionWorkspaceSnapshots)).filter(row => row.metadata?.nestedImportVerification);
        expect(completed).toHaveLength(mode === "partial" ? 1 : keys.length); expect(snapshot).toBeDefined();
      }, { timeout: 15_000, interval: 25 }), prematureExit]);
      process.kill(-first.child.pid!, "SIGKILL");
      expect(await first.closed).toMatchObject({ signal: "SIGKILL" });
    } finally {
      if (first.child.exitCode === null && first.child.signalCode === null) { process.kill(-first.child.pid!, "SIGKILL"); await first.closed; }
    }
    const [before] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.parent.id));
    expect(before.status).toBe("running");
    const [beforeSnapshot] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.parent.id));
    await fs.rm(temporary, { recursive: true, force: true }); await fs.mkdir(temporary);
    const snapshotsBefore = await db.select().from(executionWorkspaceSnapshots);
    const second = launch(null, false, mode === "changed-master-key" ? "62".repeat(32) : undefined), result = await second.closed;
    if (mode === "changed-master-key") {
      expect(result, second.error()).toMatchObject({ code: 1, signal: null });
      expect(second.failures).toEqual([expect.stringContaining("Secret decryption failed")]);
      expect(second.reads).toEqual([]); expect(second.results).toEqual([]);
      expect((await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.parent.id)))[0]).toEqual(before);
      expect(await db.select().from(executionWorkspaceSnapshots)).toEqual(snapshotsBefore);
      expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.parent.id)))[0].metadata)).toBeNull();
      expect((await db.select().from(activityLog)).filter(row => row.action === "workspace.remote_storage_migrated" && row.entityId === f.parent.id)).toHaveLength(0);
      return;
    }
    expect(result, second.error()).toMatchObject({ code: 0, signal: null });
    expect(second.results).toEqual([expect.objectContaining({ applied: true, snapshotId: beforeSnapshot.id })]);
    expect([...first.reads, ...second.reads].sort()).toEqual([...keys].sort());
    const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.parent.id));
    expect(operations).toHaveLength(1); expect(operations[0]).toMatchObject({ id: before.id, status: "succeeded" });
    expect((await db.select().from(activityLog)).filter(row => row.action === "workspace.remote_storage_migrated" && row.entityId === f.parent.id)).toHaveLength(1);
  }, 60_000);
  it("rechecks the current master key before reusing an in-memory child proof", async () => {
    const f = await imported(), get = storage.getObject.bind(storage), counts = new Map<string, number>();
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (f.keys.has(args[1])) counts.set(args[1], (counts.get(args[1]) ?? 0) + 1);
      return get(...args);
    });
    const capture = workspaceArchive.captureRemoteWorkspaceDirectory; let parentCaptures = 0;
    vi.spyOn(workspaceArchive, "captureRemoteWorkspaceDirectory").mockImplementation(async input => {
      const result = await capture(input);
      if (input.cwd === f.root && ++parentCaptures === 2) vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
      return result;
    });
    await expect(parent(f)).rejects.toThrow("Secret decryption failed");
    expect(parentCaptures).toBe(2); expect([...counts.values()]).toEqual([1, 1]);
    expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.parent.id)))[0].metadata)).toBeNull();
    expect((await db.select().from(activityLog)).filter(row => row.action === "workspace.remote_storage_migrated" && row.entityId === f.parent.id)).toHaveLength(0);
  }, 60_000);
  it("resumes completed immutable child checks after losing the process and scratch", async () => {
    const f = await imported(), get = storage.getObject.bind(storage), counts = new Map<string, number>();
    storage = { ...storage, immutableObjectNamespace: storageNamespace };
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (f.keys.has(args[1])) counts.set(args[1], (counts.get(args[1]) ?? 0) + 1);
      return get(...args);
    });
    const capture = workspaceArchive.captureRemoteWorkspaceDirectory;
    const interrupted = vi.spyOn(workspaceArchive, "captureRemoteWorkspaceDirectory").mockImplementation(async input => {
      if (input.cwd === f.root) throw new Error("simulated_container_restart");
      return capture(input);
    });
    await expect(parent(f)).rejects.toThrow("simulated_container_restart");
    const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.parent.id));
    expect(operation.status).toBe("running");
    expect([...counts.values()]).toEqual([1, 1]);
    interrupted.mockRestore();
    await expect(parent(f)).resolves.toMatchObject({ applied: true });
    expect([...counts.values()]).toEqual([1, 1]);
    await expect(parent(f)).resolves.toMatchObject({ applied: true, replayed: true });
    const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.parent.id));
    expect(operations).toHaveLength(1); expect(operations[0].id).toBe(operation.id); expect(operations[0].status).toBe("succeeded");
    const publication = await db.select().from(activityLog);
    expect(publication.filter(row => row.action === "workspace.remote_storage_migrated" && row.entityId === f.parent.id)).toHaveLength(1);
  }, 60_000);
  it.each(["local-source", "etag", "namespace", "reference", "key", "lineage", "proof-version", "weak"] as const)(
    "revalidates a changed %s after restarting from an immutable checkpoint", async change => {
      const f = await imported(), get = storage.getObject.bind(storage), counts = new Map<string, number>(), snapshot = f.snapshots[0];
      storage = { ...storage, immutableObjectNamespace: storageNamespace };
      const reads = async (...args: Parameters<StorageService["getObject"]>) => {
        if (f.keys.has(args[1])) counts.set(args[1], (counts.get(args[1]) ?? 0) + 1);
        return get(...args);
      };
      vi.spyOn(storage, "getObject").mockImplementation(reads);
      const capture = workspaceArchive.captureRemoteWorkspaceDirectory;
      const stop = vi.spyOn(workspaceArchive, "captureRemoteWorkspaceDirectory").mockImplementation(async input => {
        if (input.cwd === f.root) throw new Error("simulated_container_restart");
        return capture(input);
      });
      await expect(parent(f)).rejects.toThrow("simulated_container_restart"); stop.mockRestore();
      const [saved] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, snapshot.id));
      expect(saved.metadata?.nestedImportVerification).toMatchObject({ schema: "paperclip.workspace-snapshot-verification.v1" });
      expect(saved.updatedAt).toEqual(snapshot.updatedAt); expect(saved.deleteAfter).toEqual(snapshot.deleteAfter);
      if (change === "local-source") await fs.writeFile(path.join(f.leaves[0].cwd!, "new-work.txt"), "new work survives restart\n");
      if (change === "etag") headEtags.set(snapshot.objectKey!, '"replaced-object-version"');
      if (change === "weak") headEtags.set(snapshot.objectKey!, 'W/"not-a-strong-validator"');
      if (change === "namespace") storage = { ...storage, immutableObjectNamespace: "97".repeat(32) };
      if (change === "reference") await db.update(executionWorkspaceSnapshots).set({ sha256: "00".repeat(32) })
        .where(eq(executionWorkspaceSnapshots.id, snapshot.id));
      if (change === "key") await db.update(executionWorkspaceSnapshots).set({ key: { ...snapshot.key,
        tag: Buffer.alloc(16).toString("base64") } }).where(eq(executionWorkspaceSnapshots.id, snapshot.id));
      if (change === "lineage") await db.update(executionWorkspaceSnapshots).set({ metadata: { ...saved.metadata,
        importedWorkspaceChildren: [{ workspaceId: randomUUID(), snapshotId: randomUUID(), operationId: randomUUID(),
          relativePath: ".paperclip/worktrees/unproved", manifestDigest: "98".repeat(32) }] } })
        .where(eq(executionWorkspaceSnapshots.id, snapshot.id));
      if (change === "proof-version") await db.update(executionWorkspaceSnapshots).set({ metadata: { ...saved.metadata,
        nestedImportVerification: { ...(saved.metadata!.nestedImportVerification as Record<string, unknown>), schema: "paperclip.workspace-snapshot-verification.v99" } } })
        .where(eq(executionWorkspaceSnapshots.id, snapshot.id));
      if (["local-source", "reference", "key", "lineage"].includes(change)) {
        await expect(parent(f)).rejects.toThrow(change === "local-source" ? "nested_workspace_source_changed"
          : change === "reference" ? "object_hash_mismatch" : change === "key" ? "Secret decryption failed" : "nested_workspace_coverage_invalid");
        const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.parent.id));
        expect(readRemoteWorkspaceAuthority(workspace.metadata)).toBeNull();
        if (change === "local-source") {
          expect([...counts.values()]).toEqual([1, 1]);
          expect(await fs.readFile(path.join(f.leaves[0].cwd!, "new-work.txt"), "utf8")).toBe("new work survives restart\n");
        }
      } else {
        await expect(parent(f)).resolves.toMatchObject({ applied: true });
        expect(counts.get(snapshot.objectKey!)).toBe(change === "weak" ? 3 : 2);
        if (change === "namespace") expect([...counts.values()]).toEqual([2, 2]);
      }
    }, 60_000);
  it("overlaps two independent child readbacks and reuses only authenticated immutable proof", async () => {
    const f = await imported(), get = storage.getObject.bind(storage), counts = new Map<string, number>();
    const restore = vi.spyOn(workspaceArchive, "restoreRemoteWorkspaceArchive"), capture = vi.spyOn(workspaceArchive, "captureRemoteWorkspaceDirectory");
    let pending = 0, maximum = 0, entered = 0, release!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; }), timer = setTimeout(release, 2000);
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (!f.keys.has(args[1])) return get(...args);
      counts.set(args[1], (counts.get(args[1]) ?? 0) + 1); maximum = Math.max(maximum, ++pending);
      if (++entered === 2) release();
      try { await both; return await get(...args); } finally { pending--; }
    });
    try { await expect(parent(f)).resolves.toMatchObject({ applied: true }); } finally { clearTimeout(timer); }
    expect.soft(maximum).toBe(2); expect.soft([...counts.values()]).toEqual([1, 1]);
    expect.soft(restore.mock.calls.filter(([args]) => path.basename(args.archivePath) === "saved.pcws")).toHaveLength(2);
    expect(capture.mock.calls.filter(([args]) => args.archivePath.includes("covered-") && path.basename(args.archivePath) === "current.pcws")).toHaveLength(4);
    expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.parent.id)))[0].metadata)).not.toBeNull();
    for (const child of f.leaves) expect(await fs.readFile(path.join(child.cwd!, "untracked.txt"), "utf8")).toBe(`${child.name} untracked work\n`);
  }, 60_000);
  it("bounds both ancestor branches and their grandchildren without recursive permit deadlock", async () => {
    const f = await imported(true), get = storage.getObject.bind(storage), counts = new Map<string, number>();
    let active = 0, maximum = 0;
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (!f.keys.has(args[1])) return get(...args);
      counts.set(args[1], (counts.get(args[1]) ?? 0) + 1); maximum = Math.max(maximum, ++active);
      try { const value = await get(...args); value.stream.once("close", () => { active--; }); return value; }
      catch (error) { active--; throw error; }
    });
    await expect(parent(f)).resolves.toMatchObject({ applied: true });
    expect(maximum).toBeLessThanOrEqual(2); expect([...counts.values()]).toEqual([1, 1, 1, 1]); expect(active).toBe(0);
    for (const child of f.descendants) expect(await fs.readFile(path.join(child.cwd!, "untracked.txt"), "utf8")).toBe(child.name);
  }, 60_000);
  it.each([null, '""', 'W/"weak"'])("uses full authenticated verification when the provider ETag is %s", async etag => {
    const f = await imported(), get = storage.getObject.bind(storage), counts = new Map<string, number>();
    for (const key of f.keys) headEtags.set(key, etag);
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (f.keys.has(args[1])) counts.set(args[1], (counts.get(args[1]) ?? 0) + 1);
      return get(...args);
    });
    await expect(parent(f)).resolves.toMatchObject({ applied: true }); expect([...counts.values()]).toEqual([2, 2]);
  }, 60_000);
  it.each(["before", "after"] as const)("keeps full verification available when HEAD fails %s the readback", async phase => {
    const f = await imported(), get = storage.getObject.bind(storage), key = f.snapshots[0].objectKey!; let reads = 0;
    headFailures.set(key, () => reads === (phase === "before" ? 0 : 1));
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (args[1] === key) reads++;
      return get(...args);
    });
    await expect(parent(f)).resolves.toMatchObject({ applied: true }); expect(reads).toBe(2);
  }, 60_000);
  it("preserves caller cancellation during a failed HEAD without starting payload readback", async () => {
    const f = await imported(), get = storage.getObject.bind(storage), controller = new AbortController(); let reads = 0;
    for (const key of f.keys) headFailures.set(key, () => { controller.abort(new Error("caller_stopped_during_head")); return true; });
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (f.keys.has(args[1])) reads++;
      return get(...args);
    });
    await expect(parent(f, controller.signal)).rejects.toThrow(); expect(reads).toBe(0);
    expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.parent.id)))[0].metadata)).toBeNull();
  }, 60_000);
  it.each(["etag", "reference", "ciphertext", "local-source"] as const)("rechecks a changed %s after the parent capture", async change => {
    const f = await imported(), put = storage.putFile.bind(storage), get = storage.getObject.bind(storage), counts = new Map<string, number>();
    const snapshot = f.snapshots[0];
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (f.keys.has(args[1])) counts.set(args[1], (counts.get(args[1]) ?? 0) + 1);
      return get(...args);
    });
    vi.spyOn(storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      if (change === "etag") headEtags.set(snapshot.objectKey!, '"replacement-version"');
      if (change === "reference") await db.update(executionWorkspaceSnapshots).set({ sha256: "00".repeat(32) }).where(eq(executionWorkspaceSnapshots.id, snapshot.id));
      if (change === "ciphertext") {
        const file = path.join(home, "objects", snapshot.objectKey!), bytes = await fs.readFile(file); bytes[0] ^= 1; await fs.writeFile(file, bytes);
      }
      if (change === "local-source") await fs.writeFile(path.join(f.leaves[0].cwd!, "new-work.txt"), "newer work must remain local\n");
      return result;
    });
    if (change === "etag") {
      await expect(parent(f)).resolves.toMatchObject({ applied: true }); expect(counts.get(snapshot.objectKey!)).toBe(2);
    } else {
      await expect(parent(f)).rejects.toThrow(change === "local-source" ? "nested_workspace_source_changed" : "object_hash_mismatch");
      expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.parent.id)))[0].metadata)).toBeNull();
      if (change === "local-source") expect([...counts.values()]).toEqual([1, 1]);
    }
    for (const child of f.leaves) expect(await fs.readFile(path.join(child.cwd!, "untracked.txt"), "utf8")).toBe(`${child.name} untracked work\n`);
  }, 60_000);
  it.each(["failure", "cancel"] as const)("joins active grandchild peers and retains the source fence on %s", async mode => {
    const f = await imported(true), get = storage.getObject.bind(storage), controller = new AbortController();
    let entered = 0, announce!: () => void, release!: () => void;
    const both = new Promise<void>(resolve => { announce = resolve; }), peer = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (!f.keys.has(args[1])) return get(...args);
      const index = ++entered;
      if (index === 2) { if (mode === "cancel") controller.abort(new Error("caller_stop")); announce(); }
      await both;
      if (index === 1 && mode === "failure") throw new Error("child_readback_failed");
      await peer; throw new Error("peer_finished_after_abort");
    });
    let settled = false;
    const pending = parent(f, AbortSignal.any([controller.signal, AbortSignal.timeout(50_000)]))
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    const other = createDb(database.connectionString, { maxConnections: 1 });
    try {
      await both; await new Promise(resolve => setTimeout(resolve, 25)); expect(settled).toBe(false); expect(entered).toBe(2);
      await expect(withWorkspaceSourceLocks(other, { companyId: f.companyId, projectIds: [f.projectId] }, async () => true, true))
        .rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
    } finally { release(); await other.$client.end({ timeout: 1 }); }
    expect(await pending).toHaveProperty("error");
    expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.parent.id)))[0].metadata)).toBeNull();
  }, 60_000);
  it("refuses a verifier inherited from a different actual source-owner transaction", async () => {
    const f = await imported(); let verifier!: ReturnType<typeof createNestedWorkspaceImportVerifier>;
    await withWorkspaceSourceLocks(db, { companyId: f.companyId, projectIds: [f.projectId] }, async sourceLock => {
      verifier = createNestedWorkspaceImportVerifier({ db, storage, companyId: f.companyId, projectIds: [f.projectId], issueIds: [], sourceLock });
    });
    try {
      await withWorkspaceSourceLocks(db, { companyId: f.companyId, projectIds: [f.projectId] }, async () => {
        await expect(verifier.prepare({ workspace: f.parent, scratch: home, recordedChildren: [] })).rejects.toThrow("nested_workspace_source_fence_changed");
      });
    } finally { await verifier.close(); }
    await expect(verifier.prepare({ workspace: f.parent, scratch: home, recordedChildren: [] })).rejects.toThrow("nested_workspace_verifier_unavailable");
  }, 60_000);
  it("shares immutable proof across declared aliases inside one complete source fence", async () => {
    const f = await imported(), get = storage.getObject.bind(storage), counts = new Map<string, number>();
    storage = { ...storage, immutableObjectNamespace: storageNamespace };
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, projectId: f.projectId, title: "Parent alias" }).returning();
    const [alias] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: f.projectId,
      sourceIssueId: issue.id, name: "Parent alias", mode: "shared_workspace", strategyType: "project_primary", providerType: "local_fs",
      cwd: f.root, providerRef: f.root, repoUrl: f.parent.repoUrl, branchName: "main" }).returning();
    const source = await inspectOnlineWorkspaceSource(db, f.parent); expect(source).not.toBeNull();
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (f.keys.has(args[1])) counts.set(args[1], (counts.get(args[1]) ?? 0) + 1);
      return get(...args);
    });
    await withWorkspaceSourceLocks(db, { companyId: f.companyId, projectIds: source!.projectIds, issueIds: source!.issueIds }, async sourceLock => {
      for (const workspaceId of source!.workspaceIds) expect(await tryAcquireExecutionWorkspaceLifecycleLock(sourceLock, workspaceId)).toBe(true);
      expect(await lockOnlineLegacyWorkspaceRecoverySources(sourceLock as unknown as Db, { companyId: f.companyId,
        sources: source!.companions.flatMap(proof => proof.sources), holds: source!.companions.flatMap(proof => proof.holds) })).toBe(true);
      const verifier = createNestedWorkspaceImportVerifier({ db, storage, companyId: f.companyId, sourceLock,
        projectIds: source!.projectIds, issueIds: source!.issueIds });
      try {
        const first = path.join(home, "first-alias"), second = path.join(home, "second-alias"); await fs.mkdir(first); await fs.mkdir(second);
        const children = await verifier.prepare({ workspace: f.parent, scratch: first, gitSourceRoots: source!.gitSourceRoots });
        expect(await verifier.prepare({ workspace: alias, scratch: second, recordedChildren: children,
          gitSourceRoots: source!.gitSourceRoots })).toEqual(children);
      } finally { await verifier.close(); }
    });
    expect([...counts.values()]).toEqual([1, 1]);
    expect((await db.select().from(executionWorkspaceSnapshots)).every(row => !row.metadata?.nestedImportVerification)).toBe(true);
  }, 60_000);
});
