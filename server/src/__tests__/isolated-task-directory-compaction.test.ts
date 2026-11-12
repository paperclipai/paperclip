import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, executionWorkspaceRestorePoints, executionWorkspaces, issues,
  workspaceRuntimeServices } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { issueService } from "../services/issues.js";
import { materializeIsolatedTaskDirectory } from "../services/isolated-task-directory.js";
import { readTaskDirectoryRetention, TASK_DIRECTORY_RETRY_MS } from "../services/isolated-task-directory-retention.js";
import { getStorageService } from "../storage/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const exists = (target: string) => fs.lstat(target).then(() => true, () => false);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
  "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("isolated task directory compaction after task closure", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("isolated-task-directory-compaction-");
    db = createDb(database.connectionString);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-task-directory-compaction-")));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "31".repeat(32));
  });
  afterEach(async () => {
    await db.delete(executionWorkspaceRestorePoints);
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await fs.rm(path.join(root, "home", "instances", "default", "isolated-workspaces"), { recursive: true, force: true });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.$client.end({ timeout: 1 }); await database.cleanup(); await fs.rm(root, { recursive: true, force: true });
  });

  // A shared task directory with a repository the agent cloned into it. The
  // clone ignores its installed dependencies and build output.
  async function fixture(options: { generatedFiles?: number } = {}) {
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Compaction fixture", issuePrefix: `TC${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture agent" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Task", status: "in_progress" });
    const cwd = await materializeIsolatedTaskDirectory({ companyId, issueId });
    const repo = path.join(cwd, "repo");
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    git(repo, "init", "-q");
    await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
    await fs.writeFile(path.join(repo, "package.json"), "{\"name\":\"fixture\"}\n");
    await fs.writeFile(path.join(repo, "src", "index.ts"), "export const value = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    await fs.writeFile(path.join(repo, "src", "unpushed.ts"), "export const draft = 2;\n");
    await fs.mkdir(path.join(repo, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    await fs.mkdir(path.join(repo, "dist"), { recursive: true });
    await fs.writeFile(path.join(repo, "dist", "index.js"), "exports.value = 1;\n");
    // Outside every checkout nothing proves a directory is regenerable.
    await fs.mkdir(path.join(cwd, "notes", "node_modules"), { recursive: true });
    await fs.writeFile(path.join(cwd, "notes", "node_modules", "keep.txt"), "kept\n");
    await fs.writeFile(path.join(cwd, "report.md"), "final report\n");
    if (options.generatedFiles) {
      const generated = path.join(repo, "src", "generated");
      await fs.mkdir(generated);
      await Promise.all(Array.from({ length: options.generatedFiles }, (_, index) =>
        fs.writeFile(path.join(generated, `${index}.ts`), `export const n = ${index};\n`)));
    }
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, mode: "shared_workspace",
      strategyType: "project_primary", name: "Fixture", status: "active", providerType: "local_fs", cwd,
      metadata: { source: "task_session", createdByRuntime: false } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    const row = () => db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)).then(rows => rows[0]!);
    const close = (status: "done" | "cancelled") => issueService(db).update(issueId, { status });
    const later = (ms = 2 * DAY_MS) => () => new Date(Date.now() + ms);
    const service = (overrides: Parameters<typeof executionWorkspaceService>[1] = {}) => executionWorkspaceService(db, {
      workspaceCompactionDelayMs: HOUR_MS, workspaceReaperCooldownDays: 30, now: later(), ...overrides });
    const removedActivity = () => db.select().from(activityLog).where(and(eq(activityLog.entityId, workspaceId),
      eq(activityLog.action, "execution_workspace.regenerable_files_removed")));
    return { companyId, issueId, workspaceId, agentId, cwd, repo, row, close, later, service, removedActivity };
  }

  async function expectSourceKept(f: Awaited<ReturnType<typeof fixture>>) {
    expect(await fs.readFile(path.join(f.repo, "src", "index.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await fs.readFile(path.join(f.repo, "src", "unpushed.ts"), "utf8")).toBe("export const draft = 2;\n");
    expect(await exists(path.join(f.repo, ".git", "HEAD"))).toBe(true);
    expect(await fs.readFile(path.join(f.cwd, "report.md"), "utf8")).toBe("final report\n");
    expect(await fs.readFile(path.join(f.cwd, "notes", "node_modules", "keep.txt"), "utf8")).toBe("kept\n");
  }

  async function expectRegenerableKept(f: Awaited<ReturnType<typeof fixture>>) {
    expect(await exists(path.join(f.repo, "node_modules", "dep", "index.js"))).toBe(true);
    expect(await exists(path.join(f.repo, "dist", "index.js"))).toBe(true);
  }

  // A separate repository inside the clone, under a path the clone ignores,
  // with source and history that exist nowhere else.
  async function addNestedRepository(f: Awaited<ReturnType<typeof fixture>>) {
    const nested = path.join(f.repo, "build");
    await fs.appendFile(path.join(f.repo, ".gitignore"), "build/\n");
    await fs.mkdir(nested);
    git(nested, "init", "-q");
    await fs.writeFile(path.join(nested, "source.txt"), "unique source");
    git(nested, "add", ".");
    git(nested, "commit", "-q", "-m", "unpublished source");
    return nested;
  }

  it.each(["done", "cancelled"] as const)("removes a cloned repository's ignored dependencies after the task is %s", async (status) => {
    const f = await fixture();
    const nested = await addNestedRepository(f);
    await f.close(status);
    const result = await f.service().sweepTerminalWorkspaces();
    expect(result).toMatchObject({ compacted: 1, compactionFailed: 0 });
    expect(await exists(path.join(f.repo, "node_modules"))).toBe(false);
    expect(await exists(path.join(f.repo, "dist"))).toBe(false);
    await expectSourceKept(f);
    expect(await fs.readFile(path.join(nested, "source.txt"), "utf8")).toBe("unique source");
    expect(git(nested, "log", "--format=%s").toString().trim()).toBe("unpublished source");
    // The row still describes a present, reusable directory.
    expect(await f.row()).toMatchObject({ status: "active", closedAt: null, cwd: f.cwd });
    expect(await exists(f.cwd)).toBe(true);
    expect((await f.removedActivity()).map(entry => entry.details)).toEqual([
      expect.objectContaining({ sourceIssueId: f.issueId, removedPaths: ["repo/dist", "repo/node_modules"] })]);
    expect(await fs.readdir(path.join(f.cwd, "..", ".paperclip-compaction-trash")).catch(() => [])).toEqual([]);
  });

  it("applies each nested checkout's own rules, not the outer checkout's", async () => {
    const f = await fixture();
    const inner = path.join(f.repo, "libs", "inner");
    await fs.mkdir(path.join(inner, "node_modules"), { recursive: true });
    git(inner, "init", "-q");
    await fs.writeFile(path.join(inner, ".gitignore"), "dist/\n");
    // The outer checkout ignores node_modules/, but the inner one tracks it.
    await fs.writeFile(path.join(inner, "node_modules", "vendored.js"), "tracked\n");
    git(inner, "add", ".");
    git(inner, "commit", "-q", "-m", "inner");
    await fs.mkdir(path.join(inner, "dist"));
    await fs.writeFile(path.join(inner, "dist", "out.js"), "built\n");
    await f.close("done");
    expect(await f.service().sweepTerminalWorkspaces()).toMatchObject({ compacted: 1, compactionFailed: 0 });
    expect(await fs.readFile(path.join(inner, "node_modules", "vendored.js"), "utf8")).toBe("tracked\n");
    expect(await exists(path.join(inner, "dist"))).toBe(false);
    expect(await exists(path.join(f.repo, "node_modules"))).toBe(false);
    await expectSourceKept(f);
  });

  it("removes regenerable files of a directory too large to save before deletion, and keeps the rest", async () => {
    const f = await fixture({ generatedFiles: 20_001 });
    await f.close("done");
    const result = await f.service({ now: f.later(4 * DAY_MS),
      taskDirectoryRetention: { dryRun: false, terminalDelayMs: 3 * DAY_MS, orphanGraceMs: 7 * DAY_MS },
      gitRestorePoints: { storage: getStorageService(), terminalDelayMs: 3 * DAY_MS, keyDurable: true } }).sweepTerminalWorkspaces();
    expect(result).toMatchObject({ compacted: 1, archived: 0 });
    expect(await exists(path.join(f.repo, "node_modules"))).toBe(false);
    await expectSourceKept(f);
    expect(await exists(path.join(f.repo, "src", "generated", "20000.ts"))).toBe(true);
    const row = await f.row();
    expect(row).toMatchObject({ status: "active", closedAt: null });
    expect(readTaskDirectoryRetention(row)).toBeNull();
  }, 60_000);

  it("keeps a shared directory that an open task still uses", async () => {
    const f = await fixture();
    await db.insert(issues).values({ companyId: f.companyId, title: "Other task on the same directory", status: "in_progress",
      executionWorkspaceId: f.workspaceId });
    await f.close("done");
    const service = f.service();
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerableKept(f);
    await expectSourceKept(f);
  });

  const RETENTION = { dryRun: false, terminalDelayMs: 3 * DAY_MS, orphanGraceMs: 7 * DAY_MS };

  it.each([false, true])("keeps a directory that a registered runtime service runs from, and checks again later (retention %s)", async (retention) => {
    const f = await fixture();
    await db.insert(workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId, scopeType: "execution_workspace",
      serviceName: "web", status: "running", lifecycle: "shared", provider: "local_process", executionWorkspaceId: f.workspaceId,
      cwd: f.repo });
    await f.close("done");
    const now = f.later();
    const service = f.service({ now, ...(retention ? { taskDirectoryRetention: RETENTION } : {}) });
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0, compactionFailed: 0 });
    await expectRegenerableKept(f);
    // The deferral stays scheduled instead of being forgotten, and is not
    // replaced by a deadline that has already passed.
    const next = await service.nextTerminalWorkspaceSweepAt();
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now().getTime() + TASK_DIRECTORY_RETRY_MS - 60_000);
    expect(next!).toBeLessThanOrEqual(now().getTime() + TASK_DIRECTORY_RETRY_MS + 60_000);

    await db.update(workspaceRuntimeServices).set({ status: "stopped" }).where(eq(workspaceRuntimeServices.executionWorkspaceId, f.workspaceId));
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ compacted: 1 });
    expect(await exists(path.join(f.repo, "node_modules"))).toBe(false);
  });

  it.each([false, true])("waits a day after closure before touching a task directory (retention %s)", async (retention) => {
    const f = await fixture();
    await f.close("cancelled");
    const now = f.later(2 * HOUR_MS);
    const service = f.service({ now, ...(retention ? { taskDirectoryRetention: RETENTION } : {}) });
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0 });
    await expectRegenerableKept(f);
    const next = await service.nextTerminalWorkspaceSweepAt();
    expect(next!).toBeGreaterThan(now().getTime() + TASK_DIRECTORY_RETRY_MS - 60_000);
    expect(next!).toBeLessThanOrEqual(now().getTime() + TASK_DIRECTORY_RETRY_MS + 60_000);
  });

  it("reports a failed compaction, keeps the files, and retries on the next sweep", async () => {
    const f = await fixture();
    await fs.rm(path.join(f.repo, ".git"), { recursive: true, force: true });
    await fs.writeFile(path.join(f.repo, ".git"), "gitdir: /nonexistent/repository\n");
    await f.close("done");
    const service = f.service();
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0, compactionFailed: 1 });
    expect(await service.sweepTerminalWorkspaces()).toMatchObject({ compacted: 0, compactionFailed: 1 });
    await expectRegenerableKept(f);
    expect(await f.row()).toMatchObject({ status: "active" });
  });
});
