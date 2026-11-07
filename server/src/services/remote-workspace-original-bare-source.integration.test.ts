import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, heartbeatRuns, executionWorkspaceSnapshots, executionWorkspaces, issues, projects, projectWorkspaces, workspaceOperations } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { inspectArchivedGitMigrationSource } from "./remote-workspace-migration-git.js";
import { inventoryRemoteWorkspaceMigration, migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { cleanupExecutionWorkspaceArtifacts } from "./workspace-runtime.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { isolatedRemoteSourcePath } from "./isolated-remote-workspace-source.js";
import { managedSourcePaths } from "./git-workspace-restoration.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-C", cwd, ...args], { env: { ...process.env,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_EMAIL: "fixture@example.test" } })).stdout.trim();
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string, storage: StorageService;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("original-bare-source-"); db = createDb(database.connectionString); }, 90_000);
beforeEach(async () => { root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "original-bare-source-")));
  vi.stubEnv("PAPERCLIP_HOME", root); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default"); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
  storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "objects"))); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await db.delete(activityLog); await db.delete(workspaceOperations);
  await db.delete(executionWorkspaceSnapshots); await db.delete(heartbeatRuns); await db.delete(issues); await db.delete(agents); await db.delete(executionWorkspaces); await db.delete(projectWorkspaces);
  await db.delete(projects); await db.delete(companies); await fs.rm(root, { recursive: true, force: true }); });
afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
async function manifest(base: string, prefix = ""): Promise<Array<{ path: string; mode: number; sha256: string }>> {
  const entries = [];
  for (const name of (await fs.readdir(path.join(base, prefix))).sort()) {
    const relative = path.join(prefix, name), file = path.join(base, relative), stat = await fs.lstat(file);
    if (stat.isDirectory()) entries.push(...await manifest(base, relative));
    else entries.push({ path: relative, mode: stat.mode & 0o777, sha256: createHash("sha256").update(await fs.readFile(file)).digest("hex") });
  }
  return entries;
}
async function fixture() {
  const companyId = randomUUID(), projectId = randomUUID(), projectWorkspaceId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
  const seed = path.join(root, "seed"), original = path.join(resolvePaperclipInstanceRoot(), "acceptance", "original", "main.git");
  await fs.mkdir(seed, { recursive: true }); await fs.mkdir(path.dirname(original), { recursive: true });
  await git(seed, "init", "-q", "--initial-branch=main");
  await fs.writeFile(path.join(seed, "README.md"), "preserve exact original bytes\n");
  await fs.writeFile(path.join(seed, "run.sh"), "#!/bin/sh\necho retained\n", { mode: 0o755 });
  await git(seed, "add", "."); await git(seed, "commit", "-qm", "retained original");
  const commit = await git(seed, "rev-parse", "HEAD"); await git(root, "clone", "--bare", "--no-hardlinks", seed, original);
  const repoUrl = pathToFileURL(original).href, base = isolatedRemoteSourcePath(companyId, issueId), branchName = "closed-acceptance";
  await fs.mkdir(path.dirname(base), { recursive: true }); await git(root, "clone", "--no-hardlinks", original, base);
  await git(base, "remote", "set-url", "origin", repoUrl);
  const cwd = path.join(base, ".paperclip", "worktrees", branchName); await git(base, "worktree", "add", "-qb", branchName, cwd);
  await db.insert(companies).values({ id: companyId, name: "Original repository", issuePrefix: "BARE" });
  await db.insert(projects).values({ id: projectId, companyId, name: "Original source" });
  await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Recorded source", cwd: null, repoUrl });
  await db.insert(issues).values({ id: issueId, companyId, title: "Closed task", status: "done" });
  const [workspace] = await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, projectWorkspaceId, sourceIssueId: issueId,
    mode: "isolated_workspace", strategyType: "git_worktree", providerType: "git_worktree", name: "Closed checkout", status: "archived", closedAt: new Date(),
    cwd, providerRef: cwd, branchName, repoUrl, baseRef: "main", metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1, baseRefSha: commit,
      lifecycleGeneration: 1, isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1", companyId, issueId, repoUrl } } }).returning();
  const cleaned = await cleanupExecutionWorkspaceArtifacts({ workspace: workspace!, projectWorkspace: { cwd: base, cleanupCommand: null }, runCleanupCommands: false,
    recorder: workspaceOperationService(db).createRecorder({ companyId, executionWorkspaceId: workspaceId, issueId }) });
  expect(cleaned.warnings).toEqual([]); await fs.rm(base, { recursive: true }); await fs.rm(seed, { recursive: true });
  expect((await git(original, "rev-list", "--objects", "--no-object-names", "--all")).split("\n")).toHaveLength(4);
  return { companyId, projectId, projectWorkspaceId, issueId, workspaceId, original, base, cwd, branchName, repoUrl, commit, workspace: workspace! };
}
it("imports the exact deleted commit from its surviving recorded original bare source and cold-restores its encrypted files", async () => {
  const f = await fixture(), before = await manifest(f.original);
  expect((await inspectArchivedGitMigrationSource(db, f.workspace))?.commit).toBe(f.commit);
  expect((await inventoryRemoteWorkspaceMigration(db, f)).eligible).toBe(true);
  await migrateRemoteWorkspace({ db, storage, ...f, apply: true });
  const row = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0]!;
  const authority = readRemoteWorkspaceAuthority(row.metadata)!;
  expect(authority.source).toMatchObject({ kind: "git", ref: f.commit }); expect(row.status).toBe("archived"); expect(row.cwd).toBe(`/workspaces/${f.workspaceId}`); expect(row.sourceIssueId).toBe(f.issueId);
  const reference = (await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! }))!;
  const cipher = await storage.getObject(f.companyId, reference.objectKey), parts: Buffer[] = [];
  for await (const part of cipher.stream) parts.push(Buffer.from(part));
  const encrypted = Buffer.concat(parts);
  expect(encrypted.subarray(0, 7).toString()).toBe("PCWSE1\n"); expect(encrypted.includes(Buffer.from("preserve exact original bytes"))).toBe(false);
  const archivePath = path.join(root, "downloaded.pcws"), targetDir = path.join(root, "cold-restored");
  const parked = path.join(root, "parked-original.git"); await fs.rename(f.original, parked);
  try {
    expect(await fs.lstat(f.original).catch(() => null)).toBeNull();
    await loadWorkspaceSnapshotArchive({ storage, reference, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: reference.manifestDigest });
  } finally { await fs.rename(parked, f.original); }
  expect(await fs.readFile(path.join(targetDir, "README.md"), "utf8")).toBe("preserve exact original bytes\n");
  expect(await fs.readFile(path.join(targetDir, "run.sh"), "utf8")).toBe("#!/bin/sh\necho retained\n");
  expect((await fs.lstat(path.join(targetDir, "run.sh"))).mode & 0o777).toBe(0o755);
  expect(await git(targetDir, "rev-parse", "HEAD")).toBe(f.commit); expect(await git(targetDir, "log", "--format=%H")).toBe(f.commit);
  expect(await manifest(f.original)).toEqual(before); expect(await fs.lstat(f.cwd).catch(() => null)).toBeNull();
});

