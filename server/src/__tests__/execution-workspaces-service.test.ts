import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import {
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  executionWorkspaceService,
  mergeExecutionWorkspaceConfig,
  readExecutionWorkspaceConfig,
} from "../services/execution-workspaces.ts";

const execFileAsync = promisify(execFile);

describe("execution workspace config helpers", () => {
  it("reads typed config from persisted metadata", () => {
    expect(readExecutionWorkspaceConfig({
      source: "project_primary",
      config: {
        environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        cleanupCommand: "pkill -f vite || true",
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev", port: 3100 }],
        },
      },
    })).toEqual({
      environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
      provisionCommand: "bash ./scripts/provision-worktree.sh",
      teardownCommand: "bash ./scripts/teardown-worktree.sh",
      cleanupCommand: "pkill -f vite || true",
      desiredState: null,
      serviceStates: null,
      workspaceRuntime: {
        services: [{ name: "web", command: "pnpm dev", port: 3100 }],
      },
    });
  });

  it("merges config patches without dropping unrelated metadata", () => {
    expect(mergeExecutionWorkspaceConfig(
      {
        source: "project_primary",
        createdByRuntime: false,
        config: {
          environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          cleanupCommand: "pkill -f vite || true",
        },
      },
      {
        environmentId: "6286d5a9-9ea7-42b9-98b3-18ee904c26d7",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
    )).toEqual({
      source: "project_primary",
      createdByRuntime: false,
      config: {
        environmentId: "6286d5a9-9ea7-42b9-98b3-18ee904c26d7",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        cleanupCommand: "pkill -f vite || true",
        desiredState: null,
        serviceStates: null,
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
    });
  });

  it("clears a persisted environment selection when patching it to null", () => {
    expect(mergeExecutionWorkspaceConfig(
      {
        source: "project_primary",
        config: {
          environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
        },
      },
      {
        environmentId: null,
      },
    )).toEqual({
      source: "project_primary",
    });
  });

  it("clears the nested config block when requested", () => {
    expect(mergeExecutionWorkspaceConfig(
      {
        source: "project_primary",
        config: {
          provisionCommand: "bash ./scripts/provision-worktree.sh",
        },
      },
      null,
    )).toEqual({
      source: "project_primary",
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution workspace service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-execution-workspace-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["branch", "-M", "main"]);
  return repoRoot;
}

describeEmbeddedPostgres("executionWorkspaceService.getCloseReadiness", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof executionWorkspaceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspaces-service-");
    db = createDb(tempDb.connectionString);
    svc = executionWorkspaceService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows archiving shared workspace sessions with warnings even when issues are still open", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspaces",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
      },
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      isPrimary: true,
      cwd: "/tmp/paperclip-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared workspace",
      status: "active",
      providerType: "local_fs",
      cwd: "/tmp/paperclip-primary",
      metadata: {
        config: {
          teardownCommand: "bash ./scripts/teardown.sh",
        },
      },
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      title: "Still working",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
    });

    const readiness = await svc.getCloseReadiness(executionWorkspaceId);

    expect(readiness).toMatchObject({
      workspaceId: executionWorkspaceId,
      state: "ready_with_warnings",
      isSharedWorkspace: true,
      isProjectPrimaryWorkspace: true,
      isDestructiveCloseAllowed: true,
    });
    expect(readiness?.blockingReasons).toEqual([]);
    expect(readiness?.warnings).toEqual(expect.arrayContaining([
      "This workspace is still linked to an open issue. Archiving it will detach this shared workspace session from those issues, but keep the underlying project workspace available.",
      "This shared workspace session points at project workspace infrastructure. Archiving it only removes the session record.",
    ]));
  });

  it("clears matching environment selections transactionally without touching other workspaces", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const matchingWorkspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const untouchedWorkspaceId = randomUUID();
    const environmentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace cleanup",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
      },
    });
    await db.insert(executionWorkspaces).values([
      {
        id: matchingWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "Matching workspace",
        status: "active",
        providerType: "local_fs",
        cwd: "/tmp/workspace-a",
        metadata: {
          source: "manual",
          config: {
            environmentId,
            cleanupCommand: "echo clean",
          },
        },
      },
      {
        id: otherWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "Different environment",
        status: "active",
        providerType: "local_fs",
        cwd: "/tmp/workspace-b",
        metadata: {
          source: "manual",
          config: {
            environmentId: randomUUID(),
          },
        },
      },
      {
        id: untouchedWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "directory",
        name: "No environment",
        status: "active",
        providerType: "local_fs",
        cwd: "/tmp/workspace-c",
        metadata: {
          source: "manual",
        },
      },
    ]);

    const cleared = await svc.clearEnvironmentSelection(companyId, environmentId);

    expect(cleared).toBe(1);

    const rows = await db
      .select({
        id: executionWorkspaces.id,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [matchingWorkspaceId, otherWorkspaceId, untouchedWorkspaceId]));

    const byId = new Map(rows.map((row) => [row.id, row.metadata as Record<string, unknown> | null]));
    expect(readExecutionWorkspaceConfig(byId.get(matchingWorkspaceId) ?? null)).toMatchObject({
      environmentId: null,
      cleanupCommand: "echo clean",
    });
    expect(readExecutionWorkspaceConfig(byId.get(otherWorkspaceId) ?? null)).toMatchObject({
      environmentId: expect.any(String),
    });
    expect(readExecutionWorkspaceConfig(byId.get(untouchedWorkspaceId) ?? null)).toBeNull();
  });

  it("limits reusable summaries to open non-shared execution workspaces", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const openWorkspaceId = randomUUID();
    const sharedWorkspaceId = randomUUID();
    const closedWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Reusable workspaces",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
      },
    });
    await db.insert(executionWorkspaces).values([
      {
        id: openWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Open isolated workspace",
        status: "idle",
        providerType: "git_worktree",
        cwd: "/tmp/open-workspace",
        branchName: "paperclip/open",
      },
      {
        id: sharedWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Shared session",
        status: "active",
        providerType: "local_fs",
        cwd: "/tmp/project-primary",
      },
      {
        id: closedWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Closed isolated workspace",
        status: "active",
        providerType: "git_worktree",
        cwd: "/tmp/closed-workspace",
        closedAt: new Date("2026-05-23T20:00:00.000Z"),
      },
    ]);

    const summaries = await svc.listSummaries(companyId, {
      projectId,
      reuseEligible: true,
    });

    expect(summaries).toEqual([
      expect.objectContaining({
        id: openWorkspaceId,
        name: "Open isolated workspace",
        mode: "isolated_workspace",
        status: "idle",
        cwd: "/tmp/open-workspace",
        branchName: "paperclip/open",
      }),
    ]);
  });

  it("returns a bounded company-scoped workspace overview with service and linked issue summaries", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const projectId = randomUUID();
    const workspaceAId = "11111111-1111-4111-8111-111111111111";
    const workspaceBId = "22222222-2222-4222-8222-222222222222";
    const archivedWorkspaceId = "33333333-3333-4333-8333-333333333333";
    const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
    const crossCompanyProjectWorkspaceId = "55555555-5555-4555-8555-555555555555";

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: "PAP",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "OtherCo",
        issuePrefix: "OTH",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(projects).values([
      {
        id: projectId,
        companyId,
        name: "Workspaces",
        status: "in_progress",
        executionWorkspacePolicy: {
          enabled: true,
        },
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        name: "Other project",
        status: "in_progress",
      },
    ]);
    const otherProject = await db
      .select({ id: projects.id })
      .from(projects)
      .where(inArray(projects.companyId, [otherCompanyId]))
      .then((rows) => rows[0]!.id);

    await db.insert(executionWorkspaces).values([
      {
        id: workspaceAId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Active A",
        status: "active",
        providerType: "git_worktree",
        cwd: "/tmp/workspace-a",
        branchName: "paperclip/a",
        lastUsedAt: new Date("2026-06-03T10:00:00.000Z"),
        updatedAt: new Date("2026-06-03T10:05:00.000Z"),
        metadata: {
          config: {
            workspaceRuntime: {
              services: [{ name: "web", command: "pnpm dev" }],
            },
          },
        },
      },
      {
        id: workspaceBId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Active B",
        status: "idle",
        providerType: "git_worktree",
        cwd: "/tmp/workspace-b",
        branchName: "paperclip/b",
        lastUsedAt: new Date("2026-06-02T10:00:00.000Z"),
        updatedAt: new Date("2026-06-02T10:05:00.000Z"),
      },
      {
        id: archivedWorkspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Archived",
        status: "archived",
        providerType: "git_worktree",
        cwd: "/tmp/workspace-archived",
        lastUsedAt: new Date("2026-06-04T10:00:00.000Z"),
      },
      {
        id: otherWorkspaceId,
        companyId: otherCompanyId,
        projectId: otherProject,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Other company",
        status: "active",
        providerType: "git_worktree",
        cwd: "/tmp/workspace-other",
        lastUsedAt: new Date("2026-06-05T10:00:00.000Z"),
      },
      {
        id: crossCompanyProjectWorkspaceId,
        companyId,
        projectId: otherProject,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Cross-company project mismatch",
        status: "active",
        providerType: "git_worktree",
        cwd: "/tmp/workspace-cross-company-project",
        lastUsedAt: new Date("2026-06-06T10:00:00.000Z"),
      },
    ]);
    await db.insert(workspaceRuntimeServices).values([
      {
        id: randomUUID(),
        companyId,
        projectId,
        executionWorkspaceId: workspaceAId,
        issueId: null,
        scopeType: "execution_workspace",
        serviceName: "web",
        status: "running",
        lifecycle: "shared",
        command: "pnpm dev",
        cwd: "/tmp/workspace-a",
        port: 3100,
        url: "http://localhost:3100",
        provider: "local_process",
        healthStatus: "healthy",
        updatedAt: new Date("2026-06-03T10:06:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        projectId,
        executionWorkspaceId: workspaceAId,
        issueId: null,
        scopeType: "execution_workspace",
        serviceName: "worker",
        status: "stopped",
        lifecycle: "shared",
        command: "pnpm worker",
        cwd: "/tmp/workspace-a",
        provider: "local_process",
        healthStatus: "unknown",
      },
    ]);
    await db.insert(issues).values(
      Array.from({ length: 5 }, (_, index) => ({
        id: randomUUID(),
        companyId,
        projectId,
        title: `Linked issue ${index + 1}`,
        status: "todo",
        priority: "medium",
        identifier: `PAP-${index + 1}`,
        executionWorkspaceId: workspaceAId,
        updatedAt: new Date(`2026-06-03T09:0${index}:00.000Z`),
      })),
    );
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      projectId,
      title: "Hidden linked issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId: workspaceAId,
      hiddenAt: new Date("2026-06-03T11:00:00.000Z"),
    });

    const overview = await svc.listOverview(companyId, {
      limit: 10,
      offset: 0,
    });

    expect(overview.total).toBe(2);
    expect(overview.items.map((item) => item.workspaceId)).toEqual([workspaceAId, workspaceBId]);
    expect(overview.items.map((item) => item.workspaceId)).not.toContain(archivedWorkspaceId);
    expect(overview.items.map((item) => item.workspaceId)).not.toContain(otherWorkspaceId);
    expect(overview.items.map((item) => item.workspaceId)).not.toContain(crossCompanyProjectWorkspaceId);
    expect(overview.hasMore).toBe(false);

    const activeA = overview.items[0]!;
    expect(activeA).toMatchObject({
      key: `execution:${workspaceAId}`,
      kind: "execution_workspace",
      workspaceName: "Active A",
      projectId,
      projectUrlKey: "workspaces",
      projectName: "Workspaces",
      branchName: "paperclip/a",
      serviceCount: 2,
      runningServiceCount: 1,
      primaryServiceUrl: "http://localhost:3100",
      primaryServiceUrlRunning: true,
      hasRuntimeConfig: true,
      linkedIssueCount: 5,
    });
    expect(activeA.primaryService).toMatchObject({
      serviceName: "web",
      status: "running",
      url: "http://localhost:3100",
      port: 3100,
      healthStatus: "healthy",
    });
    expect(activeA.linkedIssues).toHaveLength(4);
    expect(activeA.linkedIssues.map((issue) => issue.title)).toEqual([
      "Linked issue 5",
      "Linked issue 4",
      "Linked issue 3",
      "Linked issue 2",
    ]);
  });

  it("supports status and project filters with stable limit/offset pagination", async () => {
    const companyId = randomUUID();
    const projectAId = randomUUID();
    const projectBId = randomUUID();
    const activeWorkspaceId = "55555555-5555-4555-8555-555555555555";
    const idleWorkspaceId = "66666666-6666-4666-8666-666666666666";
    const archivedWorkspaceId = "77777777-7777-4777-8777-777777777777";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values([
      {
        id: projectAId,
        companyId,
        name: "Project A",
        status: "in_progress",
      },
      {
        id: projectBId,
        companyId,
        name: "Project B",
        status: "in_progress",
      },
    ]);
    await db.insert(executionWorkspaces).values([
      {
        id: activeWorkspaceId,
        companyId,
        projectId: projectAId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Newest active",
        status: "active",
        providerType: "git_worktree",
        lastUsedAt: new Date("2026-06-03T10:00:00.000Z"),
      },
      {
        id: idleWorkspaceId,
        companyId,
        projectId: projectAId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Older idle",
        status: "idle",
        providerType: "git_worktree",
        lastUsedAt: new Date("2026-06-02T10:00:00.000Z"),
      },
      {
        id: archivedWorkspaceId,
        companyId,
        projectId: projectBId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Archived",
        status: "archived",
        providerType: "git_worktree",
        lastUsedAt: new Date("2026-06-04T10:00:00.000Z"),
      },
    ]);

    const secondPage = await svc.listOverview(companyId, {
      projectId: projectAId,
      limit: 1,
      offset: 1,
    });

    expect(secondPage.total).toBe(2);
    expect(secondPage.items.map((item) => item.workspaceId)).toEqual([idleWorkspaceId]);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextOffset).toBeNull();

    const archivedOnly = await svc.listOverview(companyId, {
      status: ["archived"],
      limit: 10,
      offset: 0,
    });

    expect(archivedOnly.total).toBe(1);
    expect(archivedOnly.items.map((item) => item.workspaceId)).toEqual([archivedWorkspaceId]);
  });

  it("warns about dirty and unmerged git worktrees and reports cleanup actions", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-worktree-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "paperclip-close-check"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "paperclip-close-check"]);
    await fs.writeFile(path.join(worktreePath, "feature.txt"), "hello\n", "utf8");
    await runGit(worktreePath, ["add", "feature.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Feature commit"]);
    await fs.writeFile(path.join(worktreePath, "untracked.txt"), "left behind\n", "utf8");

    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspaces",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        workspaceStrategy: {
          type: "git_worktree",
          teardownCommand: "bash ./scripts/project-teardown.sh",
        },
      },
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "git_repo",
      isPrimary: true,
      cwd: repoRoot,
      cleanupCommand: "printf 'project cleanup\\n'",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Feature workspace",
      status: "active",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "paperclip-close-check",
      baseRef: "main",
      metadata: {
        createdByRuntime: true,
        config: {
          cleanupCommand: "printf 'workspace cleanup\\n'",
        },
      },
    });

    const readiness = await svc.getCloseReadiness(executionWorkspaceId);

    expect(readiness).toMatchObject({
      workspaceId: executionWorkspaceId,
      state: "ready_with_warnings",
      isSharedWorkspace: false,
      isProjectPrimaryWorkspace: false,
      isDestructiveCloseAllowed: true,
      git: {
        workspacePath: worktreePath,
        branchName: "paperclip-close-check",
        baseRef: "main",
        createdByRuntime: true,
        hasDirtyTrackedFiles: false,
        hasUntrackedFiles: true,
        aheadCount: 1,
        behindCount: 0,
        isMergedIntoBase: false,
      },
    });
    expect(readiness?.warnings).toEqual(expect.arrayContaining([
      "The workspace has 1 untracked file.",
      "This workspace is 1 commit ahead of main and is not merged.",
    ]));
    expect(readiness?.plannedActions.map((action) => action.kind)).toEqual(expect.arrayContaining([
      "archive_record",
      "cleanup_command",
      "teardown_command",
      "git_worktree_remove",
      "git_branch_delete",
    ]));
  }, 20_000);
});
