import { execFile } from "node:child_process";
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
  }, 60_000);
});