it.each(["wrong-full-tip", "wrong-project-source", "missing-receipt", "wrong-receipt", "wrong-receipt-path", "reopened", "active-writer", "source-alias", "object-alias", "unsafe-config", "outside-instance", "present-primary", "unknown-primary"])("refuses %s without publishing", async kind => {
  const f = await fixture();
  if (kind === "wrong-full-tip") await db.update(executionWorkspaces).set({ metadata: { ...f.workspace.metadata, baseRefSha: "f".repeat(40) } }).where(eq(executionWorkspaces.id, f.workspaceId));
  if (kind === "wrong-project-source") await db.update(projectWorkspaces).set({ repoUrl: "https://example.invalid/other.git" }).where(eq(projectWorkspaces.id, f.projectWorkspaceId));
  const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.workspaceId));
  const deletion = operations.find(row => row.metadata?.cleanupAction === "branch_delete")!;
  if (kind === "missing-receipt") await db.delete(workspaceOperations).where(eq(workspaceOperations.id, deletion.id));
  if (kind === "wrong-receipt") await db.update(workspaceOperations).set({ stdoutExcerpt: "Deleted branch other (was 1234567)." }).where(eq(workspaceOperations.id, deletion.id));
  if (kind === "wrong-receipt-path") await db.update(workspaceOperations).set({ metadata: { ...deletion.metadata, workspacePath: f.original } }).where(eq(workspaceOperations.id, deletion.id));
  if (kind === "reopened") await db.update(executionWorkspaces).set({ status: "active", closedAt: null }).where(eq(executionWorkspaces.id, f.workspaceId));
  if (kind === "active-writer") { const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Existing writer" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, issueId: f.issueId, status: "running" }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, f.issueId)); }
  if (kind === "source-alias") { const original = f.original + ".retained"; await fs.rename(f.original, original); await fs.symlink(original, f.original); }
  if (kind === "object-alias") { const objects = path.join(f.original, "objects"), retained = path.join(root, "retained-objects"); await fs.rename(objects, retained); await fs.symlink(retained, objects); }
  if (kind === "unsafe-config") await git(f.original, "config", "uploadpack.packObjectsHook", "exit 97");
  if (kind === "outside-instance") { const original = path.join(root, "outside.git"); await fs.rename(f.original, original); const repoUrl = pathToFileURL(original).href;
    await db.update(projectWorkspaces).set({ repoUrl }).where(eq(projectWorkspaces.id, f.projectWorkspaceId));
    await db.update(executionWorkspaces).set({ repoUrl, metadata: { ...f.workspace.metadata, isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1", companyId: f.companyId, issueId: f.issueId, repoUrl } } }).where(eq(executionWorkspaces.id, f.workspaceId)); }
  const primary = managedSourcePaths(f.workspace)[0]!;
  if (kind === "present-primary") { await fs.mkdir(path.join(primary, ".git"), { recursive: true }); await fs.writeFile(path.join(primary, "keep.txt"), "unknown primary files"); }
  if (kind === "unknown-primary") { const stat = fs.lstat.bind(fs); vi.spyOn(fs, "lstat").mockImplementation(async (...args) => { if (String(args[0]) === primary) throw Object.assign(new Error("not readable"), { code: "EACCES" }); return stat(...args); }); }
  const put = vi.spyOn(storage, "putFile");
  expect((await inventoryRemoteWorkspaceMigration(db, f)).eligible).toBe(false);
  await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow();
  expect(put).not.toHaveBeenCalled(); expect(readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0]!.metadata)).toBeNull();
});
it.each(["changed-ref", "changed-source-row", "changed-cleanup"])("preserves the uploaded object without authority when %s changes before publication", async kind => {
  const f = await fixture(), put = storage.putFile.bind(storage); let changed = false;
  storage.putFile = async input => { const result = await put(input); if (!changed) { changed = true;
    if (kind === "changed-ref") { const tree = await git(f.original, "rev-parse", f.commit + "^{tree}");
      const newer = await git(f.original, "commit-tree", tree, "-p", f.commit, "-m", "newer ref"); await git(f.original, "update-ref", "refs/heads/main", newer); }
    if (kind === "changed-source-row") await db.update(projectWorkspaces).set({ repoUrl: "https://example.invalid/changed.git" }).where(eq(projectWorkspaces.id, f.projectWorkspaceId));
    if (kind === "changed-cleanup") { const rows = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.workspaceId));
      const deletion = rows.find(row => row.metadata?.cleanupAction === "branch_delete")!; await db.update(workspaceOperations).set({ stdoutExcerpt: "Changed receipt" }).where(eq(workspaceOperations.id, deletion.id)); }
  } return result; };
  await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow(); expect(changed).toBe(true);
  const row = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0]!; expect(readRemoteWorkspaceAuthority(row.metadata)).toBeNull();
  const snapshots = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.workspaceId));
  expect(snapshots).toHaveLength(1); expect(snapshots[0]!.status).toBe("uploaded"); expect(snapshots[0]!.objectKey).toBeTruthy();
});
it("reuses the same authenticated uploaded snapshot after losing the original local-source upload reply", async () => {
  const f = await fixture(), put = storage.putFile.bind(storage); let lost = false;
  storage.putFile = async input => { const result = await put(input); if (!lost) { lost = true; throw new Error("upload_ack_lost"); } return result; };
  await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("upload_ack_lost");
  const pending = (await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.workspaceId)))[0]!;
  expect(pending.status).toBe("pending");
  const result = await migrateRemoteWorkspace({ db, storage, ...f, apply: true }); expect(result.applied).toBe(true);
  const snapshots = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.workspaceId));
  expect(snapshots).toHaveLength(1); expect(snapshots[0]!.id).toBe(pending.id); expect(snapshots[0]!.sourceOperationId).toBe(pending.sourceOperationId);
  const reference = (await getWorkspaceSnapshot(db, { ...f, snapshotId: pending.id }))!, archivePath = path.join(root, "retry.pcws"), targetDir = path.join(root, "retry-restored");
  await loadWorkspaceSnapshotArchive({ storage, reference, targetPath: archivePath });
  await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: reference.manifestDigest });
  expect(await git(targetDir, "rev-parse", "HEAD")).toBe(f.commit);
  expect(await fs.readFile(path.join(targetDir, "README.md"), "utf8")).toBe("preserve exact original bytes\n");
});

