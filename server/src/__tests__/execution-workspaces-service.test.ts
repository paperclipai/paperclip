import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import express from "express";
import supertest from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ExecutionWorkspaceAdoptionError,
  executionWorkspaceService,
  mergeExecutionWorkspaceConfig,
  readExecutionWorkspaceConfig,
} from "../services/execution-workspaces.ts";
import {
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import { errorHandler } from "../middleware/index.ts";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.ts";
import { issueRoutes } from "../routes/issues.ts";

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

async function readGit(cwd: string, args: string[]) {
  const output = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  return output.stdout.trim() || null;
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

async function createAdoptionGitFixture(options: {
  branch?: string;
  upstream?: string;
  repoUrl?: string;
  worktreeSlug?: string;
} = {}) {
  const branch = options.branch ?? "feature/exact";
  const upstream = options.upstream ?? `origin/${branch}`;
  const repoUrl = options.repoUrl ?? "git@example.com:paperclip/repo.git";
  const repoRoot = await createTempRepo();
  const worktreePath = path.join(path.dirname(repoRoot), `${options.worktreeSlug ?? "paperclip-adopt"}-${randomUUID()}`);

  await runGit(repoRoot, ["remote", "add", "origin", repoUrl]);
  await runGit(repoRoot, ["branch", branch]);
  const headSha = await readGit(repoRoot, ["rev-parse", branch]);
  await runGit(repoRoot, ["update-ref", `refs/remotes/${upstream}`, headSha!]);
  await runGit(repoRoot, ["branch", "--set-upstream-to", upstream, branch]);
  await runGit(repoRoot, ["worktree", "add", worktreePath, branch]);

  return {
    repoRoot,
    worktreePath,
    branch,
    fullBranchRef: `refs/heads/${branch}`,
    upstream,
    repoUrl,
    headSha: headSha!,
  };
}

async function seedAdoptionScope(db: ReturnType<typeof createDb>, input: {
  companyId?: string;
  projectId?: string;
  projectWorkspaceId?: string;
  sourceIssueId?: string;
  bindIssueId?: string | null;
  repoRoot: string;
  repoUrl?: string | null;
}) {
  const companyId = input.companyId ?? randomUUID();
  const projectId = input.projectId ?? randomUUID();
  const projectWorkspaceId = input.projectWorkspaceId ?? randomUUID();
  const sourceIssueId = input.sourceIssueId ?? randomUUID();
  const bindIssueId = input.bindIssueId === undefined ? randomUUID() : input.bindIssueId;

  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Exact branch adoption",
    status: "in_progress",
  });
  await db.insert(projectWorkspaces).values({
    id: projectWorkspaceId,
    companyId,
    projectId,
    name: "Primary",
    cwd: input.repoRoot,
    repoUrl: input.repoUrl ?? "git@example.com:paperclip/repo.git",
    isPrimary: true,
  });

  const issueRows = [
    {
      id: sourceIssueId,
      companyId,
      projectId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
    },
  ];
  if (bindIssueId) {
    issueRows.push({
      id: bindIssueId,
      companyId,
      projectId,
      title: "Bound issue",
      status: "todo",
      priority: "medium",
    });
  }
  await db.insert(issues).values(issueRows);

  return {
    companyId,
    projectId,
    projectWorkspaceId,
    sourceIssueId,
    bindIssueId,
  };
}

function adoptionRequest(input: Awaited<ReturnType<typeof createAdoptionGitFixture>> & Awaited<ReturnType<typeof seedAdoptionScope>>, patch: Partial<{
  bindIssueId: string | null;
  cwd: string;
  expectedBranch: string;
  expectedHeadSha: string;
  expectedUpstream: string;
  expectedRepoUrl: string | null;
  name: string;
}> = {}) {
  return {
    projectId: input.projectId,
    projectWorkspaceId: input.projectWorkspaceId,
    sourceIssueId: input.sourceIssueId,
    bindIssueId: patch.bindIssueId === undefined ? input.bindIssueId : patch.bindIssueId,
    cwd: patch.cwd ?? input.worktreePath,
    expectedBranch: patch.expectedBranch ?? input.fullBranchRef,
    expectedHeadSha: patch.expectedHeadSha ?? input.headSha,
    expectedUpstream: patch.expectedUpstream ?? input.upstream,
    expectedRepoUrl: patch.expectedRepoUrl === undefined ? input.repoUrl : patch.expectedRepoUrl,
    name: patch.name ?? input.branch,
  };
}

async function countAdoptionSideEffects(db: ReturnType<typeof createDb>) {
  const [workspaceCount] = await db.select({ count: sql<number>`count(*)::int` }).from(executionWorkspaces);
  const [operationCount] = await db.select({ count: sql<number>`count(*)::int` }).from(workspaceOperations);
  const [activityCount] = await db.select({ count: sql<number>`count(*)::int` }).from(activityLog);
  return {
    workspaces: workspaceCount?.count ?? 0,
    operations: operationCount?.count ?? 0,
    activity: activityCount?.count ?? 0,
  };
}

