import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        cleanupCommand: "pkill -f vite || true",
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev", port: 3100 }],
        },
      },
    })).toEqual({
      provisionCommand: "bash ./scripts/provision-worktree.sh",
      teardownCommand: "bash ./scripts/teardown-worktree.sh",
      cleanupCommand: "pkill -f vite || true",
      desiredState: null,
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
          provisionCommand: "bash ./scripts/provision-worktree.sh",
          cleanupCommand: "pkill -f vite || true",
        },
      },
      {
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
    )).toEqual({
      source: "project_primary",
      createdByRuntime: false,
      config: {
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        cleanupCommand: "pkill -f vite || true",
        desiredState: null,
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev" }],
        },
      },
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
    await db.delete(issues);
    await db.delete(workspaceRuntimeServices);
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

  it("shows inherited shared project runtime services on shared execution workspaces without duplicating old history", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const olderServiceId = randomUUID();
    const currentServiceId = randomUUID();
    const reuseKey = `project_workspace:${projectWorkspaceId}:paperclip-dev`;
    const startedAt = new Date("2026-04-04T17:00:00.000Z");
    const stoppedAt = new Date("2026-04-04T17:05:00.000Z");
    const runningAt = new Date("2026-04-04T17:10:00.000Z");

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
      metadata: {
        runtimeConfig: {
          desiredState: "running",
          workspaceRuntime: {
            services: [{ name: "paperclip-dev", command: "pnpm dev" }],
          },
        },
      },
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
    });
    await db.insert(workspaceRuntimeServices).values([
      {
        id: olderServiceId,
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: null,
        issueId: null,
        scopeType: "project_workspace",
        scopeId: projectWorkspaceId,
        serviceName: "paperclip-dev",
        status: "stopped",
        lifecycle: "shared",
        reuseKey,
        command: "pnpm dev",
        cwd: "/tmp/paperclip-primary",
        port: 49195,
        url: "http://127.0.0.1:49195",
        provider: "local_process",
        providerRef: "11111",
        ownerAgentId: null,
        startedByRunId: null,
        lastUsedAt: stoppedAt,
        startedAt,
        stoppedAt,
        stopPolicy: { type: "manual" },
        healthStatus: "unknown",
        createdAt: startedAt,
        updatedAt: stoppedAt,
      },
      {
        id: currentServiceId,
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: null,
        issueId: null,
        scopeType: "project_workspace",
        scopeId: projectWorkspaceId,
        serviceName: "paperclip-dev",
        status: "running",
        lifecycle: "shared",
        reuseKey,
        command: "pnpm dev",
        cwd: "/tmp/paperclip-primary",
        port: 49222,
        url: "http://127.0.0.1:49222",
        provider: "local_process",
        providerRef: "22222",
        ownerAgentId: null,
        startedByRunId: null,
        lastUsedAt: runningAt,
        startedAt: runningAt,
        stoppedAt: null,
        stopPolicy: { type: "manual" },
        healthStatus: "healthy",
        createdAt: runningAt,
        updatedAt: runningAt,
      },
    ]);

    const workspace = await svc.getById(executionWorkspaceId);
    const listed = await svc.list(companyId, { projectId });

    expect(workspace?.runtimeServices).toHaveLength(1);
    expect(workspace?.runtimeServices?.[0]).toMatchObject({
      id: currentServiceId,
      status: "running",
      projectWorkspaceId,
      executionWorkspaceId: null,
      url: "http://127.0.0.1:49222",
    });
    expect(listed[0]?.runtimeServices).toHaveLength(1);
    expect(listed[0]?.runtimeServices?.[0]?.id).toBe(currentServiceId);
  });
});
