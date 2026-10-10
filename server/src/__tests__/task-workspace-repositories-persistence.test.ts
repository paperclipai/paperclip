import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath, open, lstat, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, createDb, executionWorkspaces, executionWorkspaceRepositories, issues } from "@paperclipai/db";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { executionWorkspaceRepositoryService } from "../services/execution-workspace-repositories.js";
import { listLocalProjectRepositories } from "@paperclipai/adapter-utils/ssh";
import { readManagedWorkspaceRepositories, disposeGitWorkspaceSnapshot } from "@paperclipai/adapter-utils/git-workspace-sync";
import { captureDirectorySnapshot, disposeDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const catalog = vi.hoisted(() => ({ available: true }));
vi.mock("../services/tool-access.js", () => ({ toolAccessService: () => ({ listProjectRepositories: async () => ({ repositories: catalog.available ? [{ id: "123", fullName: "team/source", url: "https://github.com/team/source", connections: [] }] : [] }) }) }));
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable task repository receipts", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string, issueId: string, workspaceId: string, agentId: string, cwd: string;
  const actor = { type: "board" as const, source: "local_implicit" as const, userId: "local-board" };
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-task-repositories-");
    db = createDb(temporary.connectionString);
    cwd = await mkdtemp(path.join(tmpdir(), "paperclip-task-repositories-files-"));
    [companyId] = (await db.insert(companies).values({ name: "Task repositories", issuePrefix: "TREPO" }).returning()).map(row => row.id);
    [agentId] = (await db.insert(agents).values({ companyId, name: "Repository worker", adapterType: "process", status: "idle" }).returning()).map(row => row.id);
    [workspaceId] = (await db.insert(executionWorkspaces).values({ companyId, projectId: null, name: "Task files", cwd, mode: "shared_workspace", strategyType: "task_directory" }).returning()).map(row => row.id);
    [issueId] = (await db.insert(issues).values({ companyId, title: "Projectless task", executionWorkspaceId: workspaceId }).returning()).map(row => row.id);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { vi.unstubAllEnvs(); await temporary?.cleanup(); if (cwd) await rm(cwd, { recursive: true, force: true }); });
  const request = (requestKey: string, ref?: string) => executionWorkspaceRepositoryService(db).request({ companyId, issueId, actor, request: { repository: { kind: "catalog", id: "123" }, requestKey, ...(ref ? { ref } : {}) } });
  it("publishes a requested repository from an absent path through real admission locking and cloning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-fresh-repository-"));
    const previousPath = process.env.PATH;
    const exec = promisify(execFileCallback);
    try {
      const realGit = (await exec("which", ["git"])).stdout.trim();
      const source = path.join(root, "source"), taskRoot = path.join(root, "task"), bin = path.join(root, "bin");
      await Promise.all([mkdir(source), mkdir(taskRoot), mkdir(bin)]);
      await exec(realGit, ["init", "--initial-branch=main", taskRoot]);
      await writeFile(path.join(taskRoot, "report.txt"), "Task-owned report\n");
      const git = async (...args: string[]) => (await exec(realGit, ["-C", source, ...args])).stdout.trim();
      await git("init", "--initial-branch=main");
      await writeFile(path.join(source, "source.txt"), "original source\n");
      await git("add", ".");
      await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source");
      const pin = await git("rev-parse", "HEAD");
      const cloneStarted = path.join(root, "clone-started"), cloneReleased = path.join(root, "clone-released");
      // Exercise actual Git and atomic publication without external networking.
      // Only this fixture's exact remote is redirected; persist the real API origin.
      await writeFile(path.join(bin, "git"), `#!${process.execPath}\n` +
        `const { spawnSync } = require('node:child_process'); const fs = require('node:fs'); const args = process.argv.slice(2);\n` +
        `const remote = args.includes('clone') ? args.at(-2) : null;\n` +
        `if (remote && remote !== 'https://github.com/team/source') process.exit(97);\n` +
        `if (remote) { fs.writeFileSync(${JSON.stringify(cloneStarted)}, 'started'); const deadline = Date.now() + 10000; while (!fs.existsSync(${JSON.stringify(cloneReleased)})) { if (Date.now() > deadline) process.exit(96); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); } }\n` +
        `if (remote) args[args.length - 2] = ${JSON.stringify(source)};\n` +
        `const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });\n` +
        `if (result.status) process.exit(result.status);\n` +
        `if (remote) process.exit(spawnSync(${JSON.stringify(realGit)}, ['-C', args.at(-1), 'remote', 'set-url', 'origin', remote], { stdio: 'inherit' }).status ?? 98);\n` +
        `process.exit(result.status ?? 99);\n`, { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Fresh task root", cwd: taskRoot,
        mode: "shared_workspace", strategyType: "task_directory" }).returning();
      const [task] = await db.insert(issues).values({ companyId, title: "Fresh repository", executionWorkspaceId: workspace.id }).returning();
      const intent = await executionWorkspaceRepositoryService(db).request({ companyId, issueId: task.id, actor,
        request: { repository: { kind: "catalog", id: "123" }, requestKey: "fresh-repository" } });
      const checkout = path.join(taskRoot, intent.repository.relativePath);
      expect(await lstat(checkout).catch(() => null)).toBeNull();
      const admission = { companyId, issueId: task.id, workspaceId: workspace.id, cwd: taskRoot,
        agentId, runId: randomUUID(), responsibleUserId: "local-board" };
      const [readyWorkspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Shared physical root", cwd: taskRoot,
        mode: "shared_workspace", strategyType: "operator_directory" }).returning();
      const [readyTask] = await db.insert(issues).values({ companyId, title: "Reuse another repository", executionWorkspaceId: readyWorkspace.id }).returning();
      const readyIntent = await executionWorkspaceRepositoryService(db).request({ companyId, issueId: readyTask.id, actor,
        request: { repository: { kind: "url", url: "https://github.com/team/ready" }, requestKey: "ready-repository" } });
      const readyCheckout = path.join(taskRoot, readyIntent.repository.relativePath);
      await mkdir(path.dirname(readyCheckout), { recursive: true });
      await exec(realGit, ["clone", "--no-hardlinks", source, readyCheckout]);
      await exec(realGit, ["-C", readyCheckout, "remote", "set-url", "origin", readyIntent.repository.repoUrl]);
      await db.update(executionWorkspaceRepositories).set({ state: "ready", pinnedCommit: pin })
        .where(eq(executionWorkspaceRepositories.id, readyIntent.operationId));
      // New service instances emulate the controller restart between request
      // and admission; concurrent admissions must publish one owned checkout.
      const pending = Promise.all([1, 2].map(() => executionWorkspaceRepositoryService(db).prepareForAdmission(admission)));
      let results: Awaited<typeof pending>;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await vi.waitFor(async () => expect(await lstat(cloneStarted).catch(() => null)).not.toBeNull());
        const ready = await Promise.race([
          executionWorkspaceRepositoryService(db).prepareForAdmission({ ...admission, workspaceId: readyWorkspace.id, issueId: readyTask.id }),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Unrelated repository reuse waited for a blocked clone")), 2000); }),
        ]);
        expect(ready[0]).toMatchObject({ id: readyIntent.operationId, pinnedCommit: pin });
        // These are the actual SSH and native/sandbox discovery paths while
        // the unrelated clone is incomplete, not inventory-only assertions.
        expect(await listLocalProjectRepositories(taskRoot)).toEqual([readyIntent.repository.relativePath]);
        const snapshots = await readManagedWorkspaceRepositories(taskRoot);
        try { expect(snapshots.map(repo => repo.path)).toEqual([readyIntent.repository.relativePath]); }
        finally { await Promise.all(snapshots.map(repo => disposeGitWorkspaceSnapshot(repo.snapshot))); }
        expect((await readdir(path.join(taskRoot, ".paperclip-runtime", "repository-staging"))).filter(name => name.includes(".clone-")).length).toBe(1);
        expect((await exec(realGit, ["-C", taskRoot, "status", "--porcelain", "--untracked-files=all"])).stdout.trim()).toBe("?? report.txt");
        await exec(realGit, ["-C", taskRoot, "add", "."]);
        expect((await exec(realGit, ["-C", taskRoot, "diff", "--cached", "--name-only"])).stdout.trim()).toBe("report.txt");
        const baseline = await captureDirectorySnapshot(taskRoot, { exclude: [".paperclip-runtime"] });
        try { expect([...baseline.entries.keys()].some(entry => entry.includes("repository-staging") || entry.includes(".clone-"))).toBe(false); }
        finally { await disposeDirectorySnapshot(baseline); }
      } finally {
        clearTimeout(timeout);
        await writeFile(cloneReleased, "released");
        results = await pending;
      }
      for (const prepared of results) expect(prepared).toEqual([expect.objectContaining({ id: intent.operationId, pinnedCommit: pin })]);
      expect(await readFile(path.join(checkout, "source.txt"), "utf8")).toBe("original source\n");
      expect(JSON.parse(await readFile(path.join(checkout, ".git", "paperclip-workspace-owner.json"), "utf8")))
        .toMatchObject({ repositoryId: intent.operationId, pinnedCommit: pin });
      expect((await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.id, intent.operationId)))[0])
        .toMatchObject({ state: "ready", pinnedCommit: pin, failureCode: null });
      await writeFile(path.join(checkout, "source.txt"), "retained dirty work\n");
      await executionWorkspaceRepositoryService(db).prepareForAdmission(admission);
      expect(await readFile(path.join(checkout, "source.txt"), "utf8")).toBe("retained dirty work\n");
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === "win32").each(["parent", "ignore_file"])("rejects a symlinked runtime staging %s before cloning", async (unsafeEntry) => {
    const root = await mkdtemp(path.join(tmpdir(), "paperclip-unsafe-repository-staging-"));
    try {
      const taskRoot = path.join(root, "task"), outside = path.join(root, "outside");
      await mkdir(taskRoot); await mkdir(outside);
      if (unsafeEntry === "parent") await symlink(outside, path.join(taskRoot, ".paperclip-runtime"));
      else {
        const staging = path.join(taskRoot, ".paperclip-runtime", "repository-staging");
        await mkdir(staging, { recursive: true });
        await symlink(outside, path.join(staging, ".gitignore"));
      }
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Unsafe staging", cwd: taskRoot,
        mode: "shared_workspace", strategyType: "task_directory" }).returning();
      const [task] = await db.insert(issues).values({ companyId, title: "Unsafe staging", executionWorkspaceId: workspace.id }).returning();
      await executionWorkspaceRepositoryService(db).request({ companyId, issueId: task.id, actor,
        request: { repository: { kind: "catalog", id: "123" }, requestKey: "unsafe-staging" } });
      await expect(executionWorkspaceRepositoryService(db).prepareForAdmission({ companyId, issueId: task.id,
        workspaceId: workspace.id, cwd: taskRoot, agentId, runId: randomUUID(), responsibleUserId: "local-board" }))
        .rejects.toThrow(unsafeEntry === "parent" ? "staging directory escapes" : "ignore file is not a regular file");
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("converges concurrent requests and persists each retry key without creating a project", async () => {
    const [peerIssue] = await db.insert(issues).values({ companyId, title: "Peer task sharing the root", executionWorkspaceId: workspaceId }).returning();
    await db.update(executionWorkspaces).set({ sourceIssueId: issueId }).where(eq(executionWorkspaces.id, workspaceId));
    const [first, second] = await Promise.all([
      request("one"),
      executionWorkspaceRepositoryService(db).request({ companyId, issueId: peerIssue.id, actor, request: { repository: { kind: "catalog", id: "123" }, requestKey: "two" } }),
    ]);
    expect(first.operationId).toBe(second.operationId);
    expect(first).toMatchObject({ kind: "requires_next_admission", applies: "next_normal_admission" });
    const rows = await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.executionWorkspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].requestKeys.sort()).toEqual(["one", "two"]);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ projectId: null, executionWorkspaceId: workspaceId });
    await expect(request("two", "different-ref")).rejects.toThrow(/conflicts/);
    await expect(executionWorkspaceRepositoryService(db).request({ companyId, issueId, actor, request: { repository: { kind: "url", url: "https://github.com/other/source" }, requestKey: "two" } })).rejects.toThrow(/conflicts/);
  });
  it("rejects cross-company task IDs and revoked catalog permission even with a saved receipt", async () => {
    const [other] = await db.insert(companies).values({ name: "Foreign", issuePrefix: "FOREIGN" }).returning();
    await expect(executionWorkspaceRepositoryService(db).request({ companyId: other.id, issueId, actor, request: { repository: { kind: "catalog", id: "123" }, requestKey: "foreign" } })).rejects.toThrow(/not found/);
    catalog.available = false;
    try {
      await expect(request("one")).rejects.toThrow(/no longer available/);
      await expect(executionWorkspaceRepositoryService(db).prepareForAdmission({ companyId, issueId, workspaceId, cwd, agentId, runId: randomUUID(), responsibleUserId: "local-board" })).rejects.toThrow(/no longer available/);
    } finally { catalog.available = true; }
  });
  it("retains durable ownership when Git bundle restoration omits the temporary receipt", async () => {
    const [inventory] = await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.executionWorkspaceId, workspaceId));
    const checkout = path.join(cwd, inventory.relativePath);
    await mkdir(checkout, { recursive: true });
    const git = async (...args: string[]) => (await promisify(execFileCallback)("git", ["-C", checkout, ...args])).stdout.trim();
    await git("init", "--initial-branch=main");
    await git("remote", "add", "origin", inventory.repoUrl);
    await writeFile(path.join(checkout, "source.txt"), "restored repository\n");
    await git("add", ".");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "restored");
    const commit = await git("rev-parse", "HEAD");
    await db.update(executionWorkspaceRepositories).set({ pinnedCommit: commit, state: "ready" }).where(eq(executionWorkspaceRepositories.id, inventory.id));
    await writeFile(path.join(checkout, "source.txt"), "uncommitted work\n");
    const prepared = await executionWorkspaceRepositoryService(db).prepareForAdmission({ companyId, issueId, workspaceId, cwd, agentId, runId: randomUUID(), responsibleUserId: "local-board" });
    expect(prepared).toHaveLength(1);
    expect(prepared[0].pinnedCommit).toBe(commit);
    expect(await readFile(path.join(checkout, "source.txt"), "utf8")).toBe("uncommitted work\n");
    // A malicious/non-regular receipt cannot block admission. The durable DB
    // pin remains authoritative, so this invalid receipt is ignored.
    if (process.platform !== "win32") {
      const receiptPath = path.join(checkout, ".git", "paperclip-workspace-owner.json");
      await promisify(execFileCallback)("mkfifo", [receiptPath]);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          executionWorkspaceRepositoryService(db).prepareForAdmission({ companyId, issueId, workspaceId, cwd, agentId, runId: randomUUID(), responsibleUserId: "local-board" }),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("FIFO receipt blocked admission")), 3000); }),
        ]);
      } finally {
        clearTimeout(deadline);
        // Release a blocked reader if this regression ever returns, so a failed
        // assertion cannot leave the test process stuck in its filesystem pool.
        const writer = await open(receiptPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK).catch(() => null);
        await writer?.close();
        await rm(receiptPath, { force: true });
      }
    }
  });
  it("reuses the same physical checkout across logical workspaces and rechecks retained privacy", async () => {
    const [secondAgent] = await db.insert(agents).values({ companyId, name: "Second agent", adapterType: "process" }).returning();
    const [secondWorkspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: null, name: "Same configured folder", cwd, mode: "shared_workspace", strategyType: "operator_directory" }).returning();
    const [secondIssue] = await db.insert(issues).values({ companyId, title: "Second task", assigneeAgentId: secondAgent.id, executionWorkspaceId: secondWorkspace.id }).returning();
    const service = executionWorkspaceRepositoryService(db);
    const intent = await service.request({ companyId, issueId: secondIssue.id, actor, request: { repository: { kind: "catalog", id: "123" }, requestKey: "shared-second" } });
    const admission = { companyId, issueId: secondIssue.id, workspaceId: secondWorkspace.id, cwd, agentId: secondAgent.id, runId: randomUUID(), responsibleUserId: null };
    const [original] = await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.executionWorkspaceId, workspaceId));
    const prepared = await service.prepareForAdmission(admission);
    expect(prepared[0]).toMatchObject({ id: intent.operationId, cwd: path.join(await realpath(cwd), original.relativePath), pinnedCommit: original.pinnedCommit });
    expect(await readFile(path.join(prepared[0].cwd, "source.txt"), "utf8")).toBe("uncommitted work\n");
    // There is still one physical checkout and neither its files nor Git metadata were rewritten.
    expect(await readFile(path.join(prepared[0].cwd, ".git", "paperclip-workspace-owner.json"), "utf8").catch(() => null)).toBeNull();
    const [differentRefWorkspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Conflicting ref", cwd, mode: "shared_workspace", strategyType: "operator_directory" }).returning();
    const [differentRefIssue] = await db.insert(issues).values({ companyId, title: "Different ref", executionWorkspaceId: differentRefWorkspace.id }).returning();
    await service.request({ companyId, issueId: differentRefIssue.id, actor, request: { repository: { kind: "catalog", id: "123" }, ref: "release", requestKey: "conflicting-ref" } });
    await expect(service.prepareForAdmission({ ...admission, issueId: differentRefIssue.id, workspaceId: differentRefWorkspace.id })).rejects.toThrow(/different ref/);
    const [privateSource] = await db.insert(issues).values({ companyId, title: "Retained private source", visibility: "private" }).returning();
    const owner = executionWorkspaceService(db);
    await owner.bindTaskWorkspace(companyId, privateSource.id, workspaceId);
    const [movedWorkspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Private task moved away", cwd: path.join(cwd, "moved-private-task"), mode: "shared_workspace", strategyType: "task_directory" }).returning();
    await owner.bindTaskWorkspace(companyId, privateSource.id, movedWorkspace.id);
    const [retainedWorkspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    expect(retainedWorkspace.metadata?._issuePrivacySources).toMatchObject({ [privateSource.id]: true });
    // Reauthorization also applies after the second inventory has a durable pin.
    await expect(service.prepareForAdmission(admission)).rejects.toThrow(/outside this actor's access/);
    expect(await readFile(path.join(prepared[0].cwd, "source.txt"), "utf8")).toBe("uncommitted work\n");
  });
  it("stages a root change without replacing active files or adding a wake", async () => {
    const owner = executionWorkspaceService(db);
    await expect(owner.selectTaskWorkspace({ companyId, issueId, actor, selection: { kind: "task_directory" }, expectedBindingRevision: 0, requestKey: "move" })).resolves.toMatchObject({ kind: "scheduled", applies: "next_normal_admission" });
    const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
    expect(issue.executionWorkspaceId).toBe(workspaceId);
    expect(issue.workspacePendingSelection?.requestKey).toBe("move");
    expect(issue.workspaceBindingRevision).toBe(0);
  });
});