async function readIssueAuthorizationSnapshot(db: ReturnType<typeof createDb>, issueId: string) {
  return db
    .select({
      id: issues.id,
      parentId: issues.parentId,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      status: issues.status,
      executionPolicy: issues.executionPolicy,
      originKind: issues.originKind,
      originId: issues.originId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
}

async function waitForPath(filePath: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function stableStringifyForTest(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyForTest(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((key) => `${JSON.stringify(key)}:${stableStringifyForTest(rec[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprintAdoptionForTest(input: {
  companyId: string;
  projectId: string;
  projectWorkspaceId: string;
  sourceIssueId: string;
  canonicalCwd: string;
  repoRoot: string;
  normalizedRepoUrl: string | null;
  fullBranchRef: string;
  headSha: string;
  upstream: string;
}) {
  const digest = createHash("sha256")
    .update(stableStringifyForTest({ version: 1, kind: "execution_workspace_adoption", ...input }))
    .digest("hex");
  return `execution_workspace_adoption:v1:sha256:${digest}`;
}

async function fingerprintWorkspaceBranchIncoherenceForTest(input: {
  repoRoot: string;
  worktreePath: string;
  sourceIssueId: string;
  executionWorkspaceId: string;
  expectedBranch: string;
  actualBranch: string | null;
}) {
  const status = await execFileAsync("git", ["-C", input.worktreePath, "status", "--porcelain", "--untracked-files=all"], {
    cwd: input.worktreePath,
  }).then((output) => output.stdout).catch(() => null);
  const expectedHeadSha = await readGit(input.repoRoot, ["rev-parse", "--verify", `refs/heads/${input.expectedBranch}^{commit}`])
    .catch(() => null);
  const actualHeadSha = await readGit(input.worktreePath, ["rev-parse", "HEAD"]).catch(() => null);
  const cleanliness = status === null ? "unknown" : status.trim().length > 0 ? "dirty" : "clean";
  const digest = createHash("sha256")
    .update(stableStringifyForTest({
      version: 1,
      reason: "git_worktree_branch_incoherence",
      sourceIssueId: input.sourceIssueId,
      executionWorkspaceId: input.executionWorkspaceId,
      worktreePath: path.resolve(input.worktreePath),
      expectedBranch: input.expectedBranch,
      actualBranch: input.actualBranch,
      cleanliness,
      expectedHeadSha,
      actualHeadSha,
    }))
    .digest("hex");
  return `workspace_incoherence:v1:sha256:${digest}`;
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
    await db.delete(workspaceOperations);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
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

  it("reconciles a forward branch record, comments on the source issue, and resolves matching workspace recovery", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-reconcile-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "feature/recorded"]);
    await runGit(repoRoot, ["branch", "feature/current", "feature/recorded"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "feature/current"]);
    await fs.writeFile(path.join(worktreePath, "feature.txt"), "current branch\n", "utf8");
    await runGit(worktreePath, ["add", "feature.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Current branch work"]);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const actualBranch = await readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const fingerprint = await fingerprintWorkspaceBranchIncoherenceForTest({
      repoRoot,
      worktreePath,
      sourceIssueId: issueId,
      executionWorkspaceId,
      expectedBranch: "feature/recorded",
      actualBranch,
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      identifier: "PAP-123",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "feature/recorded",
      status: "idle",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "workspace_validation",
      status: "active",
      ownerType: "board",
      cause: "workspace_validation_failed",
      fingerprint,
      evidence: {
        workspaceValidation: {
          fingerprint,
        },
      },
      nextAction: "Repair the source issue workspace link.",
    });

    const result = await svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
      mode: "forward",
      reason: null,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });

    expect(result.workspace.branchName).toBe("feature/current");
    expect(result.workspace.name).toBe("feature/current");
    expect(result.inspection).toMatchObject({
      fromBranch: "feature/recorded",
      toBranch: "feature/current",
      ancestryVerdict: "ancestor",
      fingerprint,
    });
    expect(result.recoveryAction).toMatchObject({
      kind: "workspace_validation",
      status: "resolved",
      outcome: "restored",
      fingerprint,
    });

    const [comment] = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comment).toMatchObject({
      companyId,
      issueId,
      authorType: "user",
      authorUserId: "local-board",
    });
    expect(comment?.body).toContain("Execution workspace branch reconciled.");
    expect(comment?.body).toContain("- Mode: `forward`");
    expect(comment?.body).toContain("- From branch: `feature/recorded`");
    expect(comment?.body).toContain("- To branch: `feature/current`");
    expect(comment?.body).toContain(`- Fingerprint: \`${fingerprint}\``);
    expect(comment?.body).toContain(`- Recovery action: \`${result.recoveryAction?.id}\``);

    const [recoveryAction] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(recoveryAction).toMatchObject({
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Execution workspace branch record reconciled from \"feature/recorded\" to \"feature/current\".",
    });
  }, 20_000);

  it("quarantine_restore rescues dirty live-branch work, resolves recovery, and returns the source issue to todo", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-quarantine-restore-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "feature/recorded"]);
    await runGit(repoRoot, ["worktree", "add", "-b", "feature/live", worktreePath, "feature/recorded"]);
    await fs.appendFile(path.join(worktreePath, "README.md"), "dirty tracked work\n", "utf8");
    await fs.writeFile(path.join(worktreePath, "untracked.txt"), "dirty untracked work\n", "utf8");

    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const actualBranch = await readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const fingerprint = await fingerprintWorkspaceBranchIncoherenceForTest({
      repoRoot,
      worktreePath,
      sourceIssueId: issueId,
      executionWorkspaceId,
      expectedBranch: "feature/recorded",
      actualBranch,
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Codex Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: repoRoot,
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source task",
      identifier: "PAP-124",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "feature/recorded",
      status: "active",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "workspace_validation",
      status: "active",
      ownerType: "board",
      cause: "workspace_validation_failed",
      fingerprint,
      evidence: {
        workspaceValidation: {
          fingerprint,
        },
      },
      nextAction: "Repair the source issue workspace link.",
    });

    const result = await svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
      mode: "quarantine_restore",
      reason: "rescue dirty work and restore recorded branch",
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });

    expect(result.workspace.branchName).toBe("feature/recorded");
    expect(result.inspection).toMatchObject({
      fromBranch: "feature/recorded",
      toBranch: "feature/live",
      cleanliness: "dirty",
      fingerprint,
    });
    expect(result.rescueRef).toMatchObject({
      branchName: expect.stringMatching(/^paperclip\/rescue\/PAP-124\/\d{8}T\d{6}Z$/),
      fileCount: 2,
    });
    expect(result.restoredSourceIssue).toMatchObject({
      id: issueId,
      status: "todo",
      assigneeAgentId: agentId,
    });
    expect(result.sourceIssueStatusChanged).toBe(true);
    expect(result.recoveryAction).toMatchObject({
      kind: "workspace_validation",
      status: "resolved",
      outcome: "restored",
      fingerprint,
    });

    const rescueRef = result.rescueRef!.branchName;
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe("feature/recorded");
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.toBeNull();
    await expect(readGit(repoRoot, ["show", `${rescueRef}:untracked.txt`])).resolves.toBe("dirty untracked work");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue).toMatchObject({
      status: "todo",
      checkoutRunId: null,
      executionRunId: null,
    });

    const [recoveryAction] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(recoveryAction).toMatchObject({
      status: "resolved",
      outcome: "restored",
      resolutionNote: `Execution workspace dirty worktree quarantined on "${rescueRef}" and restored recorded branch "feature/recorded".`,
    });

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(issueComments.createdAt);
    expect(comments).toHaveLength(2);
    expect(comments[0]?.body).toContain("Execution workspace dirty worktree quarantined before restore.");
    expect(comments[0]?.body).toContain(`Rescue branch: \`${rescueRef}\``);
    expect(comments[1]?.body).toContain("Execution workspace branch reconciled.");
    expect(comments[1]?.body).toContain("- Mode: `quarantine_restore`");
    expect(comments[1]?.body).toContain(`- Rescue ref: \`${rescueRef}\``);
  }, 20_000);

  it("quarantine_restore rejects active runtime services before creating a rescue branch", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-quarantine-running-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "feature/recorded"]);
    await runGit(repoRoot, ["worktree", "add", "-b", "feature/live", worktreePath, "feature/recorded"]);
    await fs.appendFile(path.join(worktreePath, "README.md"), "dirty tracked work\n", "utf8");

    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const runtimeServiceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      identifier: "PAP-125",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "feature/recorded",
      status: "active",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });
    await db.insert(workspaceRuntimeServices).values({
      id: runtimeServiceId,
      companyId,
      projectId,
      executionWorkspaceId,
      issueId,
      scopeType: "execution_workspace",
      serviceName: "web",
      status: "running",
      lifecycle: "shared",
      command: "pnpm dev",
      cwd: worktreePath,
      provider: "local_process",
      healthStatus: "healthy",
    });

    await expect(svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
      mode: "quarantine_restore",
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "Execution workspace branch reconciliation requires all runtime services to be stopped",
      details: {
        inspection: expect.objectContaining({
          cleanliness: "dirty",
          fromBranch: "feature/recorded",
          toBranch: "feature/live",
        }),
        runtimeServices: [
          {
            id: runtimeServiceId,
            serviceName: "web",
            status: "running",
          },
        ],
      },
    });

    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe("feature/live");
    await expect(readGit(
      repoRoot,
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/paperclip/rescue"],
    )).resolves.toBeNull();
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  }, 20_000);

  it.each(["review", "approval"] as const)(
    "quarantine_restore preserves pending execution-%s semantics on the source issue",
    async (stageType) => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-quarantine-${stageType}-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "feature/recorded"]);
    await runGit(repoRoot, ["worktree", "add", "-b", "feature/live", worktreePath, "feature/recorded"]);
    await fs.appendFile(path.join(worktreePath, "README.md"), "dirty tracked review work\n", "utf8");

    const companyId = randomUUID();
    const coderAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const reviewStageId = randomUUID();
    const actualBranch = await readGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const fingerprint = await fingerprintWorkspaceBranchIncoherenceForTest({
      repoRoot,
      worktreePath,
      sourceIssueId: issueId,
      executionWorkspaceId,
      expectedBranch: "feature/recorded",
      actualBranch,
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: coderAgentId,
        companyId,
        name: "Codex Coder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "QA Reviewer",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: repoRoot,
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source task awaiting review",
      identifier: "PAP-125",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: coderAgentId,
      executionPolicy: {
        stages: [
          {
            id: reviewStageId,
            type: stageType,
            participants: [{ type: "agent", agentId: reviewerAgentId }],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: stageType,
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "feature/recorded",
      status: "active",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "workspace_validation",
      status: "active",
      ownerType: "board",
      cause: "workspace_validation_failed",
      fingerprint,
      evidence: {
        workspaceValidation: {
          fingerprint,
        },
      },
      nextAction: "Repair the source issue workspace link.",
    });

    const result = await svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
      mode: "quarantine_restore",
      reason: "rescue dirty work and restore recorded branch",
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });

    expect(result.restoredSourceIssue).toMatchObject({
      id: issueId,
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
    });
    expect(result.sourceIssueStatusChanged).toBe(true);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(sourceIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
    });
    expect(sourceIssue?.executionState).toMatchObject({
      status: "pending",
      currentStageId: reviewStageId,
      currentStageType: stageType,
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
      returnAssignee: { type: "agent", agentId: coderAgentId },
    });
  }, 20_000);

  it.each([
    {
      claimantLabel: "active",
      claimantIssueIdentifier: "PAP-126",
      claimantHasActiveRun: true,
      expectedReason: "active run",
    },
    {
      claimantLabel: "idle",
      claimantIssueIdentifier: "PAP-127",
      claimantHasActiveRun: false,
      expectedReason: "no active run",
    },
  ])(
    "quarantine_restore refuses dirty repair when the live branch has a $claimantLabel claimant",
    async ({ claimantIssueIdentifier, claimantHasActiveRun, expectedReason }) => {
      const repoRoot = await createTempRepo();
      tempDirs.add(repoRoot);
      const worktreePath = path.join(path.dirname(repoRoot), `paperclip-quarantine-claimant-${randomUUID()}`);
      tempDirs.add(worktreePath);

      await runGit(repoRoot, ["branch", "feature/recorded"]);
      await runGit(repoRoot, ["worktree", "add", "-b", "feature/live", worktreePath, "feature/recorded"]);
      await fs.appendFile(path.join(worktreePath, "README.md"), "dirty tracked work\n", "utf8");
      await fs.writeFile(path.join(worktreePath, "untracked.txt"), "dirty untracked work\n", "utf8");

      const companyId = randomUUID();
      const agentId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const issueId = randomUUID();
      const claimantIssueId = randomUUID();
      const executionWorkspaceId = randomUUID();
      const claimantWorkspaceId = randomUUID();
      const claimantRunId = claimantHasActiveRun ? randomUUID() : null;
      const claimantWorkspacePath = path.join(path.dirname(repoRoot), `paperclip-claimant-${randomUUID()}`);
      const now = new Date();

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: "PAP",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Codex Coder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Branch reconcile",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Primary",
        cwd: repoRoot,
        isPrimary: true,
      });
      if (claimantRunId) {
        await db.insert(heartbeatRuns).values({
          id: claimantRunId,
          companyId,
          agentId,
          invocationSource: "manual",
          status: "running",
          startedAt: now,
          updatedAt: now,
        });
      }
      await db.insert(issues).values([
        {
          id: issueId,
          companyId,
          projectId,
          projectWorkspaceId,
          title: "Source task",
          identifier: "PAP-125",
          status: "blocked",
          priority: "medium",
          assigneeAgentId: agentId,
        },
        {
          id: claimantIssueId,
          companyId,
          projectId,
          projectWorkspaceId,
          title: claimantHasActiveRun ? "Active claimant" : "Idle claimant",
          identifier: claimantIssueIdentifier,
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
          executionRunId: claimantRunId,
        },
      ]);
      await db.insert(executionWorkspaces).values([
        {
          id: executionWorkspaceId,
          companyId,
          projectId,
          projectWorkspaceId,
          sourceIssueId: issueId,
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: "feature/recorded",
          status: "active",
          providerType: "git_worktree",
          cwd: worktreePath,
          providerRef: worktreePath,
          branchName: "feature/recorded",
          baseRef: "main",
        },
        {
          id: claimantWorkspaceId,
          companyId,
          projectId,
          projectWorkspaceId,
          sourceIssueId: claimantIssueId,
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: "feature/live",
          status: "active",
          providerType: "git_worktree",
          cwd: claimantWorkspacePath,
          providerRef: claimantWorkspacePath,
          branchName: "feature/live",
          baseRef: "main",
          lastUsedAt: new Date(now.getTime() + 1_000),
          updatedAt: new Date(now.getTime() + 1_000),
        },
      ]);
      await db
        .update(issues)
        .set({ executionWorkspaceId: claimantWorkspaceId })
        .where(eq(issues.id, claimantIssueId));

      await expect(svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
        mode: "quarantine_restore",
        reason: "should refuse branch claimant",
        actor: {
          actorType: "user",
          actorId: "local-board",
          agentId: null,
          runId: null,
        },
      })).rejects.toMatchObject({
        status: 422,
        details: {
          code: "workspace_validation_failed",
          workspaceValidation: expect.objectContaining({
            cleanliness: "dirty",
            contention: expect.objectContaining({
              claimedByWorkspaceId: claimantWorkspaceId,
              claimedByIssueIdentifier: claimantIssueIdentifier,
              activeRun: claimantRunId
                ? expect.objectContaining({
                    id: claimantRunId,
                    status: "running",
                  })
                : null,
            }),
            safeRepair: expect.objectContaining({
              eligible: false,
              succeeded: false,
              reason: expect.stringContaining(expectedReason),
            }),
          }),
        },
      });

      await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe("feature/live");
      await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.not.toBeNull();
    },
    20_000,
  );

  it("rejects branch reconciliation when the worktree is dirty", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-dirty-reconcile-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "feature/recorded"]);
    await runGit(repoRoot, ["branch", "feature/current", "feature/recorded"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "feature/current"]);
    await fs.writeFile(path.join(worktreePath, "feature.txt"), "current branch\n", "utf8");
    await runGit(worktreePath, ["add", "feature.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Current branch work"]);
    await fs.writeFile(path.join(worktreePath, "dirty.txt"), "not safe to mutate\n", "utf8");

    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
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
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Dirty workspace",
      status: "idle",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });

    await expect(svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
      mode: "override",
      reason: "operator override still requires idle clean workspace",
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "Execution workspace branch reconciliation requires a clean worktree",
      details: {
        inspection: expect.objectContaining({
          cleanliness: "dirty",
          statusEntryCount: 1,
          fromBranch: "feature/recorded",
          toBranch: "feature/current",
        }),
      },
    });

    const [workspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    expect(workspace?.branchName).toBe("feature/recorded");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  }, 20_000);

  it("rejects branch reconciliation while the workspace lifecycle is active", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-active-reconcile-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "feature/recorded"]);
    await runGit(repoRoot, ["branch", "feature/current", "feature/recorded"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "feature/current"]);
    await fs.writeFile(path.join(worktreePath, "feature.txt"), "current branch\n", "utf8");
    await runGit(worktreePath, ["add", "feature.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Current branch work"]);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
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
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Active workspace",
      status: "active",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });

    await expect(svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
      mode: "override",
      reason: "operator override still requires idle workspace",
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "Execution workspace branch reconciliation requires the workspace to be idle",
      details: {
        workspaceStatus: "active",
        inspection: expect.objectContaining({
          cleanliness: "clean",
          fromBranch: "feature/recorded",
          toBranch: "feature/current",
        }),
      },
    });

    const [workspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    expect(workspace?.branchName).toBe("feature/recorded");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  }, 20_000);

  it("rejects branch reconciliation if the workspace becomes active before the branch record update", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-race-reconcile-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "feature/recorded"]);
    await runGit(repoRoot, ["branch", "feature/current", "feature/recorded"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "feature/current"]);
    await fs.writeFile(path.join(worktreePath, "feature.txt"), "current branch\n", "utf8");
    await runGit(worktreePath, ["add", "feature.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Current branch work"]);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
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
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Race workspace",
      status: "idle",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });

    const originalTransaction = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation(
      (async (...args: Parameters<typeof db.transaction>) => {
        await db
          .update(executionWorkspaces)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(executionWorkspaces.id, executionWorkspaceId));
        return originalTransaction(...args);
      }) as typeof db.transaction,
    );

    try {
      await expect(svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
        mode: "override",
        reason: "operator override still requires idle workspace at write time",
        actor: {
          actorType: "user",
          actorId: "local-board",
          agentId: null,
          runId: null,
        },
      })).rejects.toMatchObject({
        status: 422,
        message: "Execution workspace branch reconciliation requires the workspace to be idle",
        details: {
          workspaceStatus: "active",
          inspection: expect.objectContaining({
            cleanliness: "clean",
            fromBranch: "feature/recorded",
            toBranch: "feature/current",
          }),
        },
      });
    } finally {
      transactionSpy.mockRestore();
    }

    const [workspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    expect(workspace).toMatchObject({
      status: "active",
      branchName: "feature/recorded",
    });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  }, 20_000);

  it("rejects branch reconciliation while runtime services are active", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-running-reconcile-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "feature/recorded"]);
    await runGit(repoRoot, ["branch", "feature/current", "feature/recorded"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "feature/current"]);
    await fs.writeFile(path.join(worktreePath, "feature.txt"), "current branch\n", "utf8");
    await runGit(worktreePath, ["add", "feature.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Current branch work"]);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const runtimeServiceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Runtime workspace",
      status: "idle",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });
    await db.insert(workspaceRuntimeServices).values({
      id: runtimeServiceId,
      companyId,
      projectId,
      executionWorkspaceId,
      issueId,
      scopeType: "execution_workspace",
      serviceName: "web",
      status: "running",
      lifecycle: "shared",
      command: "pnpm dev",
      cwd: worktreePath,
      provider: "local_process",
      healthStatus: "healthy",
    });

    await expect(svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
      mode: "override",
      reason: "operator override still requires stopped services",
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "Execution workspace branch reconciliation requires all runtime services to be stopped",
      details: {
        inspection: expect.objectContaining({
          cleanliness: "clean",
          fromBranch: "feature/recorded",
          toBranch: "feature/current",
        }),
        runtimeServices: [
          {
            id: runtimeServiceId,
            serviceName: "web",
            status: "running",
          },
        ],
      },
    });

    const [workspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    expect(workspace?.branchName).toBe("feature/recorded");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  }, 20_000);

  it("rejects branch reconciliation when a runtime service starts before the locked update", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-raced-service-reconcile-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "feature/recorded"]);
    await runGit(repoRoot, ["branch", "feature/current", "feature/recorded"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "feature/current"]);
    await fs.writeFile(path.join(worktreePath, "feature.txt"), "current branch\n", "utf8");
    await runGit(worktreePath, ["add", "feature.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Current branch work"]);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const runtimeServiceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Runtime race workspace",
      status: "idle",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });

    let releaseBlockingTransaction: (() => void) | null = null;
    const releaseBlockingTransactionPromise = new Promise<void>((resolve) => {
      releaseBlockingTransaction = resolve;
    });
    let blockingTransactionReadyResolve: (() => void) | null = null;
    const blockingTransactionReady = new Promise<void>((resolve) => {
      blockingTransactionReadyResolve = resolve;
    });

    const blockingTransaction = db.transaction(async (tx) => {
      await tx.execute(sql`select id from ${executionWorkspaces} where ${executionWorkspaces.id} = ${executionWorkspaceId} for update`);
      await tx.insert(workspaceRuntimeServices).values({
        id: runtimeServiceId,
        companyId,
        projectId,
        executionWorkspaceId,
        issueId,
        scopeType: "execution_workspace",
        serviceName: "web",
        status: "running",
        lifecycle: "shared",
        command: "pnpm dev",
        cwd: worktreePath,
        provider: "local_process",
        healthStatus: "healthy",
      });
      blockingTransactionReadyResolve?.();
      await releaseBlockingTransactionPromise;
    });

    await blockingTransactionReady;

    const reconcileExpectation = expect(svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
      mode: "override",
      reason: "operator override still requires stopped services",
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "Execution workspace branch reconciliation requires all runtime services to be stopped",
      details: {
        inspection: expect.objectContaining({
          cleanliness: "clean",
          fromBranch: "feature/recorded",
          toBranch: "feature/current",
        }),
        runtimeServices: [
          {
            id: runtimeServiceId,
            serviceName: "web",
            status: "running",
          },
        ],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseBlockingTransaction?.();
    await reconcileExpectation;
    await blockingTransaction;

    const [workspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    expect(workspace?.branchName).toBe("feature/recorded");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  }, 20_000);

  it("rejects branch reconciliation when runtime service activation is already spawning", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-spawning-service-reconcile-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "feature/recorded"]);
    await runGit(repoRoot, ["branch", "feature/current", "feature/recorded"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "feature/current"]);
    await fs.writeFile(path.join(worktreePath, "feature.txt"), "current branch\n", "utf8");
    await runGit(worktreePath, ["add", "feature.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Current branch work"]);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const runtimeStartedMarker = path.join(os.tmpdir(), `paperclip-runtime-started-${randomUUID()}.marker`);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Runtime activation race workspace",
      status: "idle",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });

    const serverScript = [
      `require("node:fs").writeFileSync(${JSON.stringify(runtimeStartedMarker)}, "started");`,
      "setTimeout(() => {",
      "  require(\"node:http\")",
      "    .createServer((_req, res) => { res.end(\"ok\"); })",
      "    .listen(Number(process.env.PORT), \"127.0.0.1\");",
      "}, 600);",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(serverScript)}`;

    let startedServices: Awaited<ReturnType<typeof startRuntimeServicesForWorkspaceControl>> = [];
    try {
      const startPromise = startRuntimeServicesForWorkspaceControl({
        db,
        invocationId: randomUUID(),
        actor: {
          id: null,
          name: "Board",
          companyId,
        },
        issue: {
          id: issueId,
          identifier: null,
          title: "Source task",
        },
        workspace: {
          baseCwd: worktreePath,
          source: "task_session",
          projectId,
          workspaceId: null,
          repoUrl: null,
          repoRef: "main",
          strategy: "git_worktree",
          cwd: worktreePath,
          branchName: "feature/current",
          worktreePath,
          warnings: [],
          created: false,
        },
        executionWorkspaceId,
        config: {
          workspaceRuntime: {
            services: [
              {
                name: "web",
                command,
                lifecycle: "shared",
                reuseScope: "execution_workspace",
                port: { type: "auto", envKey: "PORT" },
                expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
                readiness: { type: "http", intervalMs: 50, timeoutSec: 10 },
              },
            ],
          },
        },
        adapterEnv: {},
      });

      await Promise.race([
        waitForPath(runtimeStartedMarker),
        startPromise.then(
          () => {
            throw new Error("Runtime service activation finished before the process-start marker was observed");
          },
          (error) => {
            throw error;
          },
        ),
      ]);

      const reconcileErrorPromise = svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
        mode: "override",
        reason: "operator override still requires stopped services",
        actor: {
          actorType: "user",
          actorId: "local-board",
          agentId: null,
          runId: null,
        },
      }).then(
        () => {
          throw new Error("Branch reconciliation unexpectedly succeeded while a runtime service was starting");
        },
        (error) => error,
      );

      startedServices = await startPromise;
      await expect(reconcileErrorPromise).resolves.toMatchObject({
        status: 422,
        message: "Execution workspace branch reconciliation requires all runtime services to be stopped",
        details: {
          inspection: expect.objectContaining({
            cleanliness: "clean",
            fromBranch: "feature/recorded",
            toBranch: "feature/current",
          }),
          runtimeServices: [
            expect.objectContaining({
              id: startedServices[0]?.id,
              serviceName: "web",
              status: "starting",
            }),
          ],
        },
      });
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId,
        workspaceCwd: worktreePath,
      });
      await fs.rm(runtimeStartedMarker, { force: true });
    }

    const [workspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    expect(workspace?.branchName).toBe("feature/recorded");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  }, 20_000);

  it("rejects forward branch reconciliation for diverged branches", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-diverged-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["checkout", "-b", "feature/recorded"]);
    await fs.writeFile(path.join(repoRoot, "recorded.txt"), "recorded branch\n", "utf8");
    await runGit(repoRoot, ["add", "recorded.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Recorded branch work"]);
    await runGit(repoRoot, ["checkout", "main"]);
    await runGit(repoRoot, ["checkout", "-b", "feature/current"]);
    await fs.writeFile(path.join(repoRoot, "current.txt"), "current branch\n", "utf8");
    await runGit(repoRoot, ["add", "current.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Current branch work"]);
    await runGit(repoRoot, ["checkout", "main"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "feature/current"]);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
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
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Diverged workspace",
      status: "idle",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/recorded",
      baseRef: "main",
    });

    await expect(svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
      mode: "forward",
      reason: null,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    })).rejects.toMatchObject({
      status: 422,
      details: {
        inspection: expect.objectContaining({
          ancestryVerdict: "diverged",
          fromBranch: "feature/recorded",
          toBranch: "feature/current",
        }),
      },
    });

    const [workspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    expect(workspace?.branchName).toBe("feature/recorded");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  }, 20_000);

  it("rejects forward branch reconciliation when branch ancestry is unknown", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-unknown-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["branch", "feature/current"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "feature/current"]);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
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
      name: "Branch reconcile",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Unknown workspace",
      status: "idle",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/missing-recorded",
      baseRef: "main",
    });

    await expect(svc.reconcileExecutionWorkspaceBranch(executionWorkspaceId, {
      mode: "forward",
      reason: null,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    })).rejects.toMatchObject({
      status: 422,
      details: {
        inspection: expect.objectContaining({
          ancestryVerdict: "unknown",
          fromBranch: "feature/missing-recorded",
          toBranch: "feature/current",
          fromSha: null,
        }),
      },
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  }, 20_000);

  it("adopts an exact clean git worktree idempotently and rejects rebinding the same fingerprint", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const otherBindIssueId = randomUUID();

    await db.update(issues).set({ identifier: "PAP-456" }).where(eq(issues.id, scope.bindIssueId!));
    await db.insert(issues).values({
      id: otherBindIssueId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      title: "Other bound issue",
      status: "todo",
      priority: "medium",
    });

    const request = adoptionRequest({ ...git, ...scope });

    const first = await svc.adoptGitWorktree(scope.companyId, request, {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    });
    const retry = await svc.adoptGitWorktree(scope.companyId, request, {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    });

    expect(first.operation).toMatchObject({
      phase: "workspace_adopt",
      status: "succeeded",
      issueId: scope.bindIssueId,
    });
    expect(first.workspace).toMatchObject({
      companyId: scope.companyId,
      projectId: scope.projectId,
      projectWorkspaceId: scope.projectWorkspaceId,
      sourceIssueId: scope.sourceIssueId,
      boundIssue: {
        id: scope.bindIssueId,
        identifier: "PAP-456",
      },
      status: "active",
      providerType: "git_worktree",
      branchName: "feature/exact",
    });
    expect(first.inspection.worktreeFingerprint).toMatch(/^execution_workspace_adoption:v1:sha256:/);
    expect(retry.workspace.id).toBe(first.workspace.id);
    expect(retry.operation).toBeNull();

    const readBack = await svc.getById(first.workspace.id);
    expect(readBack).toMatchObject({
      id: first.workspace.id,
      boundIssue: {
        id: scope.bindIssueId,
        identifier: "PAP-456",
      },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        companyIds: [scope.companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", executionWorkspaceRoutes(db));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const workspaceReadback = await supertest(app).get(`/api/execution-workspaces/${first.workspace.id}`);
    expect(workspaceReadback.status).toBe(200);
    expect(workspaceReadback.body).toMatchObject({
      id: first.workspace.id,
      boundIssue: { id: scope.bindIssueId },
    });
    const heartbeatContext = await supertest(app).get(`/api/issues/${scope.bindIssueId}/heartbeat-context`);
    expect(heartbeatContext.status).toBe(200);
    expect(heartbeatContext.body.currentExecutionWorkspace).toMatchObject({ id: first.workspace.id });
    const [boundIssue] = await db.select().from(issues).where(eq(issues.id, scope.bindIssueId!));
    expect(boundIssue).toMatchObject({
      executionWorkspaceId: first.workspace.id,
      executionWorkspacePreference: "reuse_existing",
    });
    const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, first.workspace.id));
    expect(operations).toHaveLength(1);
    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, first.workspace.id));
    expect(activity.map((row) => row.action).sort()).toEqual([
      "execution_workspace.adopted",
    ]);
    const issueActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, scope.bindIssueId!));
    expect(issueActivity.map((row) => row.action)).toEqual(["issue.execution_workspace_bound"]);

    await expect(svc.adoptGitWorktree(scope.companyId, {
      ...request,
      bindIssueId: otherBindIssueId,
    }, {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    })).rejects.toMatchObject({
      reasonCode: "workspace_conflict",
      status: 409,
    });
  }, 20_000);

  it("rejects forged adoption metadata before persistence and leaves exact adoption retry unpoisoned", async () => {
    const git = await createAdoptionGitFixture({ branch: "feature/forged-adoption-guard" });
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const normalWorkspaceId = randomUUID();
    const canonicalCwd = await fs.realpath(git.worktreePath);
    const canonicalRepoRoot = await fs.realpath(git.worktreePath);
    const immutableFingerprint = fingerprintAdoptionForTest({
      companyId: scope.companyId,
      projectId: scope.projectId,
      projectWorkspaceId: scope.projectWorkspaceId,
      sourceIssueId: scope.sourceIssueId,
      canonicalCwd,
      repoRoot: canonicalRepoRoot,
      normalizedRepoUrl: "ssh://example.com/paperclip/repo",
      fullBranchRef: git.fullBranchRef,
      headSha: git.headSha,
      upstream: git.upstream,
    });

    await db.insert(executionWorkspaces).values({
      id: normalWorkspaceId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      projectWorkspaceId: scope.projectWorkspaceId,
      sourceIssueId: scope.sourceIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Ordinary runtime workspace",
      status: "active",
      providerType: "git_worktree",
      cwd: `/tmp/ordinary-${normalWorkspaceId}`,
      providerRef: `/tmp/ordinary-${normalWorkspaceId}`,
      branchName: "feature/ordinary-runtime",
      metadata: { runtimeNote: "ordinary" },
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        companyIds: [scope.companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", executionWorkspaceRoutes(db));
    app.use(errorHandler);

    const forged = await supertest(app)
      .patch(`/api/execution-workspaces/${normalWorkspaceId}`)
      .send({
        name: "Forged adopted workspace",
        metadata: {
          runtimeNote: "ordinary",
          createdByRuntime: false,
          ownsGitArtifacts: false,
          fullBranchRef: git.fullBranchRef,
          adoptionRollback: { version: 1, reason: "forged" },
          adoption: {
            version: 1,
            immutableFingerprint,
            boundIssueId: scope.bindIssueId,
          },
        },
      });

    expect(forged.status).toBe(409);
    expect(forged.body).toEqual({
      error: "Execution workspace server-owned metadata is immutable",
      reasonCode: "execution_workspace_server_owned_metadata_immutable",
      protectedKeys: [
        "adoption",
        "adoptionRollback",
        "fullBranchRef",
        "ownsGitArtifacts",
        "createdByRuntime",
      ],
    });
    const [normalReadback] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, normalWorkspaceId));
    expect(normalReadback?.name).toBe("Ordinary runtime workspace");
    expect(normalReadback?.metadata).toEqual({ runtimeNote: "ordinary" });
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, normalWorkspaceId))).toHaveLength(0);

    const adopted = await svc.adoptGitWorktree(
      scope.companyId,
      adoptionRequest({ ...git, ...scope }),
      {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    );
    expect(adopted.workspace.id).not.toBe(normalWorkspaceId);
    expect(adopted.operation).toMatchObject({
      phase: "workspace_adopt",
      status: "succeeded",
    });
    expect((adopted.workspace.metadata as Record<string, unknown>).adoption).toMatchObject({
      immutableFingerprint,
      boundIssueId: scope.bindIssueId,
    });
  }, 20_000);

  it("keeps operator git state and adopted ownership immutable across rejected patches and archive", async () => {
    const git = await createAdoptionGitFixture({ branch: "feature/immutable-adoption" });
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const adopted = await svc.adoptGitWorktree(
      scope.companyId,
      adoptionRequest({ ...git, ...scope }, { bindIssueId: null }),
      {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    );
    const evidencePath = path.join(git.worktreePath, "operator-untracked.txt");
    await fs.writeFile(evidencePath, "preserve me\n", "utf8");
    const gitStateBefore = {
      head: await readGit(git.worktreePath, ["rev-parse", "HEAD"]),
      branch: await readGit(git.worktreePath, ["symbolic-ref", "HEAD"]),
      upstream: await readGit(git.worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      status: await readGit(git.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        companyIds: [scope.companyId],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", executionWorkspaceRoutes(db));
    app.use(errorHandler);

    for (const patch of [
      {
        metadata: {
          ...(adopted.workspace.metadata as Record<string, unknown>),
          ownsGitArtifacts: true,
        },
      },
      { metadata: null },
      {
        metadata: {
          ...(adopted.workspace.metadata as Record<string, unknown>),
          adoption: {
            ...((adopted.workspace.metadata as Record<string, unknown>).adoption as Record<string, unknown>),
            immutableFingerprint: "execution_workspace_adoption:v1:sha256:rewritten",
          },
        },
      },
      {
        cwd: `${git.worktreePath}-other`,
        providerRef: `${git.worktreePath}-other`,
        repoUrl: "ssh://git@example.com/other/repo",
        branchName: "feature/other",
        baseRef: "origin/other",
      },
    ]) {
      const rejected = await supertest(app)
        .patch(`/api/execution-workspaces/${adopted.workspace.id}`)
        .send(patch);
      expect(rejected.status).toBe(409);
      expect(rejected.body.reasonCode).toBe("adopted_workspace_identity_immutable");
    }

    const archived = await supertest(app)
      .patch(`/api/execution-workspaces/${adopted.workspace.id}`)
      .send({ status: "archived" });
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe("archived");

    const postArchiveEscalation = await supertest(app)
      .patch(`/api/execution-workspaces/${adopted.workspace.id}`)
      .send({
        metadata: {
          ...(adopted.workspace.metadata as Record<string, unknown>),
          ownsGitArtifacts: true,
        },
      });
    expect(postArchiveEscalation.status).toBe(409);
    expect(postArchiveEscalation.body.reasonCode).toBe("adopted_workspace_identity_immutable");

    const persisted = await svc.getById(adopted.workspace.id);
    expect(persisted).toMatchObject({
      status: "archived",
      cwd: adopted.workspace.cwd,
      providerRef: adopted.workspace.providerRef,
      repoUrl: adopted.workspace.repoUrl,
      branchName: git.branch,
      baseRef: git.upstream,
      metadata: {
        createdByRuntime: false,
        ownsGitArtifacts: false,
        fullBranchRef: git.fullBranchRef,
        adoption: {
          immutableFingerprint: adopted.inspection.worktreeFingerprint,
        },
      },
    });
    await expect(fs.stat(evidencePath)).resolves.toBeDefined();
    await expect(fs.stat(git.worktreePath)).resolves.toBeDefined();
    await expect(Promise.all([
      readGit(git.worktreePath, ["rev-parse", "HEAD"]),
      readGit(git.worktreePath, ["symbolic-ref", "HEAD"]),
      readGit(git.worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      readGit(git.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ])).resolves.toEqual([
      gitStateBefore.head,
      gitStateBefore.branch,
      gitStateBefore.upstream,
      gitStateBefore.status,
    ]);

    const workspaceActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, adopted.workspace.id));
    expect(workspaceActivity.map((row) => row.action).sort()).toEqual([
      "execution_workspace.adopted",
      "execution_workspace.updated",
    ]);
  }, 20_000);

  it("serializes concurrent identical adoptions without duplicating operations or activity", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const request = adoptionRequest({ ...git, ...scope });
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const raceSvc = executionWorkspaceService(db, {
      afterAdoptionInitialInspection: async () => {
        arrivals += 1;
        if (arrivals === 2) releaseBarrier();
        await barrier;
      },
    });
    const actor = {
      actorType: "user" as const,
      actorId: "local-board",
      agentId: null,
      runId: null,
    };

    const results = await Promise.all([
      raceSvc.adoptGitWorktree(scope.companyId, request, actor),
      raceSvc.adoptGitWorktree(scope.companyId, request, actor),
    ]);

    expect(new Set(results.map((result) => result.workspace.id))).toHaveProperty("size", 1);
    expect(results.filter((result) => result.operation !== null)).toHaveLength(1);
    expect(results.filter((result) => result.operation === null)).toHaveLength(1);
    await expect(countAdoptionSideEffects(db)).resolves.toEqual({
      workspaces: 1,
      operations: 1,
      activity: 2,
    });
    const workspaceId = results[0]!.workspace.id;
    const workspaceActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, workspaceId));
    expect(workspaceActivity.map((row) => row.action)).toEqual(["execution_workspace.adopted"]);
    const issueActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, scope.bindIssueId!));
    expect(issueActivity.map((row) => row.action)).toEqual(["issue.execution_workspace_bound"]);
  }, 20_000);

  it.each([
    {
      name: "remote-only missing local branch",
      reasonCode: "missing_branch",
      mutate: async (fixture: Awaited<ReturnType<typeof createAdoptionGitFixture>>) => {
        await runGit(fixture.worktreePath, ["checkout", "--detach", fixture.headSha]);
        await runGit(fixture.repoRoot, ["branch", "-D", fixture.branch]);
      },
    },
    {
      name: "detached HEAD",
      reasonCode: "detached_head",
      mutate: async (fixture: Awaited<ReturnType<typeof createAdoptionGitFixture>>) => {
        await runGit(fixture.worktreePath, ["checkout", "--detach", fixture.headSha]);
      },
    },
    {
      name: "mismatched branch",
      reasonCode: "mismatched_branch",
      mutate: async (fixture: Awaited<ReturnType<typeof createAdoptionGitFixture>>) => {
        await runGit(fixture.repoRoot, ["branch", "feature/other", fixture.headSha]);
        await runGit(fixture.worktreePath, ["checkout", "feature/other"]);
      },
    },
    {
      name: "SHA mismatch",
      reasonCode: "sha_mismatch",
      requestPatch: { expectedHeadSha: "0000000000000000000000000000000000000000" },
    },
    {
      name: "upstream mismatch",
      reasonCode: "upstream_mismatch",
      requestPatch: { expectedUpstream: "origin/other" },
    },
    {
      name: "tracked dirtiness",
      reasonCode: "dirty_worktree",
      mutate: async (fixture: Awaited<ReturnType<typeof createAdoptionGitFixture>>) => {
        await fs.appendFile(path.join(fixture.worktreePath, "README.md"), "dirty tracked work\n", "utf8");
      },
    },
    {
      name: "untracked dirtiness",
      reasonCode: "dirty_worktree",
      mutate: async (fixture: Awaited<ReturnType<typeof createAdoptionGitFixture>>) => {
        await fs.writeFile(path.join(fixture.worktreePath, "untracked.txt"), "dirty untracked work\n", "utf8");
      },
    },
    {
      name: "branch attached elsewhere",
      reasonCode: "branch_attached_elsewhere",
      mutate: async (fixture: Awaited<ReturnType<typeof createAdoptionGitFixture>>) => {
        const otherWorktreePath = path.join(path.dirname(fixture.repoRoot), `paperclip-adopt-attached-${randomUUID()}`);
        tempDirs.add(otherWorktreePath);
        await runGit(fixture.repoRoot, ["worktree", "add", "--force", otherWorktreePath, fixture.branch]);
      },
    },
    {
      name: "repo URL mismatch",
      reasonCode: "repo_mismatch",
      requestPatch: { expectedRepoUrl: "git@example.com:paperclip/other.git" },
    },
  ])("rejects adoption with stable reason code for $name", async ({ reasonCode, mutate, requestPatch }) => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    await mutate?.(git);

    await expect(svc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }, requestPatch), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    })).rejects.toMatchObject({
      reasonCode,
      status: 422,
    });
    await expect(countAdoptionSideEffects(db)).resolves.toEqual({
      workspaces: 0,
      operations: 0,
      activity: 0,
    });
  }, 20_000);

  it("rejects a cwd outside the git root as repo_mismatch", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const nestedCwd = path.join(git.worktreePath, "nested");
    await fs.mkdir(nestedCwd);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });

    await expect(svc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }, { cwd: nestedCwd }), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    })).rejects.toMatchObject({
      reasonCode: "repo_mismatch",
      status: 422,
    });
    await expect(countAdoptionSideEffects(db)).resolves.toEqual({
      workspaces: 0,
      operations: 0,
      activity: 0,
    });
  }, 20_000);

  it("fails repo identity closed when the selected project workspace cannot be inspected", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    await db
      .update(projectWorkspaces)
      .set({ cwd: path.join(git.repoRoot, "missing-project-workspace") })
      .where(eq(projectWorkspaces.id, scope.projectWorkspaceId));

    await expect(svc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    })).rejects.toMatchObject({ reasonCode: "repo_mismatch", status: 422 });
    await expect(countAdoptionSideEffects(db)).resolves.toEqual({
      workspaces: 0,
      operations: 0,
      activity: 0,
    });
  }, 20_000);

  it("revalidates source issue scope after transaction locks before adoption writes", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const otherProjectId = randomUUID();
    await db.insert(projects).values({
      id: otherProjectId,
      companyId: scope.companyId,
      name: "Other same-company project",
      status: "in_progress",
    });
    const [bindingBefore] = await db
      .select({
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, scope.bindIssueId!));
    const raceSvc = executionWorkspaceService(db, {
      afterAdoptionInitialInspection: async () => {
        await db
          .update(issues)
          .set({ projectId: otherProjectId })
          .where(eq(issues.id, scope.sourceIssueId));
      },
    });

    await expect(raceSvc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    })).rejects.toMatchObject({ reasonCode: "cross_scope_not_found", status: 404 });
    await expect(countAdoptionSideEffects(db)).resolves.toEqual({
      workspaces: 0,
      operations: 0,
      activity: 0,
    });
    const [sourceIssue] = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, scope.sourceIssueId));
    expect(sourceIssue?.projectId).toBe(otherProjectId);
    const [bindingAfter] = await db
      .select({
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, scope.bindIssueId!));
    expect(bindingAfter).toEqual(bindingBefore);
  }, 20_000);

  it("rejects an idempotent retry when its adopted workspace source issue moved out of project scope", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const request = adoptionRequest({ ...git, ...scope });
    const actor = {
      actorType: "user" as const,
      actorId: "local-board",
      agentId: null,
      runId: null,
    };
    const adopted = await svc.adoptGitWorktree(scope.companyId, request, actor);
    const sideEffectsBeforeRetry = await countAdoptionSideEffects(db);
    const otherProjectId = randomUUID();
    await db.insert(projects).values({
      id: otherProjectId,
      companyId: scope.companyId,
      name: "Other same-company project",
      status: "in_progress",
    });
    const retrySvc = executionWorkspaceService(db, {
      afterAdoptionInitialInspection: async () => {
        await db
          .update(issues)
          .set({ projectId: otherProjectId })
          .where(eq(issues.id, scope.sourceIssueId));
      },
    });

    await expect(retrySvc.adoptGitWorktree(scope.companyId, request, actor)).rejects.toMatchObject({
      reasonCode: "cross_scope_not_found",
      status: 404,
    });
    await expect(countAdoptionSideEffects(db)).resolves.toEqual(sideEffectsBeforeRetry);
    expect(sideEffectsBeforeRetry).toEqual({
      workspaces: 1,
      operations: 1,
      activity: 2,
    });
    const [workspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, adopted.workspace.id));
    expect(workspace?.status).toBe("active");
  }, 20_000);

  it("re-inspects git state after transaction locks and rejects mutation before insert", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const raceSvc = executionWorkspaceService(db, {
      afterAdoptionInitialInspection: async () => {
        await fs.appendFile(path.join(git.worktreePath, "README.md"), "changed after initial inspection\n", "utf8");
      },
    });

    await expect(raceSvc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    })).rejects.toMatchObject({ reasonCode: "dirty_worktree", status: 422 });
    await expect(countAdoptionSideEffects(db)).resolves.toEqual({
      workspaces: 0,
      operations: 0,
      activity: 0,
    });
  }, 20_000);

  it("re-inspects git state after transaction locks before returning an idempotent retry", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const request = adoptionRequest({ ...git, ...scope });
    const actor = {
      actorType: "user" as const,
      actorId: "local-board",
      agentId: null,
      runId: null,
    };
    const adopted = await svc.adoptGitWorktree(scope.companyId, request, actor);
    const sideEffectsBeforeRetry = await countAdoptionSideEffects(db);
    const retrySvc = executionWorkspaceService(db, {
      afterAdoptionInitialInspection: async () => {
        await fs.appendFile(path.join(git.worktreePath, "README.md"), "changed during idempotent retry\n", "utf8");
      },
    });

    await expect(retrySvc.adoptGitWorktree(scope.companyId, request, actor)).rejects.toMatchObject({
      reasonCode: "dirty_worktree",
      status: 422,
    });
    await expect(countAdoptionSideEffects(db)).resolves.toEqual(sideEffectsBeforeRetry);
    expect(sideEffectsBeforeRetry).toEqual({
      workspaces: 1,
      operations: 1,
      activity: 2,
    });
    const [workspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, adopted.workspace.id));
    expect(workspace?.status).toBe("active");
  }, 20_000);

  it("never executes a repository-configured fsmonitor during either adoption inspection", async () => {
    const git = await createAdoptionGitFixture({ branch: "feature/fsmonitor-safe-adoption" });
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const hookPath = path.join(git.repoRoot, "fsmonitor-hook.sh");
    const markerPath = path.join(git.repoRoot, "fsmonitor-executed.txt");
    await fs.writeFile(
      hookPath,
      "#!/bin/sh\nmarker_path=\"$(dirname \"$0\")/fsmonitor-executed.txt\"\nprintf invoked > \"$marker_path\"\nprintf \"%s\\n\" \"$2\"\n",
      "utf8",
    );
    await fs.chmod(hookPath, 0o755);
    await runGit(git.worktreePath, ["config", "core.fsmonitor", hookPath]);
    await runGit(git.worktreePath, ["config", "core.fsmonitorHookVersion", "2"]);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    let markerExistedAfterInitialInspection = false;
    const hardenedSvc = executionWorkspaceService(db, {
      afterAdoptionInitialInspection: async () => {
        markerExistedAfterInitialInspection = await fs.access(markerPath).then(() => true).catch(() => false);
      },
    });

    await expect(hardenedSvc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    })).resolves.toMatchObject({ inspection: { status: "accepted" } });

    expect(markerExistedAfterInitialInspection).toBe(false);
    await expect(fs.access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it("leaves a stale clean index byte-for-byte unchanged after both adoption inspections", async () => {
    const git = await createAdoptionGitFixture({ branch: "feature/index-safe-adoption" });
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const indexPathRaw = await readGit(git.worktreePath, ["rev-parse", "--git-path", "index"]);
    const indexPath = path.isAbsolute(indexPathRaw!)
      ? indexPathRaw!
      : path.join(git.worktreePath, indexPathRaw!);
    const indexBeforeInspection = await fs.readFile(indexPath);
    const trackedPath = path.join(git.worktreePath, "README.md");
    const staleMtime = new Date(Date.now() + 60_000);
    await fs.utimes(trackedPath, staleMtime, staleMtime);
    let indexAfterInitialInspection: Buffer | null = null;
    const hardenedSvc = executionWorkspaceService(db, {
      afterAdoptionInitialInspection: async () => {
        indexAfterInitialInspection = await fs.readFile(indexPath);
      },
    });

    await expect(hardenedSvc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    })).resolves.toMatchObject({ inspection: { status: "accepted" } });

    expect(indexAfterInitialInspection).not.toBeNull();
    expect(indexAfterInitialInspection!.equals(indexBeforeInspection)).toBe(true);
    expect((await fs.readFile(indexPath)).equals(indexBeforeInspection)).toBe(true);
  }, 20_000);

  it("rejects adoption binding when issue authorization fields change before the transaction lock", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const authorizedBindIssue = await readIssueAuthorizationSnapshot(db, scope.bindIssueId!);
    const raceSvc = executionWorkspaceService(db, {
      afterAdoptionInitialInspection: async () => {
        await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, scope.bindIssueId!));
      },
    });

    await expect(raceSvc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    }, authorizedBindIssue)).rejects.toMatchObject({ reasonCode: "workspace_conflict", status: 409 });
    await expect(countAdoptionSideEffects(db)).resolves.toEqual({
      workspaces: 0,
      operations: 0,
      activity: 0,
    });
  }, 20_000);

  it("rejects company-wide cwd/provider claims and same-project repository branch claims as workspace_conflict", async () => {
    for (const duplicateField of ["cwd", "providerRef", "fullBranchRef"] as const) {
      await db.delete(activityLog);
      await db.delete(workspaceOperations);
      await db.delete(executionWorkspaces);
      await db.delete(issues);
      await db.delete(projectWorkspaces);
      await db.delete(projects);
      await db.delete(companies);

      const git = await createAdoptionGitFixture({ worktreeSlug: `paperclip-adopt-${duplicateField}` });
      tempDirs.add(git.repoRoot);
      tempDirs.add(git.worktreePath);
      const scope = await seedAdoptionScope(db, {
        repoRoot: git.repoRoot,
        repoUrl: git.repoUrl,
      });
      const canonicalWorktreePath = await fs.realpath(git.worktreePath);
      const gitCommonDir = await readGit(git.worktreePath, ["rev-parse", "--git-common-dir"]);
      const repositoryIdentity = await fs.realpath(
        path.isAbsolute(gitCommonDir!) ? gitCommonDir! : path.join(git.worktreePath, gitCommonDir!),
      );
      await db.insert(executionWorkspaces).values({
        companyId: scope.companyId,
        projectId: scope.projectId,
        projectWorkspaceId: scope.projectWorkspaceId,
        sourceIssueId: scope.sourceIssueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: `duplicate-${duplicateField}`,
        status: "active",
        providerType: "git_worktree",
        cwd: duplicateField === "cwd" ? canonicalWorktreePath : `/tmp/${randomUUID()}`,
        providerRef: duplicateField === "providerRef" ? canonicalWorktreePath : `/tmp/${randomUUID()}`,
        branchName: duplicateField === "fullBranchRef" ? git.branch : `feature/${randomUUID()}`,
        metadata: duplicateField === "fullBranchRef"
          ? { repositoryIdentity, fullBranchRef: git.fullBranchRef }
          : null,
      });

      await expect(svc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }), {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      })).rejects.toMatchObject({
        reasonCode: "workspace_conflict",
        status: 409,
      });
    }
  }, 60_000);

  it("allows distinct repositories and projects in one company to adopt the same full branch ref", async () => {
    const firstGit = await createAdoptionGitFixture({ repoUrl: "git@example.com:paperclip/repo-one.git" });
    const secondGit = await createAdoptionGitFixture({ repoUrl: "git@example.com:paperclip/repo-two.git" });
    for (const git of [firstGit, secondGit]) {
      tempDirs.add(git.repoRoot);
      tempDirs.add(git.worktreePath);
    }
    const firstScope = await seedAdoptionScope(db, {
      bindIssueId: null,
      repoRoot: firstGit.repoRoot,
      repoUrl: firstGit.repoUrl,
    });
    const secondProjectId = randomUUID();
    const secondProjectWorkspaceId = randomUUID();
    const secondSourceIssueId = randomUUID();
    await db.insert(projects).values({
      id: secondProjectId,
      companyId: firstScope.companyId,
      name: "Second repository adoption",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: secondProjectWorkspaceId,
      companyId: firstScope.companyId,
      projectId: secondProjectId,
      name: "Primary",
      cwd: secondGit.repoRoot,
      repoUrl: secondGit.repoUrl,
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: secondSourceIssueId,
      companyId: firstScope.companyId,
      projectId: secondProjectId,
      title: "Second repository source issue",
      status: "todo",
      priority: "medium",
    });
    const secondScope = {
      ...firstScope,
      projectId: secondProjectId,
      projectWorkspaceId: secondProjectWorkspaceId,
      sourceIssueId: secondSourceIssueId,
    };
    const actor = {
      actorType: "user" as const,
      actorId: "local-board",
      agentId: null,
      runId: null,
    };

    const first = await svc.adoptGitWorktree(
      firstScope.companyId,
      adoptionRequest({ ...firstGit, ...firstScope }),
      actor,
    );
    const second = await svc.adoptGitWorktree(
      firstScope.companyId,
      adoptionRequest({ ...secondGit, ...secondScope }),
      actor,
    );

    expect(second.workspace.id).not.toBe(first.workspace.id);
    const active = await db
      .select()
      .from(executionWorkspaces)
      .where(and(eq(executionWorkspaces.companyId, firstScope.companyId), eq(executionWorkspaces.status, "active")));
    expect(active).toHaveLength(2);
    expect(active.map((row) => row.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ fullBranchRef: firstGit.fullBranchRef }),
      expect.objectContaining({ fullBranchRef: secondGit.fullBranchRef }),
    ]));
  }, 30_000);

  it("serializes company-wide adoption claims across different projects", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const firstScope = await seedAdoptionScope(db, {
      bindIssueId: null,
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const secondProjectId = randomUUID();
    const secondProjectWorkspaceId = randomUUID();
    const secondSourceIssueId = randomUUID();
    await db.insert(projects).values({
      id: secondProjectId,
      companyId: firstScope.companyId,
      name: "Concurrent adoption",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: secondProjectWorkspaceId,
      companyId: firstScope.companyId,
      projectId: secondProjectId,
      name: "Primary",
      cwd: git.repoRoot,
      repoUrl: git.repoUrl,
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: secondSourceIssueId,
      companyId: firstScope.companyId,
      projectId: secondProjectId,
      title: "Concurrent source issue",
      status: "todo",
      priority: "medium",
    });
    const secondScope = {
      ...firstScope,
      projectId: secondProjectId,
      projectWorkspaceId: secondProjectWorkspaceId,
      sourceIssueId: secondSourceIssueId,
      bindIssueId: null,
    };
    const actor = {
      actorType: "user" as const,
      actorId: "local-board",
      agentId: null,
      runId: null,
    };

    const results = await Promise.allSettled([
      svc.adoptGitWorktree(firstScope.companyId, adoptionRequest({ ...git, ...firstScope }), actor),
      svc.adoptGitWorktree(firstScope.companyId, adoptionRequest({ ...git, ...secondScope }), actor),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [rejected] = results.filter((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({ reasonCode: "workspace_conflict", status: 409 }),
    });
    const active = await db
      .select()
      .from(executionWorkspaces)
      .where(and(eq(executionWorkspaces.companyId, firstScope.companyId), eq(executionWorkspaces.status, "active")));
    expect(active).toHaveLength(1);
  }, 20_000);

  it("rejects cross-project and cross-company adoption identifiers before git inspection", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const otherProjectId = randomUUID();
    const otherProjectWorkspaceId = randomUUID();
    const otherProjectIssueId = randomUUID();
    await db.insert(projects).values({
      id: otherProjectId,
      companyId: scope.companyId,
      name: "Other project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: otherProjectWorkspaceId,
      companyId: scope.companyId,
      projectId: otherProjectId,
      name: "Other primary",
      cwd: git.repoRoot,
      repoUrl: git.repoUrl,
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: otherProjectIssueId,
      companyId: scope.companyId,
      projectId: otherProjectId,
      title: "Other project issue",
      status: "todo",
      priority: "medium",
    });
    const otherCompany = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const cases = [
      { projectId: otherProjectId },
      { projectWorkspaceId: otherProjectWorkspaceId },
      { sourceIssueId: otherProjectIssueId },
      { bindIssueId: otherProjectIssueId },
      { projectId: otherCompany.projectId },
      { projectWorkspaceId: otherCompany.projectWorkspaceId },
      { sourceIssueId: otherCompany.sourceIssueId },
      { bindIssueId: otherCompany.bindIssueId },
    ];

    for (const patch of cases) {
      await expect(svc.adoptGitWorktree(scope.companyId, {
        ...adoptionRequest({ ...git, ...scope }),
        ...patch,
      }, {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      })).rejects.toMatchObject({
        reasonCode: "cross_scope_not_found",
        status: 404,
      });
    }
    await expect(countAdoptionSideEffects(db)).resolves.toEqual({
      workspaces: 0,
      operations: 0,
      activity: 0,
    });
  }, 20_000);

  it("rejects rollback of a non-adopted workspace with the stable adoption error contract", async () => {
    const scope = await seedAdoptionScope(db, {
      repoRoot: `/tmp/${randomUUID()}`,
      repoUrl: "git@example.com:paperclip/repo.git",
    });
    const workspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      projectWorkspaceId: scope.projectWorkspaceId,
      sourceIssueId: scope.sourceIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "ordinary workspace",
      status: "active",
      providerType: "git_worktree",
      cwd: `/tmp/${randomUUID()}`,
      branchName: "feature/ordinary",
    });

    const error = await svc.rollbackAdoption(workspaceId, {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    }, "not adopted", null, null).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExecutionWorkspaceAdoptionError);
    expect(error).toMatchObject({
      reasonCode: "workspace_conflict",
      status: 409,
    });
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    expect(workspace).toMatchObject({ status: "active", closedAt: null });
    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, workspaceId));
    expect(activity).toHaveLength(0);
  });

  it("rolls back adopted records without deleting or mutating the adopted git worktree", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const beforeHead = await readGit(git.worktreePath, ["rev-parse", "HEAD"]);
    const beforeBranch = await readGit(git.worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);

    const adopted = await svc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    });
    const authorizedBoundIssue = await readIssueAuthorizationSnapshot(db, scope.bindIssueId!);
    const rolledBack = await svc.rollbackAdoption(adopted.workspace.id, {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    }, "record-only rollback", scope.bindIssueId, authorizedBoundIssue);

    expect(rolledBack).toMatchObject({
      id: adopted.workspace.id,
      status: "archived",
      cleanupReason: "adoption_rollback",
      boundIssue: null,
    });
    await expect(fs.access(git.worktreePath)).resolves.toBeUndefined();
    await expect(readGit(git.worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(beforeHead);
    await expect(readGit(git.worktreePath, ["symbolic-ref", "--quiet", "HEAD"])).resolves.toBe(beforeBranch);
    await expect(readGit(git.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"])).resolves.toBeNull();
    const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, adopted.workspace.id));
    expect(operations.map((row) => row.phase)).toEqual(["workspace_adopt"]);
    const [beforeRepeat] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, adopted.workspace.id));
    const activityBeforeRepeat = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, adopted.workspace.id));

    await expect(svc.rollbackAdoption(adopted.workspace.id, {
      actorType: "user",
      actorId: "different-board-actor",
      agentId: null,
      runId: null,
    }, "must not replace first rollback", scope.bindIssueId, authorizedBoundIssue)).rejects.toMatchObject({
      reasonCode: "workspace_conflict",
      status: 409,
    });

    const [afterRepeat] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, adopted.workspace.id));
    const activityAfterRepeat = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, adopted.workspace.id));
    expect(afterRepeat?.metadata).toEqual(beforeRepeat?.metadata);
    expect(afterRepeat?.updatedAt).toEqual(beforeRepeat?.updatedAt);
    expect(activityAfterRepeat).toEqual(activityBeforeRepeat);
  }, 20_000);

  it("rejects repeated rollback of an unbound adopted workspace without changing metadata or activity", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      bindIssueId: null,
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const adopted = await svc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    });
    await svc.rollbackAdoption(adopted.workspace.id, {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    }, "first rollback", null, null);
    const [beforeRepeat] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, adopted.workspace.id));
    const activityBeforeRepeat = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, adopted.workspace.id));

    await expect(svc.rollbackAdoption(adopted.workspace.id, {
      actorType: "user",
      actorId: "different-board-actor",
      agentId: null,
      runId: null,
    }, "must not replace first rollback", null, null)).rejects.toMatchObject({
      reasonCode: "workspace_conflict",
      status: 409,
    });

    const [afterRepeat] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, adopted.workspace.id));
    const activityAfterRepeat = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, adopted.workspace.id));
    expect(afterRepeat?.metadata).toEqual(beforeRepeat?.metadata);
    expect(afterRepeat?.updatedAt).toEqual(beforeRepeat?.updatedAt);
    expect(activityAfterRepeat).toEqual(activityBeforeRepeat);
    expect(activityAfterRepeat.map((row) => row.action).sort()).toEqual([
      "execution_workspace.adopted",
      "execution_workspace.adoption_rolled_back",
    ].sort());
  }, 20_000);

  it("rolls back atomically when adoption fails after workspace insert but before optional issue binding", async () => {
    const git = await createAdoptionGitFixture();
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const previousWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: previousWorkspaceId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      sourceIssueId: scope.sourceIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "previous",
      status: "active",
      providerType: "git_worktree",
      cwd: `/tmp/${randomUUID()}`,
      branchName: "feature/previous",
    });
    await db.update(issues).set({
      executionWorkspaceId: previousWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    }).where(eq(issues.id, scope.bindIssueId!));
    const failingSvc = executionWorkspaceService(db, {
      afterAdoptionWorkspaceInsert: () => {
        throw new Error("forced adoption failure");
      },
    });

    await expect(failingSvc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    })).rejects.toThrow("forced adoption failure");

    const rows = await db.select().from(executionWorkspaces);
    expect(rows.map((row) => row.id)).toEqual([previousWorkspaceId]);
    const [boundIssue] = await db.select().from(issues).where(eq(issues.id, scope.bindIssueId!));
    expect(boundIssue).toMatchObject({
      executionWorkspaceId: previousWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });
    await expect(countAdoptionSideEffects(db)).resolves.toEqual({
      workspaces: 1,
      operations: 0,
      activity: 0,
    });
  }, 20_000);

  it("treats shell-shaped git inputs as argv data and does not mutate git artifacts", async () => {
    const git = await createAdoptionGitFixture({
      worktreeSlug: "paperclip-adopt-argv-safe;touch-should-not-run",
    });
    tempDirs.add(git.repoRoot);
    tempDirs.add(git.worktreePath);
    const scope = await seedAdoptionScope(db, {
      repoRoot: git.repoRoot,
      repoUrl: git.repoUrl,
    });
    const markerPath = path.join(path.dirname(git.repoRoot), "paperclip-adoption-shell-marker");
    const beforeHead = await readGit(git.worktreePath, ["rev-parse", "HEAD"]);
    const beforeStatus = await readGit(git.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);

    await expect(svc.adoptGitWorktree(scope.companyId, adoptionRequest({ ...git, ...scope }, {
      expectedBranch: `${git.fullBranchRef};touch ${markerPath}`,
      name: `argv-safe;touch ${markerPath}`,
    }), {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    })).rejects.toMatchObject({
      reasonCode: "missing_branch",
      status: 422,
    });

    await expect(fs.access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readGit(git.worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(beforeHead);
    await expect(readGit(git.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"])).resolves.toBe(beforeStatus);
    await expect(countAdoptionSideEffects(db)).resolves.toEqual({
      workspaces: 0,
      operations: 0,
      activity: 0,
    });
  }, 20_000);

  it("rolls back adopted records by restoring the previous issue binding without cleanup operations", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const previousWorkspaceId = randomUUID();
    const adoptedWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const bindIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Rollback adoption",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
    });
    await db.insert(executionWorkspaces).values([
      {
        id: previousWorkspaceId,
        companyId,
        projectId,
        sourceIssueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "previous",
        status: "active",
        providerType: "git_worktree",
        cwd: "/tmp/previous",
        branchName: "feature/previous",
      },
      {
        id: adoptedWorkspaceId,
        companyId,
        projectId,
        sourceIssueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "adopted",
        status: "active",
        providerType: "git_worktree",
        cwd: "/tmp/adopted",
        branchName: "feature/adopted",
        metadata: {
          adoption: {
            version: 1,
            immutableFingerprint: "execution_workspace_adoption:v1:sha256:test",
            boundIssueId: bindIssueId,
            previousIssueBinding: {
              issueId: bindIssueId,
              executionWorkspaceId: previousWorkspaceId,
              executionWorkspacePreference: "reuse_existing",
              executionWorkspaceSettings: {
                mode: "isolated_workspace",
                workspaceStrategy: {
                  type: "git_worktree",
                  baseRef: "origin/feature/previous",
                },
              },
            },
          },
        },
      },
    ]);
    await db.insert(issues).values({
      id: bindIssueId,
      companyId,
      projectId,
      title: "Bound issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId: adoptedWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/feature/adopted",
        },
      },
    });

    const authorizedBoundIssue = await readIssueAuthorizationSnapshot(db, bindIssueId);
    expect(authorizedBoundIssue).not.toBeNull();
    await expect(svc.rollbackAdoption(adoptedWorkspaceId, {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    }, "stale authorization", randomUUID(), authorizedBoundIssue)).rejects.toMatchObject({ reasonCode: "workspace_conflict", status: 409 });
    const [stillAuthorizedBinding] = await db.select().from(issues).where(eq(issues.id, bindIssueId));
    expect(stillAuthorizedBinding?.executionWorkspaceId).toBe(adoptedWorkspaceId);

    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, bindIssueId));
    await expect(svc.rollbackAdoption(adoptedWorkspaceId, {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    }, "stale issue authorization", bindIssueId, authorizedBoundIssue)).rejects.toMatchObject({
      reasonCode: "workspace_conflict",
      status: 409,
    });
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, bindIssueId));

    await db
      .update(issues)
      .set({ executionWorkspaceId: previousWorkspaceId })
      .where(eq(issues.id, bindIssueId));
    await expect(svc.rollbackAdoption(adoptedWorkspaceId, {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    }, "stale rollback", bindIssueId, authorizedBoundIssue)).rejects.toMatchObject({ reasonCode: "workspace_conflict", status: 409 });
    const [unchangedAdoptedWorkspace] = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, adoptedWorkspaceId));
    const [newerBoundIssue] = await db.select().from(issues).where(eq(issues.id, bindIssueId));
    expect(unchangedAdoptedWorkspace?.status).toBe("active");
    expect(newerBoundIssue?.executionWorkspaceId).toBe(previousWorkspaceId);

    await db
      .update(issues)
      .set({ executionWorkspaceId: adoptedWorkspaceId })
      .where(eq(issues.id, bindIssueId));

    const result = await svc.rollbackAdoption(adoptedWorkspaceId, {
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      runId: null,
    }, "operator rollback", bindIssueId, authorizedBoundIssue);

    expect(result).toMatchObject({
      id: adoptedWorkspaceId,
      status: "archived",
      cleanupReason: "adoption_rollback",
      boundIssue: null,
    });
    const [boundIssue] = await db.select().from(issues).where(eq(issues.id, bindIssueId));
    expect(boundIssue).toMatchObject({
      executionWorkspaceId: previousWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });
    expect(boundIssue?.executionWorkspaceSettings).toMatchObject({
      workspaceStrategy: {
        baseRef: "origin/feature/previous",
      },
    });
    const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, adoptedWorkspaceId));
    expect(operations).toHaveLength(0);
    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, adoptedWorkspaceId));
    expect(activity.map((row) => row.action)).toEqual(["execution_workspace.adoption_rolled_back"]);
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

  it("reports record-only close readiness for adopted operator-owned worktrees", async () => {
    const fixture = await createAdoptionGitFixture({ branch: "feature/operator-owned-close" });
    tempDirs.add(fixture.repoRoot);
    tempDirs.add(fixture.worktreePath);
    const scope = await seedAdoptionScope(db, fixture);
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          workspaceStrategy: {
            type: "git_worktree",
            teardownCommand: "node ./scripts/project-teardown.js",
          },
        },
      })
      .where(eq(projects.id, scope.projectId));
    await db
      .update(projectWorkspaces)
      .set({ cleanupCommand: "node ./scripts/project-cleanup.js" })
      .where(eq(projectWorkspaces.id, scope.projectWorkspaceId));

    const adopted = await svc.adoptGitWorktree(
      scope.companyId,
      adoptionRequest({ ...fixture, ...scope }, { bindIssueId: null }),
      {
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        runId: null,
      },
      null,
    );

    const readiness = await svc.getCloseReadiness(adopted.workspace.id);

    expect(adopted.workspace.metadata).toMatchObject({ ownsGitArtifacts: false });
    expect(readiness?.plannedActions).toEqual([
      expect.objectContaining({ kind: "archive_record", command: null }),
    ]);
    expect(readiness?.plannedActions.map((action) => action.kind)).not.toEqual(expect.arrayContaining([
      "cleanup_command",
      "teardown_command",
      "git_worktree_remove",
      "git_branch_delete",
      "remove_local_directory",
    ]));
  }, 20_000);
});
