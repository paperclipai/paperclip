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