it.each(["private", "generated", "hashed"].flatMap(primary => ["directory", "alias", "unreadable"].flatMap(state => ["retry", "publication"].map(boundary => ({ primary, state, boundary })))))
("refuses returned primary $primary $state at $boundary without losing either copy", async ({ primary, state, boundary }) => {
  const f = await fixture(), put = storage.putFile.bind(storage);
  const target = primary === "private" ? f.base : managedSourcePaths(f.workspace)[primary === "generated" ? 0 : 1]!;
  const retained = state === "alias" ? path.join(root, "returned-primary") : target;
  const restorePrimary = async () => {
    await fs.mkdir(path.dirname(retained), { recursive: true }); await git(root, "clone", "--no-hardlinks", f.original, retained);
    await fs.writeFile(path.join(retained, "retained-edit.txt"), "returned primary work must survive\n");
    if (state === "alias") { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.symlink(retained, target); }
    if (state === "unreadable") { const stat = fs.lstat.bind(fs); vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (String(args[0]) === target) throw Object.assign(new Error("primary unreadable"), { code: "EACCES" }); return stat(...args);
    }); }
  };
  let uploaded = false, uploadedKey: string | null = null, uploadedSha256: string | null = null;
  storage.putFile = async input => { const result = await put(input); uploadedKey = result.objectKey; uploadedSha256 = result.sha256; if (!uploaded) { uploaded = true;
    if (boundary === "retry") throw new Error("upload_ack_lost"); await restorePrimary();
  } return result; };
  if (boundary === "retry") { await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("upload_ack_lost"); await restorePrimary(); }
  const snapshotsBefore = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.workspaceId));
  await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow();
  const row = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId)))[0]!;
  expect(readRemoteWorkspaceAuthority(row.metadata)).toBeNull();
  expect(await fs.readFile(path.join(retained, "retained-edit.txt"), "utf8")).toBe("returned primary work must survive\n");
  const snapshots = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.workspaceId));
  expect(snapshots).toHaveLength(1); if (boundary === "retry") expect(snapshots[0]!.id).toBe(snapshotsBefore[0]!.id);
  expect(uploadedKey).toBeTruthy(); if (boundary === "retry") expect(snapshots[0]!.objectKey).toBeNull(); else expect(snapshots[0]!.objectKey).toBe(uploadedKey);
  const cipher = await storage.getObject(f.companyId, uploadedKey!), hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of cipher.stream) { bytes += Buffer.byteLength(chunk); hash.update(chunk); }
  expect(bytes).toBeGreaterThan(0); expect(hash.digest("hex")).toBe(uploadedSha256);
  expect(await git(f.original, "rev-parse", "HEAD")).toBe(f.commit);
});
