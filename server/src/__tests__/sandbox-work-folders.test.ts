import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { agents, assets, companyMemberships, issueAttachments, companies, createDb, heartbeatRuns, issues, environments, environmentLeases, executionWorkspaces, projects, projectWorkspaces, taskRepositoryBindings, workFolderObjects, workFolderRuns, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { prepareSandboxWorkFolders } from "../services/sandbox-work-folders.js";
import { bindWarmSandboxWorkspace } from "../services/sandbox-workspace-binding.js";
import { retainUnsavedWorkFolderLease, workFolderSandboxKey } from "../services/work-folder-retention.js";
import * as activityLog from "../services/activity-log.js";
import { workFolderService } from "../services/work-folders.js";
import { collectWorkFolderGarbage } from "../services/work-folder-garbage.js";
import { localTestWorkFolderRunner } from "./helpers/work-folder-runner.js";
const exec = promisify(execFile);

describe("shared sandbox work-folder lifecycle", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let root: string;
  let storage: ReturnType<typeof createLocalDiskStorageProvider>;
  const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), taskId = randomUUID(), environmentId = randomUUID();
  const active: Array<Awaited<ReturnType<typeof prepareSandboxWorkFolders>>> = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-sandbox-folders-");
    db = createDb(database.connectionString);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-folders-")));
    storage = createLocalDiskStorageProvider(path.join(root, "bucket"));
    await db.insert(companies).values({ id: companyId, name: "Sandbox folder tests" });
    await db.insert(environments).values({ id: environmentId, name: "Test sandbox", driver: "sandbox", config: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await db.insert(issues).values({ id: taskId, companyId, projectId, title: "Task", assigneeAgentId: agentId });
    for (const name of ["repo-one", "repo-two"]) {
      const source = path.join(root, name);
      await exec("git", ["init", source]);
      await fs.writeFile(path.join(source, "tracked"), "initial\n");
      await fs.writeFile(path.join(source, ".gitignore"), "node_modules/\n");
      await fs.symlink("tracked", path.join(source, "link"));
      await exec("git", ["-C", source, "add", "."]);
      await exec("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
      await db.insert(projectWorkspaces).values({ companyId, projectId, name, repoUrl: source, sourceType: "git_repo", isPrimary: name === "repo-one",
        setupCommand: "mkdir -p node_modules/acceptance && printf ready > node_modules/acceptance/installed && printf 'initialized\\n' >> .setup-count" });
    }
  }, 60_000);
  afterAll(async () => {
    for (const run of active) await run.stop().catch(() => {});
    await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true });
  });
  it("keeps the host's warm task binding without enabling user-configurable worktrees", async () => {
    const task = randomUUID(), runId = randomUUID(), workspaceId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    await db.insert(issues).values({ id: task, companyId, projectId, title: "Warm binding", assigneeAgentId: agentId, executionRunId: runId });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, sourceIssueId: task,
      mode: "shared_workspace", strategyType: "project_primary", name: "Warm binding" });
    const input = { companyId, issueId: task, runId, agentId, workspaceId };
    await bindWarmSandboxWorkspace(db, input);
    const [bound] = await db.select().from(issues).where(eq(issues.id, task));
    expect(bound).toMatchObject({ executionWorkspaceId: workspaceId, executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { mode: "shared_workspace" } });
    for (const bad of [{ companyId: randomUUID() }, { agentId: randomUUID() }, { issueId: taskId }, { runId: randomUUID() }]) {
      await expect(bindWarmSandboxWorkspace(db, { ...input, ...bad })).rejects.toThrow("active task run");
    }
    await db.update(executionWorkspaces).set({ sourceIssueId: taskId }).where(eq(executionWorkspaces.id, workspaceId));
    await expect(bindWarmSandboxWorkspace(db, input)).rejects.toThrow("active task run");
    await db.update(executionWorkspaces).set({ sourceIssueId: task }).where(eq(executionWorkspaces.id, workspaceId));
    const originalLogActivity = activityLog.logActivity;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const audit = vi.spyOn(activityLog, "logActivity").mockImplementationOnce(async (...args) => {
      entered(); await gate; return originalLogActivity(...args);
    });
    const pendingBinding = bindWarmSandboxWorkspace(db, input);
    try {
      await reached;
      // These state changes must wait until the validated binding commits.
      for (const target of ["run", "workspace"]) {
        await expect(db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '100ms'`);
          if (target === "run") await tx.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
          else await tx.update(executionWorkspaces).set({ status: "closed" }).where(eq(executionWorkspaces.id, workspaceId));
        })).rejects.toMatchObject({ cause: { code: "55P03" } });
      }
    } finally {
      release(); await pendingBinding; audit.mockRestore();
    }
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    await expect(bindWarmSandboxWorkspace(db, input)).rejects.toThrow("active task run");
  });
  async function prepare(home: string, leaseId: string, physicalId = leaseId, responsibleUserId: string | null = null,
    options: { taskId?: string; branchName?: string; agentId?: string } = {}) {
    await fs.mkdir(home, { recursive: true });
    const runId = randomUUID();
    const boundAgentId = options.agentId ?? agentId;
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: boundAgentId, responsibleUserId, status: "running" });
    const lease = { id: leaseId, companyId, environmentId, provider: "test", providerLeaseId: physicalId };
    await db.insert(environmentLeases).values({ ...lease, heartbeatRunId: runId }).onConflictDoUpdate({ target: environmentLeases.id, set: { heartbeatRunId: runId } });
    const [primary] = await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.projectId, projectId));
    const run = await prepareSandboxWorkFolders({ db, companyId, agentId: boundAgentId, projectId, taskId: options.taskId ?? taskId, runId,
      primaryWorkspaceId: primary!.id, primaryBranchName: options.branchName,
      responsibleUserId, storage, sandboxKey: workFolderSandboxKey(lease), target: { kind: "remote", transport: "sandbox", leaseId, remoteCwd: home,
        runner: { execute: (input) => localTestWorkFolderRunner.execute({ ...input, env: { ...input.env, HOME: home } }) } } });
    active.push(run); return run;
  }
  it("retains unaudited edits and retries without misreporting a completed checkpoint", async () => {
    const run = await prepare(path.join(root, "activity-failure"), randomUUID());
    await run.flush();
    const [before] = await db.select().from(workFolderRuns).where(eq(workFolderRuns.runId, run.manifest.runId));
    await fs.writeFile(path.join(run.home, "task/activity-proof.txt"), "saved after logging recovers");
    const beforeCompletion = vi.fn(async () => {
      const [state] = await db.select().from(workFolderRuns).where(eq(workFolderRuns.runId, run.manifest.runId));
      expect(state?.state).toBe("saved");
      expect(state?.manifest.finalCheckpointAt).toBeUndefined();
      const folder = await workFolderService(db, storage).ensure({ companyId, scope: "task", ownerId: taskId });
      expect((await workFolderService(db, storage).list(folder)).files.some((file) => file.path === "activity-proof.txt")).toBe(true);
    });
    const activity = vi.spyOn(activityLog, "logActivity").mockRejectedValue(new Error("activity unavailable"));
    try {
      await expect(run.stop(beforeCompletion)).rejects.toThrow("activity unavailable");
      expect(beforeCompletion).not.toHaveBeenCalled();
      const [state] = await db.select().from(workFolderRuns).where(eq(workFolderRuns.runId, run.manifest.runId));
      expect(state?.state).toBe("failed");
      expect(state?.lastSavedAt).toEqual(before?.lastSavedAt);
      const folder = await workFolderService(db, storage).ensure({ companyId, scope: "task", ownerId: taskId });
      expect((await workFolderService(db, storage).list(folder)).files.some((file) => file.path === "activity-proof.txt")).toBe(false);
      expect(await fs.readFile(path.join(run.home, "task/activity-proof.txt"), "utf8")).toBe("saved after logging recovers");
    } finally { activity.mockRestore(); }
    await run.stop(beforeCompletion); active.splice(active.indexOf(run), 1);
    expect(beforeCompletion).toHaveBeenCalledTimes(1);
    const [saved] = await db.select().from(workFolderRuns).where(eq(workFolderRuns.runId, run.manifest.runId));
    expect(saved?.state).toBe("saved");
    expect(saved?.manifest.finalCheckpointAt).toBeTruthy();
    expect(saved!.lastSavedAt!.getTime()).toBeGreaterThan(before!.lastSavedAt!.getTime());
    const folder = await workFolderService(db, storage).ensure({ companyId, scope: "task", ownerId: taskId });
    expect((await workFolderService(db, storage).list(folder)).files.some((file) => file.path === "activity-proof.txt")).toBe(true);
  }, 120_000);

  it("reuses clones and restores saved unpushed work, staged changes, and task files after losing the sandbox", async () => {
    const repositoryTaskId = randomUUID();
    await db.insert(issues).values({ id: repositoryTaskId, companyId, projectId, title: "Repository recovery", assigneeAgentId: agentId });
    const task = { taskId: repositoryTaskId };
    const home = path.join(root, "sandbox");
    const leaseId = randomUUID();
    const first = await prepare(home, leaseId, leaseId, null, task);
    expect(first.home).toBe(home);
    expect(first.manifest.repositories).toHaveLength(2);
    expect(first.primaryRepo).toBe(path.join(home, "repos/repo-one"));
    await fs.writeFile(path.join(home, "task/report.md"), "durable task file");
    const repo = first.primaryRepo;
    expect(await fs.readFile(path.join(repo, ".setup-count"), "utf8")).toBe("initialized\n");
    await fs.writeFile(path.join(repo, "node_modules/acceptance/warm-cache"), "reusable");
    await fs.writeFile(path.join(repo, "tracked"), "committed\n");
    await exec("git", ["-C", repo, "add", "."]);
    await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "unpushed"]);
    const expectedHead = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await fs.writeFile(path.join(repo, "tracked"), "staged\n");
    await exec("git", ["-C", repo, "add", "tracked"]);
    await fs.writeFile(path.join(repo, "tracked"), "unstaged\n");
    await fs.writeFile(path.join(repo, "untracked"), "untracked\n");
    await first.stop(); active.splice(active.indexOf(first), 1);
    const warm = await prepare(home, randomUUID(), leaseId, null, task);
    expect(await fs.readFile(path.join(repo, ".setup-count"), "utf8")).toBe("initialized\n");
    expect(await fs.readFile(path.join(repo, "node_modules/acceptance/warm-cache"), "utf8")).toBe("reusable");
    expect(await fs.readFile(path.join(repo, "tracked"), "utf8")).toBe("unstaged\n");
    await warm.stop(); active.splice(active.indexOf(warm), 1);
    await fs.rm(home, { recursive: true });
    const replacementId = randomUUID();
    const restored = await prepare(path.join(root, "replacement"), replacementId, replacementId, null, task);
    expect(await fs.readFile(path.join(restored.primaryRepo, ".setup-count"), "utf8")).toBe("initialized\ninitialized\n");
    expect(await fs.readFile(path.join(restored.primaryRepo, "node_modules/acceptance/installed"), "utf8")).toBe("ready");
    await expect(fs.stat(path.join(restored.primaryRepo, "node_modules/acceptance/warm-cache"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(restored.home, "task/report.md"), "utf8")).toBe("durable task file");
    expect((await exec("git", ["-C", restored.primaryRepo, "rev-parse", "HEAD"])).stdout.trim()).toBe(expectedHead);
    expect((await exec("git", ["-C", restored.primaryRepo, "show", ":tracked"])).stdout).toBe("staged\n");
    expect(await fs.readFile(path.join(restored.primaryRepo, "tracked"), "utf8")).toBe("unstaged\n");
    expect(await fs.readFile(path.join(restored.primaryRepo, "untracked"), "utf8")).toBe("untracked\n");
    expect(await fs.readlink(path.join(restored.primaryRepo, "link"))).toBe("tracked");
    await restored.stop(); active.splice(active.indexOf(restored), 1);
  }, 120_000);
  it("does not let an unchanged stale shared file overwrite a newer durable value", async () => {
    const svc = workFolderService(db, storage);
    const folder = await svc.ensure({ companyId, scope: "project", ownerId: projectId });
    await svc.write(folder, { path: "shared.md", body: Buffer.from("first"), operationId: randomUUID() });
    const run = await prepare(path.join(root, "stale-sandbox"), randomUUID());
    await svc.write(folder, { path: "shared.md", body: Buffer.from("newer"), operationId: randomUUID() });
    await run.stop(); active.splice(active.indexOf(run), 1);
    const result = await svc.content(folder, "shared.md");
    const chunks = []; for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("newer");
  }, 120_000);
  it("retains the only working copy until a final checkpoint succeeds", async () => {
    const leaseId = randomUUID();
    const run = await prepare(path.join(root, "retained-sandbox"), leaseId);
    await fs.writeFile(path.join(run.home, "task/pending"), "recover me");
    await run.flush();
    expect(await retainUnsavedWorkFolderLease(db, { id: leaseId, companyId })).toBe(true);
    await run.stop(); active.splice(active.indexOf(run), 1);
    expect(await retainUnsavedWorkFolderLease(db, { id: leaseId, companyId })).toBe(false);
  }, 120_000);
  it("reconciles file-directory replacements and preserves deleted children in trash", async () => {
    const svc = workFolderService(db, storage);
    const folder = await svc.ensure({ companyId, scope: "project", ownerId: projectId });
    await svc.write(folder, { path: "replace/child", body: Buffer.from("child"), operationId: randomUUID() });
    const leaseId = randomUUID();
    const home = path.join(root, "replacement-kinds");
    const run = await prepare(home, leaseId);
    await fs.rm(path.join(home, "project/replace"), { recursive: true });
    await fs.writeFile(path.join(home, "project/replace"), "now a file");
    await run.stop(); active.splice(active.indexOf(run), 1);
    expect((await svc.list(folder, { trash: true })).files.map((file) => file.path)).toContain("replace/child");
    await svc.write(folder, { path: "replace", kind: "directory", replaceKind: true, operationId: randomUUID() });
    const resumed = await prepare(home, randomUUID(), leaseId);
    expect((await fs.stat(path.join(home, "project/replace"))).isDirectory()).toBe(true);
    await resumed.stop(); active.splice(active.indexOf(resumed), 1);
  }, 120_000);

  it("stops private-file synchronization after responsible-user membership is revoked", async () => {
    const userId = randomUUID();
    const [membership] = await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "member" }).returning();
    const leaseId = randomUUID();
    const run = await prepare(path.join(root, "revoked-user"), leaseId, leaseId, userId);
    await fs.writeFile(path.join(run.home, "user/private"), "pending private edit");
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.id, membership!.id));
    await expect(run.stop()).rejects.toThrow("no longer authorized");
    expect(await retainUnsavedWorkFolderLease(db, { id: leaseId, companyId })).toBe(true);
    const svc = workFolderService(db, storage);
    const folder = await svc.ensure({ companyId, scope: "user", ownerId: userId });
    expect((await svc.list(folder)).files).toHaveLength(0);
    expect(await fs.readFile(path.join(run.home, "user/private"), "utf8")).toBe("pending private edit");
    await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.id, membership!.id));
    await run.stop(); active.splice(active.indexOf(run), 1);
  }, 120_000);

  it("does not publish a partial repository checkpoint and retries a failed final save", async () => {
    const leaseId = randomUUID();
    const run = await prepare(path.join(root, "interrupted-checkpoint"), leaseId);
    await run.flush();
    const bindingId = run.manifest.repositories[0]!.bindingId;
    const [before] = await db.select().from(taskRepositoryBindings).where(eq(taskRepositoryBindings.id, bindingId));
    await fs.writeFile(path.join(run.primaryRepo, "new-unsaved-file"), "must survive a failed save");
    const put = storage.putObject.bind(storage);
    const fail = vi.spyOn(storage, "putObject").mockImplementation(async (input) => {
      if (input.objectKey.includes("/checkpoints/")) throw new Error("Injected storage outage");
      return put(input);
    });
    try {
      await expect(run.stop()).rejects.toThrow("Injected storage outage");
      const [after] = await db.select().from(taskRepositoryBindings).where(eq(taskRepositoryBindings.id, bindingId));
      expect(after!.checkpointKey).toBe(before!.checkpointKey);
      expect(await retainUnsavedWorkFolderLease(db, { id: leaseId, companyId })).toBe(true);
    } finally { fail.mockRestore(); }
    await run.stop(); active.splice(active.indexOf(run), 1);
    await fs.rm(run.home, { recursive: true });
    const recovered = await prepare(path.join(root, "interrupted-recovered"), randomUUID());
    expect(await fs.readFile(path.join(recovered.primaryRepo, "new-unsaved-file"), "utf8")).toBe("must survive a failed save");
    await recovered.stop(); active.splice(active.indexOf(recovered), 1);
  }, 120_000);

  it("seeds duplicate and reserved attachment names idempotently without changing original uploads", async () => {
    const attachmentIds: string[] = [];
    const originalKeys: string[] = [];
    const content = Buffer.from("original upload");
    for (const originalFilename of ["same.txt", "same.txt", ".", ".paperclip-runtime"]) {
      const id = randomUUID();
      const objectKey = `${companyId}/attachments/${id}`;
      originalKeys.push(objectKey);
      await storage.putObject({ objectKey, body: content, contentType: "text/plain", contentLength: content.length });
      await db.insert(assets).values({ id, companyId, provider: storage.id, objectKey, contentType: "text/plain", byteSize: content.length,
        sha256: createHash("sha256").update(content).digest("hex"), originalFilename });
      const attachmentId = randomUUID(); attachmentIds.push(attachmentId);
      await db.insert(issueAttachments).values({ id: attachmentId, companyId, issueId: taskId, assetId: id });
    }
    const leaseId = randomUUID();
    const home = path.join(root, "attachment-seeding");
    const first = await prepare(home, leaseId);
    const files = (await fs.readdir(path.join(home, "task"))).filter((file) => attachmentIds.some((id) => file.includes(id)));
    expect(files).toHaveLength(4);
    await fs.writeFile(path.join(home, "task", files[0]!), "edited working copy");
    await first.stop(); active.splice(active.indexOf(first), 1);
    const warm = await prepare(home, randomUUID(), leaseId);
    expect(await fs.readFile(path.join(home, "task", files[0]!), "utf8")).toBe("edited working copy");
    expect((await fs.readdir(path.join(home, "task"))).filter((file) => attachmentIds.some((id) => file.includes(id)))).toEqual(files);
    await warm.stop(); active.splice(active.indexOf(warm), 1);
    for (const objectKey of originalKeys) {
      const original = await storage.getObject({ objectKey });
      const chunks: Buffer[] = [];
      for await (const chunk of original.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(content);
    }
  }, 120_000);

  it("gives another task independent checkouts and preserves its task branch on warm starts", async () => {
    const secondTaskId = randomUUID();
    await db.insert(issues).values({ id: secondTaskId, companyId, projectId, title: "Independent task", assigneeAgentId: agentId });
    const lease = randomUUID();
    const home = path.join(root, "independent-task");
    const run = await prepare(home, lease, lease, null, { taskId: secondTaskId, branchName: "acceptance/second-task" });
    expect(run.manifest.repositories).toHaveLength(2);
    expect((await exec("git", ["-C", run.primaryRepo, "branch", "--show-current"])).stdout.trim()).toBe("acceptance/second-task");
    expect(await fs.readFile(path.join(run.primaryRepo, "tracked"), "utf8")).toBe("initial\n");
    await fs.writeFile(path.join(run.primaryRepo, "tracked"), "second task edit");
    await run.stop(); active.splice(active.indexOf(run), 1);
    const warm = await prepare(home, randomUUID(), lease, null, { taskId: secondTaskId, branchName: "must-not-reset" });
    expect((await exec("git", ["-C", warm.primaryRepo, "branch", "--show-current"])).stdout.trim()).toBe("acceptance/second-task");
    expect(await fs.readFile(path.join(warm.primaryRepo, "tracked"), "utf8")).toBe("second task edit");
    await warm.stop(); active.splice(active.indexOf(warm), 1);
  }, 120_000);

  it("restores task work across identities without carrying over private homes or sessions", async () => {
    const otherAgentId = randomUUID(), firstUser = randomUUID(), secondUser = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "Replacement agent" });
    for (const userId of [firstUser, secondUser]) await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "member" });
    const lease = randomUUID(); const first = await prepare(path.join(root, "identity-one"), lease, lease, firstUser);
    await fs.writeFile(path.join(first.home, "task/identity.txt"), "shared task work");
    await fs.writeFile(path.join(first.home, "agent/identity-private"), "old agent only");
    await fs.writeFile(path.join(first.home, "user/identity-private"), "old user only");
    await fs.writeFile(path.join(first.home, ".codex/session-private"), "old provider session");
    await first.stop(); active.splice(active.indexOf(first), 1);
    await expect(prepare(first.home, randomUUID(), lease, secondUser, { agentId: otherAgentId })).rejects.toThrow("fresh sandbox");
    const replacementLease = randomUUID();
    const replacement = await prepare(path.join(root, "identity-two"), replacementLease, replacementLease, secondUser, { agentId: otherAgentId });
    expect(replacement.identityChanged).toBe(true);
    expect(await fs.readFile(path.join(replacement.home, "task/identity.txt"), "utf8")).toBe("shared task work");
    for (const file of ["agent/identity-private", "user/identity-private", ".codex/session-private"]) await expect(fs.access(path.join(replacement.home, file))).rejects.toThrow();
    expect(replacement.manifest.repositories).toHaveLength(2);
    await replacement.stop(); active.splice(active.indexOf(replacement), 1);
  }, 120_000);

  it("collects superseded repository objects while retaining the complete current checkpoint", async () => {
    const run = await prepare(path.join(root, "checkpoint-garbage"), randomUUID());
    const filename = path.join(run.primaryRepo, "garbage-fixture");
    await fs.writeFile(filename, "old unique checkpoint content");
    await run.flush();
    const bindingId = run.manifest.repositories.find((binding) => binding.primary)!.bindingId;
    const [before] = await db.select().from(taskRepositoryBindings).where(eq(taskRepositoryBindings.id, bindingId));
    const oldBlob = `${companyId}/task-repositories/${bindingId}/blobs/${createHash("sha256").update("old unique checkpoint content").digest("hex")}`;
    await fs.writeFile(filename, "current checkpoint content");
    await run.stop(); active.splice(active.indexOf(run), 1);
    const [after] = await db.select().from(taskRepositoryBindings).where(eq(taskRepositoryBindings.id, bindingId));
    const [retired] = await db.select().from(workFolderObjects).where(eq(workFolderObjects.objectKey, before!.checkpointKey!));
    expect(retired!.deleteAfter).not.toBeNull();
    await collectWorkFolderGarbage(db, storage, new Date(Date.now() + 25 * 60 * 60 * 1000), 1000);
    expect((await storage.headObject({ objectKey: before!.checkpointKey! })).exists).toBe(false);
    expect((await storage.headObject({ objectKey: oldBlob })).exists).toBe(false);
    expect((await storage.headObject({ objectKey: after!.checkpointKey! })).exists).toBe(true);
    await fs.rm(run.home, { recursive: true });
    const restored = await prepare(path.join(root, "checkpoint-garbage-restored"), randomUUID());
    expect(await fs.readFile(path.join(restored.primaryRepo, "garbage-fixture"), "utf8")).toBe("current checkpoint content");
    await restored.stop(); active.splice(active.indexOf(restored), 1);
  }, 120_000);
});
