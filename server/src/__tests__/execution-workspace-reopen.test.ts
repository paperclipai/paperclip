import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { assertExecutionWorkspaceRootReadAccess } from "../services/execution-workspace-repositories.js";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companyMemberships,
  issueAccessGrants,
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY,
  EXECUTION_WORKSPACE_REOPEN_FAILED_REASON,
  EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY,
  EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY,
  executionWorkspaceService,
  metadataHasReopenPendingConsumption,
  readExecutionWorkspaceLifecycleGeneration,
  readMetadataReopenPendingConsumptionSince,
} from "../services/execution-workspaces.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reopen tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reopen archived isolated execution workspace", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reopen-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeExistingDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-reopen-cwd-"));
    tempDirs.push(dir);
    return dir;
  }

  async function seedCompanyProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `PAP-${companyId.slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Reopen project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: "/tmp/paperclip-reopen-project",
      isPrimary: true,
    });
    return { companyId, projectId, projectWorkspaceId };
  }

  async function seedClosedWorkspace(input: {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    cwd: string;
    status?: "archived" | "cleanup_failed" | "active";
    generation?: number;
  }) {
    const workspaceId = randomUUID();
    const closed = (input.status ?? "archived") !== "active";
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      projectWorkspaceId: input.projectWorkspaceId,
      mode: "isolated_workspace",
      // project_primary strategy so the rebuild only checks that the directory
      // exists, with no git operation.
      strategyType: "project_primary",
      name: "reopen-workspace",
      status: input.status ?? "archived",
      providerType: "local_fs",
      cwd: input.cwd,
      closedAt: closed ? new Date() : null,
      cleanupReason: closed ? "issue_terminal" : null,
      cleanupEligibleAt: closed ? new Date() : null,
      metadata: {
        [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: input.generation ?? 1,
      },
    });
    return workspaceId;
  }

  // Seed a company and project whose primary project workspace has a null cwd.
  // This models a managed_checkout project: the base is not a local folder, so
  // the live managed checkout supplies the base path at rebuild time.
  async function seedManagedCheckoutProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `PAP-${companyId.slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Managed checkout project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "managed_checkout",
      cwd: null,
      isPrimary: true,
    });
    return { companyId, projectId, projectWorkspaceId };
  }

  // Seed one closed isolated git_worktree row. The reaper already removed the
  // worktree directory, so cwd points at a path that is not on disk.
  async function seedClosedGitWorktreeWorkspace(input: {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    cwd: string;
    repoUrl: string;
    branchName: string;
  }) {
    const workspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      projectWorkspaceId: input.projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "reopen-git-worktree",
      status: "archived",
      providerType: "local_fs",
      cwd: input.cwd,
      repoUrl: input.repoUrl,
      baseRef: null,
      branchName: input.branchName,
      closedAt: new Date(),
      cleanupReason: "issue_terminal",
      cleanupEligibleAt: new Date(),
      metadata: {
        [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 1,
      },
    });
    return workspaceId;
  }

  // Build a real git repository at the managed checkout path so
  // ensureManagedProjectWorkspace adopts it without a network clone. The repo
  // holds the branch that the archived worktree row references.
  function initManagedGitRepo(dir: string, worktreeBranch: string) {
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
        },
        stdio: "ignore",
      });
    git("init");
    writeFileSync(join(dir, "README.md"), "seed\n");
    git("add", "README.md");
    git("commit", "-m", "seed");
    git("branch", worktreeBranch);
  }

  async function seedIssue(input: {
    companyId: string;
    projectId: string;
    workspaceId: string;
    issueNumber: number;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      projectId: input.projectId,
      identifier: `PAP-${input.issueNumber}`,
      issueNumber: input.issueNumber,
      title: "Resume me",
      status: "todo",
      priority: "medium",
      executionWorkspaceId: input.workspaceId,
    });
    return issueId;
  }

  async function readWorkspace(id: string) {
    return db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, id))
      .then((rows) => rows[0] ?? null);
  }

  describe.each(["configured", "builtin"] as const)("reopen %s host provision containment", kind => {
    it.each(["task", "agent", "organization", "source", "same-source", "trusted", "explicit", "projectless", "nondefault", "foreign-source-task", "retained-missing", "retained-false", "retained-null"] as const)("honors persisted %s policy before running repository scripts", async restriction => {
      const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
      const directory = await makeExistingDir();
      const base = join(directory, "source"), target = join(directory, "target"), marker = join(directory, "host-provision-ran");
      initManagedGitRepo(base, "reopen-feature");
      const command = `printf 'host execution\n' > '${marker}'`;
      mkdirSync(join(base, "scripts"));
      writeFileSync(join(base, "scripts", "provision-worktree.sh"), command + "\n");
      const git = (...args: string[]) => execFileSync("git", args, { cwd: base, stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" } });
      git("add", "scripts"); git("commit", "-m", "Host provision fixture"); git("branch", "-f", "reopen-feature", "HEAD");
      await db.update(projectWorkspaces).set({ cwd: base }).where(eq(projectWorkspaces.id, projectWorkspaceId));
      const workspaceId = await seedClosedGitWorktreeWorkspace({ companyId, projectId, projectWorkspaceId,
        cwd: target, repoUrl: pathToFileURL(base).href, branchName: "reopen-feature" });
      if (kind === "configured") await db.update(executionWorkspaces).set({ metadata: {
        [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 1, config: { provisionCommand: command },
      } }).where(eq(executionWorkspaces.id, workspaceId));
      const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4199 });
      let organizationId: string | null = restriction === "projectless" ? null : projectId;
      if (restriction === "organization") {
        organizationId = randomUUID();
        await db.insert(projects).values({ id: organizationId, companyId, name: "Organizational policy" });
      }
      const policy = { trustPreset: "low_trust_review", authorizationPolicy: { trustPreset: "low_trust_review",
        trustBoundary: { mode: "low_trust_review", companyId, rootIssueId: issueId,
          projectIds: [...new Set([projectId, ...(organizationId ? [organizationId] : [])])] } } };
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Reopen assignee",
        permissions: restriction === "agent" ? policy : {} });
      await db.update(issues).set({ projectId: organizationId, assigneeAgentId: agentId,
        executionPolicy: restriction === "task" ? policy : null }).where(eq(issues.id, issueId));
      if (["source", "same-source", "organization"].includes(restriction)) {
        await db.update(projects).set({ executionWorkspacePolicy: policy })
          .where(eq(projects.id, restriction === "organization" ? organizationId! : projectId));
      }
      if (restriction === "explicit" || restriction.startsWith("retained-")) {
        await db.update(issues).set({ workspaceSelection: { version: 1, source: "explicit",
          selection: { kind: "configured_source", projectWorkspaceId, mode: "managed_isolated" } } })
          .where(eq(issues.id, issueId));
      }
      if (restriction === "nondefault") {
        await db.update(projectWorkspaces).set({ isPrimary: false }).where(eq(projectWorkspaces.id, projectWorkspaceId));
        await db.insert(projectWorkspaces).values({ companyId, projectId, name: "Earlier default",
          sourceType: "local_path", cwd: base, isPrimary: true, createdAt: new Date(0) });
      }
      if (restriction === "foreign-source-task") {
        const sourceIssueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4198 });
        await db.update(executionWorkspaces).set({ sourceIssueId }).where(eq(executionWorkspaces.id, workspaceId));
      }
      if (restriction.startsWith("retained-")) {
        const workspace = await readWorkspace(workspaceId);
        await db.update(executionWorkspaces).set({ metadata: { ...workspace?.metadata,
          _controllerProvisionCopyOnly: true } }).where(eq(executionWorkspaces.id, workspaceId));
        await db.update(issues).set({ workspaceSelection: null }).where(eq(issues.id, issueId));
        const service = executionWorkspaceService(db);
        await service.update(workspaceId, { metadata: restriction === "retained-null" ? null
          : restriction === "retained-false" ? { _controllerProvisionCopyOnly: false } : {} });
        if (kind === "configured") await service.update(workspaceId, { metadata: { config: { provisionCommand: command } } });
        expect((await readWorkspace(workspaceId))?.metadata).toMatchObject({ _controllerProvisionCopyOnly: true });
      }
      const result = await executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({
        workspaceId, issue: { id: issueId, companyId, projectId: organizationId },
        actor: { agentId: null, actorType: "user" },
        authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
      });
      expect(result).toMatchObject({ ok: true, reopened: true });
      await expect(readFile(join(target, "README.md"), "utf8")).resolves.toBe("seed\n");
      if (restriction === "trusted") await expect(readFile(marker, "utf8")).resolves.toBe("host execution\n");
      else await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readWorkspace(workspaceId)).toMatchObject({ status: "active", projectId, projectWorkspaceId });
      if (["explicit", "projectless", "nondefault", "foreign-source-task"].includes(restriction) || restriction.startsWith("retained-")) expect((await readWorkspace(workspaceId))?.metadata)
        .toMatchObject({ _controllerProvisionCopyOnly: true });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
        .toMatchObject({ projectId: organizationId, executionWorkspaceId: workspaceId, assigneeAgentId: agentId });
    });
  });

  it("reopens the archived row in place, keeps the issue link, and raises the generation", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd, generation: 3 });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4100 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reopened).toBe(true);

    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("active");
    expect(row?.closedAt).toBeNull();
    expect(row?.cleanupReason).toBeNull();
    expect(row?.cleanupEligibleAt).toBeNull();
    expect(readExecutionWorkspaceLifecycleGeneration(row?.metadata as Record<string, unknown> | null)).toBe(4);
    // The reopen flags the row so the terminal reaper does not archive and
    // destroy the rebuilt worktree before the caller consumes it.
    expect(metadataHasReopenPendingConsumption(row?.metadata as Record<string, unknown> | null)).toBe(true);

    // The reopen never changes the issue-to-workspace link.
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issueRow?.executionWorkspaceId).toBe(workspaceId);
  });

  it("reopens the persisted source after the task leaves its organizational project", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4105 });
    await db.update(issues).set({ projectId: null }).where(eq(issues.id, issueId));
    const result = await executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId: null },
      actor: { agentId: null, actorType: "user" },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
    });
    expect(result.ok).toBe(true);
    expect((await readWorkspace(workspaceId))?.projectId).toBe(projectId);
  });

  it("keeps access for every issue that shares the reopened row", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd });
    const firstIssueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4101 });
    const secondIssueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4102 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: firstIssueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
    });
    expect(result.ok).toBe(true);

    const rows = await db.select().from(issues);
    for (const row of rows) {
      expect(row.executionWorkspaceId).toBe(workspaceId);
    }
    const workspace = await readWorkspace(workspaceId);
    expect(workspace?.status).toBe("active");
    expect(firstIssueId).not.toBe(secondIssueId);
  });

  it("fails closed and keeps the row closed when the rebuild fails", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    // A directory that does not exist. The project_primary rebuild returns null.
    const missingDir = join(tmpdir(), `paperclip-reopen-missing-${randomUUID()}`);
    const workspaceId = await seedClosedWorkspace({
      companyId,
      projectId,
      projectWorkspaceId,
      cwd: missingDir,
      generation: 2,
    });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4103 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("rebuild_failed");

    const row = await readWorkspace(workspaceId);
    // The row stays closed and retryable. The generation still rises so a queued
    // cleanup with the old generation does nothing.
    expect(row?.status).toBe("archived");
    expect(row?.cleanupReason).toBe(EXECUTION_WORKSPACE_REOPEN_FAILED_REASON);
    expect(row?.cleanupEligibleAt).toBeNull();
    expect(readExecutionWorkspaceLifecycleGeneration(row?.metadata as Record<string, unknown> | null)).toBe(3);
  });

  it("resolves the managed base checkout for a git_worktree row when the project workspace cwd is null", async () => {
    const previousHome = process.env.PAPERCLIP_HOME;
    const tempHome = await mkdtemp(join(tmpdir(), "paperclip-reopen-home-"));
    tempDirs.push(tempHome);
    process.env.PAPERCLIP_HOME = tempHome;
    try {
      const { companyId, projectId, projectWorkspaceId } = await seedManagedCheckoutProject();
      const repoUrl = "https://example.test/acme/widget.git";
      const branchName = "reopen-feature";
      // Build the live managed checkout that the rebuild must spawn git in.
      const managedDir = resolveManagedProjectWorkspaceDir({ companyId, projectId, repoName: "widget" });
      initManagedGitRepo(managedDir, branchName);

      // The archived worktree path. The reaper already removed it from disk.
      const deletedWorktree = join(tempHome, "worktrees", "reopen-worktree");
      const workspaceId = await seedClosedGitWorktreeWorkspace({
        companyId,
        projectId,
        projectWorkspaceId,
        cwd: deletedWorktree,
        repoUrl,
        branchName,
      });
      const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4305 });

      const svc = executionWorkspaceService(db);
      const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
        workspaceId,
        issue: { id: issueId, companyId, projectId },
        actor: { agentId: null, actorType: "user" },
        authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reopened).toBe(true);

      const row = await readWorkspace(workspaceId);
      expect(row?.status).toBe("active");
      expect(row?.closedAt).toBeNull();
      expect(row?.cleanupReason).toBeNull();
      // The rebuild recreated the worktree at the archived path from the managed
      // base checkout.
      const worktreeStat = await stat(deletedWorktree).catch(() => null);
      expect(worktreeStat?.isDirectory()).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
    }
  });

  it.each([false, true, "revoked_during_provision"] as const)("guards a private local managed reopen before Git and retains privacy after provisioning failure=%s", async scenario => {
    const provisionFails = scenario === true;
    const revokeDuringProvision = scenario === "revoked_during_provision";
    const previousHome = process.env.PAPERCLIP_HOME;
    const previousPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    const home = await makeExistingDir();
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    try {
      const { companyId, projectId, projectWorkspaceId } = await seedManagedCheckoutProject();
      const readerId = randomUUID();
      await db.insert(authUsers).values({ id: readerId, name: "Reader", email: `${readerId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: readerId, status: "active", membershipRole: "member" });
      const authorizationActor = { type: "board" as const, source: "session" as const, userId: readerId, companyIds: [companyId], isInstanceAdmin: false };
      const source = join(home, "private-source"), target = join(home, "worktree-copy");
      initManagedGitRepo(source, "reopen-feature");
      writeFileSync(join(source, "private.txt"), "PRIVATE_REOPEN_BYTES");
      execFileSync("git", ["add", "private.txt"], { cwd: source });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "private"], { cwd: source });
      execFileSync("git", ["branch", "-f", "reopen-feature", "HEAD"], { cwd: source });
      const repoUrl = pathToFileURL(source).href;
      await db.update(projectWorkspaces).set({ repoUrl }).where(eq(projectWorkspaces.id, projectWorkspaceId));
      const privateIssueId = randomUUID();
      await db.insert(issues).values({ id: privateIssueId, companyId, title: "Private source", visibility: "private", status: "todo", responsibleUserId: "another-owner" });
      await db.insert(executionWorkspaces).values({ companyId, projectId: null, sourceIssueId: privateIssueId, name: "Private owner", mode: "shared_workspace", strategyType: "project_primary", cwd: source, providerType: "local_fs", status: "active" });
      const workspaceId = await seedClosedGitWorktreeWorkspace({ companyId, projectId, projectWorkspaceId, cwd: target, repoUrl, branchName: "reopen-feature" });
      const waitingProvision = `node -e 'const fs = require("node:fs"); fs.writeFileSync("dirty.txt", "DIRTY_REOPEN_BYTES"); fs.writeFileSync("provision-started", "ready"); const deadline = Date.now() + 15000; const timer = setInterval(() => { if (fs.existsSync("provision-continue")) { clearInterval(timer); process.exit(0); } if (Date.now() > deadline) process.exit(2); }, 20);'`;
      if (provisionFails || revokeDuringProvision) await db.update(executionWorkspaces).set({ metadata: { [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 1, config: { provisionCommand: provisionFails ? "exit 42" : waitingProvision } } }).where(eq(executionWorkspaces.id, workspaceId));
      const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4901 });
      if (revokeDuringProvision) await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      const reopen = () => executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId, issue: { id: issueId, companyId, projectId }, actor: { actorType: "user", agentId: null }, authorizationActor });
      expect(await reopen()).toMatchObject({ ok: false, code: "rebuild_failed" });
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      const managed = resolveManagedProjectWorkspaceDir({ companyId, projectId, repoName: "private-source" });
      await expect(stat(managed)).rejects.toMatchObject({ code: "ENOENT" });
      await db.insert(issueAccessGrants).values({ issueId: privateIssueId, subjectType: "user", subjectId: readerId, source: "explicit" });
      const attempt = revokeDuringProvision ? reopen() : null;
      if (attempt) {
        try {
          await vi.waitFor(async () => expect(await readFile(join(target, "provision-started"), "utf8")).toBe("ready"), { timeout: 10_000 });
          await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, privateIssueId));
        } finally {
          await writeFile(join(target, "provision-continue"), "resume");
        }
      }
      const results = attempt ? [await attempt] : provisionFails ? [await reopen()] : await Promise.all([reopen(), reopen()]);
      expect(results.every(result => result.ok)).toBe(!provisionFails && !revokeDuringProvision);
      if (!provisionFails && !revokeDuringProvision) expect(results.map(result => result.ok && result.reopened).sort()).toEqual([false, true]);
      expect(await readFile(join(target, "private.txt"), "utf8")).toBe("PRIVATE_REOPEN_BYTES");
      if (revokeDuringProvision) {
        expect(results[0]).toMatchObject({ ok: false, code: "rebuild_failed" });
        const reopened = await readWorkspace(workspaceId);
        expect(reopened?.status).toBe("active");
        expect(metadataHasReopenPendingConsumption(reopened?.metadata)).toBe(false);
        expect(await readFile(join(target, "dirty.txt"), "utf8")).toBe("DIRTY_REOPEN_BYTES");
        const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, workspaceId));
        expect(activity.map(row => row.action)).toContain("execution_workspace.reopen_unconsumed");
        const archive = await executionWorkspaceService(db).archiveWorkspaceUnderLifecycleLock({ id: workspaceId, patch: {}, closedAt: new Date() });
        expect(archive?.outcome).toBe("archived");
        expect(await readFile(join(target, "dirty.txt"), "utf8")).toBe("DIRTY_REOPEN_BYTES");
      } else {
        await expect(assertExecutionWorkspaceRootReadAccess(db, { companyId, cwd: target, actor: authorizationActor })).resolves.toBeUndefined();
      }
      await db.delete(projectWorkspaces).where(eq(projectWorkspaces.id, projectWorkspaceId));
      await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, privateIssueId));
      await rm(source, { recursive: true, force: true });
      for (const cwd of [managed, target]) await expect(assertExecutionWorkspaceRootReadAccess(db, { companyId, cwd, actor: authorizationActor })).rejects.toMatchObject({ status: 403 });
      expect(await readFile(join(target, "private.txt"), "utf8")).toBe("PRIVATE_REOPEN_BYTES");
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
      if (previousPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE; else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacy;
    }
  }, 30_000);

  it("refuses to reopen a workspace in another company", async () => {
    const first = await seedCompanyProject();
    const second = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({
      companyId: first.companyId,
      projectId: first.projectId,
      projectWorkspaceId: first.projectWorkspaceId,
      cwd,
    });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      // The issue belongs to a different company than the workspace.
      issue: { id: randomUUID(), companyId: second.companyId, projectId: second.projectId },
      actor: { agentId: null, actorType: "user" },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_reopenable");

    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("archived");
  });

  it("reports success without a rebuild when the workspace is already active", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({
      companyId,
      projectId,
      projectWorkspaceId,
      cwd,
      status: "active",
      generation: 5,
    });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4104 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reopened).toBe(false);

    const row = await readWorkspace(workspaceId);
    // No reopen ran, so the generation is unchanged.
    expect(readExecutionWorkspaceLifecycleGeneration(row?.metadata as Record<string, unknown> | null)).toBe(5);
  });

  it("runs the destroy under the fence when the generation matches, and skips it after a reopen", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd, generation: 7 });

    const svc = executionWorkspaceService(db);

    // The captured generation matches, so the destroy callback runs.
    const destroyMatches = vi.fn(async () => "destroyed");
    const matched = await svc.fenceClosedWorkspaceDestruction({
      workspaceId,
      capturedGeneration: 7,
      destroy: destroyMatches,
    });
    expect(matched.skippedReopened).toBe(false);
    expect(destroyMatches).toHaveBeenCalledTimes(1);

    // Simulate a reopen: raise the generation and mark the row active.
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        cleanupEligibleAt: null,
        metadata: { [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 8 },
      })
      .where(eq(executionWorkspaces.id, workspaceId));

    // A stale cleanup captured generation 7. The fence must skip the destroy.
    const destroyStale = vi.fn(async () => "destroyed");
    const skipped = await svc.fenceClosedWorkspaceDestruction({
      workspaceId,
      capturedGeneration: 7,
      destroy: destroyStale,
    });
    expect(skipped.skippedReopened).toBe(true);
    expect(destroyStale).not.toHaveBeenCalled();
  });

  it("clears the reopen-pending flag after an unconsumed reopen and stays idempotent", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4109 });

    const svc = executionWorkspaceService(db);
    // The reopen publishes the row as active and sets the reopen-pending flag.
    const reopenResult = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
    });
    expect(reopenResult.ok).toBe(true);
    if (!reopenResult.ok) throw new Error("reopen failed");
    const reopenGeneration = reopenResult.generation;
    const reopenedRow = await readWorkspace(workspaceId);
    expect(metadataHasReopenPendingConsumption(reopenedRow?.metadata as Record<string, unknown> | null)).toBe(true);
    // The reopen stamps the time it set the flag, so the reaper can age a
    // stranded flag out of the way after the grace period.
    expect(readMetadataReopenPendingConsumptionSince(reopenedRow?.metadata as Record<string, unknown> | null))
      .toBeInstanceOf(Date);

    // The caller never consumed the reopen, so clear the flag at its generation.
    const cleared = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: reopenGeneration,
    });
    expect(cleared.cleared).toBe(true);

    const clearedRow = await readWorkspace(workspaceId);
    // The flag is gone, so the terminal reaper can archive and reclaim the row.
    expect(metadataHasReopenPendingConsumption(clearedRow?.metadata as Record<string, unknown> | null)).toBe(false);
    // The clear removes the timestamp too, so no orphan key survives.
    expect((clearedRow?.metadata as Record<string, unknown> | null)?.[EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY])
      .toBeUndefined();
    // The row stays active, so a retried resume can still reuse the rebuilt worktree.
    expect(clearedRow?.status).toBe("active");

    const events = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, workspaceId));
    expect(events.some((event) => event.action === "execution_workspace.reopen_unconsumed")).toBe(true);

    // A second call finds no flag and does nothing.
    const second = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: reopenGeneration,
    });
    expect(second.cleared).toBe(false);
    const eventsAfter = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, workspaceId));
    expect(eventsAfter.filter((event) => event.action === "execution_workspace.reopen_unconsumed").length).toBe(1);
  });

  it("does not clear a newer reopen's fence when a stale request presents an old generation", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd });
    const issueId = await seedIssue({ companyId, projectId, workspaceId, issueNumber: 4115 });

    const svc = executionWorkspaceService(db);
    const reopenResult = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
      authorizationActor: { type: "board", source: "local_implicit", isInstanceAdmin: true },
    });
    expect(reopenResult.ok).toBe(true);
    if (!reopenResult.ok) throw new Error("reopen failed");
    const staleGeneration = reopenResult.generation;

    // Simulate a newer reopen that raised the generation and installed its own
    // fence with a fresh timestamp. This models two overlapping reopen requests.
    const newerGeneration = staleGeneration + 1;
    await db
      .update(executionWorkspaces)
      .set({
        metadata: {
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: newerGeneration,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY]: new Date().toISOString(),
        },
      })
      .where(eq(executionWorkspaces.id, workspaceId));

    // The stale request's response-end clear presents the old generation. It must
    // not clear the newer reopen's live fence.
    const staleClear = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: staleGeneration,
    });
    expect(staleClear.cleared).toBe(false);
    const afterStale = await readWorkspace(workspaceId);
    expect(metadataHasReopenPendingConsumption(afterStale?.metadata as Record<string, unknown> | null)).toBe(true);
    expect(readExecutionWorkspaceLifecycleGeneration(afterStale?.metadata as Record<string, unknown> | null))
      .toBe(newerGeneration);

    // The newer owner clears its own fence at the matching generation.
    const ownerClear = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId,
      issue: { id: issueId, companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: newerGeneration,
    });
    expect(ownerClear.cleared).toBe(true);
    const afterOwner = await readWorkspace(workspaceId);
    expect(metadataHasReopenPendingConsumption(afterOwner?.metadata as Record<string, unknown> | null)).toBe(false);
  });
});
