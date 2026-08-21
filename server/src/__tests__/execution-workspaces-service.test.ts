import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueReferenceMentions,
  issueRecoveryActions,
  issueWorkProducts,
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
  EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY,
  EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY,
  EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY,
  executionWorkspaceService,
  deriveExecutionWorkspaceDeliveryState,
  mergeExecutionWorkspaceConfig,
  metadataHasReopenPendingConsumption,
  readExecutionWorkspaceConfig,
  readMetadataReopenPendingConsumptionSince,
} from "../services/execution-workspaces.ts";
import { issueService } from "../services/issues.ts";
import {
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import { workspaceGitOperationScheduler } from "../services/workspace-git-operation-scheduler.ts";

const execFileAsync = promisify(execFile);

describe("execution workspace delivery state", () => {
  it.each([
    [{ sourceIssueTerminal: true, mergedPullRequest: true, pullRequestStateUnknown: false, isMergedIntoBase: false }, "merged_via_pr"],
    [{ sourceIssueTerminal: false, mergedPullRequest: false, pullRequestStateUnknown: false, isMergedIntoBase: true }, "merged_by_ancestry"],
    [{ sourceIssueTerminal: true, mergedPullRequest: false, pullRequestStateUnknown: false, isMergedIntoBase: false }, "unmerged"],
    [{ sourceIssueTerminal: true, mergedPullRequest: false, pullRequestStateUnknown: true, isMergedIntoBase: false }, "unknown"],
  ] as const)("derives %s as %s", (input, expected) => {
    expect(deriveExecutionWorkspaceDeliveryState(input)).toBe(expected);
  });
});

describe("execution workspace config helpers", () => {
  it("reads typed config from persisted metadata", () => {
    expect(readExecutionWorkspaceConfig({
      source: "project_primary",
      config: {
        environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
        provisionCommand: "bash ./scripts/provision-worktree.sh",
        runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
        teardownCommand: "bash ./scripts/teardown-worktree.sh",
        cleanupCommand: "pkill -f vite || true",
        workspaceRuntime: {
          services: [{ name: "web", command: "pnpm dev", port: 3100 }],
        },
      },
    })).toEqual({
      environmentId: "32e0464c-2a0b-4ce9-886d-2cc99e6f3e7b",
      provisionCommand: "bash ./scripts/provision-worktree.sh",
      runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
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
          runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
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
        runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
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
  const pullRequestDetailsByKey = new Map<string, {
    state: "merged" | "open" | "unknown";
    headRef: string | null;
    headSha: string | null;
  }>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-execution-workspaces-service-");
    db = createDb(tempDb.connectionString);
    svc = executionWorkspaceService(db, {
      resolvePullRequestDetails: vi.fn(async (companyId, reference) =>
        pullRequestDetailsByKey.get(`${companyId}:${reference.number}`)
        ?? { state: "unknown", headRef: null, headSha: null }
      ),
      // Disable the reaper cooldown for the delivery, terminal, race, and
      // cleanup tests. They assert immediate reaping. The cooldown gets its own
      // tests further down.
      workspaceReaperCooldownDays: 0,
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceRuntimeServices);
    await db.delete(activityLog);
    await db.delete(issueRecoveryActions);
    await db.delete(issueWorkProducts);
    await db.delete(issueReferenceMentions);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    pullRequestDetailsByKey.clear();

    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTerminalWorkspace(options: {
    mergedPr?: boolean;
    activeRun?: boolean;
    childStatus?: "done" | "todo";
  } = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const issuePrefix = `P${companyId.slice(0, 8).toUpperCase()}`;
    const identifier = `${issuePrefix}-1`;
    const repoRoot = await createTempRepo();
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-terminal-${randomUUID()}`);
    tempDirs.add(repoRoot);
    tempDirs.add(worktreePath);
    await runGit(repoRoot, ["branch", "PAP-16015-delivery"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "PAP-16015-delivery"]);
    await fs.writeFile(path.join(worktreePath, "delivered.txt"), "delivered\n", "utf8");
    await runGit(worktreePath, ["add", "delivered.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Delivered change"]);
    const headSha = await readGit(worktreePath, ["rev-parse", "HEAD"]);
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Terminal workspaces",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: identifier,
      status: "active",
      cwd: worktreePath,
      providerRef: worktreePath,
      providerType: "git_worktree",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      baseRef: "main",
      branchName: "PAP-16015-delivery",
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      identifier,
      title: "Delivered source issue",
      status: "done",
      priority: "medium",
      executionWorkspaceId,
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    if (options.childStatus) {
      await db.insert(issues).values({
        id: randomUUID(),
        companyId,
        projectId,
        parentId: sourceIssueId,
        title: "Descendant",
        status: options.childStatus,
        priority: "medium",
      });
    }
    if (options.mergedPr) {
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId: sourceIssueId,
        executionWorkspaceId,
        type: "pull_request",
        provider: "github",
        title: "Delivered PR",
        url: "https://github.com/paperclipai/paperclip/pull/10623",
        status: "merged",
      });
    }
    pullRequestDetailsByKey.set(`${companyId}:10623`, {
      state: "merged",
      headRef: "PAP-16015-delivery",
      headSha,
    });
    pullRequestDetailsByKey.set(`${companyId}:10624`, {
      state: "merged",
      headRef: "unrelated-delivery",
      headSha,
    });
    pullRequestDetailsByKey.set(`${companyId}:10625`, {
      state: "merged",
      headRef: "descendant-delivery",
      headSha,
    });
    if (options.activeRun) {
      const agentId = randomUUID();
      const runId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
      });
      await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, sourceIssueId));
    }
    return { companyId, projectId, executionWorkspaceId, sourceIssueId, identifier, repoRoot, worktreePath, headSha };
  }

  it("reports a squash cross-branch delivery as merged_via_pr and suppresses the ancestry warning", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-delivery-${randomUUID()}`);
    tempDirs.add(worktreePath);
    await runGit(repoRoot, ["branch", "PAP-16015-delivery"]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, "PAP-16015-delivery"]);
    await fs.writeFile(path.join(worktreePath, "delivered.txt"), "delivered\n", "utf8");
    await runGit(worktreePath, ["add", "delivered.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Delivered change"]);

    const seeded = await seedTerminalWorkspace();
    pullRequestDetailsByKey.set(`${seeded.companyId}:10623`, {
      state: "merged",
      headRef: "PAP-16015-delivery",
      headSha: await readGit(worktreePath, ["rev-parse", "HEAD"]),
    });
    await db.update(executionWorkspaces).set({
      cwd: worktreePath,
      providerRef: worktreePath,
      providerType: "git_worktree",
      baseRef: "main",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      branchName: "PAP-16015-delivery",
    }).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    await db.insert(issueWorkProducts).values({
      companyId: seeded.companyId,
      issueId: seeded.sourceIssueId,
      type: "pull_request",
      provider: "github",
      title: "Cross-branch delivery",
      url: "https://github.com/paperclipai/paperclip/pull/10623",
      status: "merged",
    });

    const readiness = await svc.getCloseReadiness(seeded.executionWorkspaceId);

    expect(readiness?.deliveryState).toBe("merged_via_pr");
    expect(readiness?.git?.isMergedIntoBase).toBe(false);
    expect(readiness?.warnings).not.toContain(
      "This workspace is 1 commit ahead of main and is not merged.",
    );

    const sweep = await svc.sweepTerminalWorkspaces();
    const archived = await db
      .select({
        status: executionWorkspaces.status,
        cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
        cleanupReason: executionWorkspaces.cleanupReason,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId))
      .then((rows) => rows[0]);

    expect(sweep.archived).toBe(1);
    expect(archived).toMatchObject({ status: "archived", cleanupReason: "issue_terminal" });
    expect(archived?.cleanupEligibleAt).toBeInstanceOf(Date);
  }, 20_000);

  async function seedAncestryTerminalWorkspace(overrides: { updatedAt?: Date } = {}) {
    // Build a worktree whose HEAD equals the base ref, so HEAD is an ancestor
    // of the base. This workspace landed by ancestry and carries no tracked
    // pull request, so delivery derives to merged_by_ancestry.
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-ancestry-${randomUUID()}`);
    tempDirs.add(worktreePath);
    const branchName = `ancestry-${randomUUID().slice(0, 8)}`;
    await runGit(repoRoot, ["branch", branchName]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, branchName]);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const issuePrefix = `P${companyId.slice(0, 8).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Ancestry delivery",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: `${issuePrefix}-1`,
      status: "active",
      cwd: worktreePath,
      providerRef: worktreePath,
      providerType: "git_worktree",
      repoUrl: "https://github.com/paperclipai/paperclip.git",
      baseRef: "main",
      branchName,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      identifier: `${issuePrefix}-1`,
      title: "Delivered by ancestry",
      status: "done",
      priority: "medium",
      executionWorkspaceId,
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId, ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}) })
      .where(eq(executionWorkspaces.id, executionWorkspaceId));
    return { companyId, projectId, executionWorkspaceId, sourceIssueId, worktreePath };
  }

  it("archives a terminal workspace delivered by ancestry with no pull request", async () => {
    const seeded = await seedAncestryTerminalWorkspace();

    const readiness = await svc.getCloseReadiness(seeded.executionWorkspaceId);
    expect(readiness?.deliveryState).toBe("merged_by_ancestry");
    expect(readiness?.blockingReasons).toEqual([]);

    const sweep = await svc.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({ status: executionWorkspaces.status, cleanupReason: executionWorkspaces.cleanupReason })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(sweep).toMatchObject({ archived: 1, cleanupFailed: 0 });
    expect(workspace).toMatchObject({ status: "archived", cleanupReason: "issue_terminal" });
  }, 20_000);

  it("fails closed before archive when git status inspection is unavailable", async () => {
    const seeded = await seedAncestryTerminalWorkspace();
    const statusSpy = vi.spyOn(workspaceGitOperationScheduler, "run")
      .mockRejectedValue(new Error("scan queue unavailable"));

    try {
      const readiness = await svc.getCloseReadiness(seeded.executionWorkspaceId);
      expect(readiness).toMatchObject({
        state: "blocked",
        isDestructiveCloseAllowed: false,
        blockingReasons: [
          "Paperclip could not verify the workspace git status. Retry before destructive cleanup.",
        ],
      });

      const sweep = await svc.sweepTerminalWorkspaces();
      expect(sweep).toMatchObject({ archived: 0, skippedUndelivered: 1 });
      const [workspace] = await db
        .select({ status: executionWorkspaces.status })
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
      expect(workspace?.status).toBe("active");
      await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();
    } finally {
      statusSpy.mockRestore();
    }
  }, 20_000);

  it("fails the final cleanup fence when a later git status scan is unavailable", async () => {
    const seeded = await seedAncestryTerminalWorkspace();
    const originalRun = workspaceGitOperationScheduler.run.bind(workspaceGitOperationScheduler);
    let statusScanCount = 0;
    const statusSpy = vi.spyOn(workspaceGitOperationScheduler, "run")
      .mockImplementation(async (input) => {
        statusScanCount += 1;
        if (statusScanCount > 1) throw new Error("scan timed out");
        return originalRun(input);
      });

    try {
      const sweep = await svc.sweepTerminalWorkspaces();
      expect(sweep).toMatchObject({ archived: 0, cleanupFailed: 1 });
      await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();
    } finally {
      statusSpy.mockRestore();
    }
  }, 20_000);

  it("skips a sweep that starts while another sweep runs", async () => {
    // The scheduler can start a second sweep before the first one finishes. The
    // sweeps share the cursor and the boundary. A concurrent sweep must skip
    // instead of running, so it cannot corrupt the shared rotation state.
    const seeded = await seedAncestryTerminalWorkspace();

    // Start the first sweep and do not wait. An async function runs its body up
    // to the first await, so the in-progress flag is set before the second call
    // starts. The second call sees the flag and returns without a scan.
    const firstSweepPromise = svc.sweepTerminalWorkspaces();
    const concurrentSweep = await svc.sweepTerminalWorkspaces();
    const firstSweep = await firstSweepPromise;

    // The concurrent sweep inspected no candidate and changed no state.
    expect(concurrentSweep).toMatchObject({ checked: 0, archived: 0, eligible: 0 });
    // The first sweep archived the eligible workspace.
    expect(firstSweep.archived).toBe(1);

    const [workspace] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    expect(workspace?.status).toBe("archived");

    // The flag resets after the first sweep, so a later sweep runs its scan.
    const laterSweep = await svc.sweepTerminalWorkspaces();
    expect(laterSweep).toMatchObject({ archived: 0 });
  }, 20_000);

  it("archives an eligible workspace behind a full page of skipped candidates", async () => {
    // Seed more skipped candidates than the sweep page holds, each older than
    // the eligible workspace. A skipped candidate keeps its updatedAt, so a
    // sweep that always reads the oldest page never reaches the eligible
    // workspace. The reaper must rotate its scan window across sweeps.
    const companyId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `P${companyId.slice(0, 8).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Starved reaper",
      status: "in_progress",
    });
    // Two open-issue workspaces that the reaper always skips. Their older
    // updatedAt keeps them at the front of the ordered candidate set.
    const skippedWorkspaceIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const workspaceId = randomUUID();
      const openIssueId = randomUUID();
      skippedWorkspaceIds.push(workspaceId);
      await db.insert(executionWorkspaces).values({
        id: workspaceId,
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "local_fs",
        name: `${issuePrefix}-skip-${index}`,
        status: "active",
        providerType: "local_fs",
        updatedAt: new Date(Date.UTC(2020, 0, index + 1)),
      });
      await db.insert(issues).values({
        id: openIssueId,
        companyId,
        projectId,
        title: `Open ${index}`,
        status: "in_progress",
        priority: "medium",
        executionWorkspaceId: workspaceId,
      });
      await db
        .update(executionWorkspaces)
        .set({ sourceIssueId: openIssueId, updatedAt: new Date(Date.UTC(2020, 0, index + 1)) })
        .where(eq(executionWorkspaces.id, workspaceId));
    }
    // The eligible workspace is newest, so it sorts after the whole skipped page.
    const eligible = await seedAncestryTerminalWorkspace({ updatedAt: new Date(Date.UTC(2020, 0, 9)) });

    // A fresh service starts with an empty scan cursor, so each call inspects
    // one row and advances. A single-row page never lands on the eligible
    // workspace first.
    const service = executionWorkspaceService(db, {
      resolvePullRequestDetails: async () => ({ state: "unknown", headRef: null, headSha: null }),
      workspaceReaperCooldownDays: 0,
    });

    const firstSweep = await service.sweepTerminalWorkspaces(1);
    expect(firstSweep).toMatchObject({ checked: 1, archived: 0, skippedNonTerminalTree: 1 });
    const [afterFirst] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, eligible.executionWorkspaceId));
    expect(afterFirst?.status).toBe("active");

    let archivedSweep: Awaited<ReturnType<typeof service.sweepTerminalWorkspaces>> | null = null;
    for (let attempt = 0; attempt < 4 && !archivedSweep; attempt += 1) {
      const sweep = await service.sweepTerminalWorkspaces(1);
      if (sweep.archived > 0) archivedSweep = sweep;
    }

    expect(archivedSweep).toMatchObject({ archived: 1 });
    const workspaces = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [eligible.executionWorkspaceId, ...skippedWorkspaceIds]));
    const byId = new Map(workspaces.map((row) => [row.id, row.status]));
    expect(byId.get(eligible.executionWorkspaceId)).toBe("archived");
    for (const skippedId of skippedWorkspaceIds) {
      expect(byId.get(skippedId)).toBe("active");
    }
  }, 20_000);

  it("revisits an eligible workspace behind the cursor despite continuous newer churn", async () => {
    // Reproduce the rotation-starvation case. The scan cursor advances past a
    // workspace while it is not eligible. The workspace then becomes eligible
    // but keeps its old updatedAt, so it stays behind the cursor. Meanwhile a
    // steady stream of newer candidates keeps every page full. Without a frozen
    // per-rotation upper bound, the cursor never reaches the end, never resets,
    // and never revisits the eligible workspace. The bound makes each rotation
    // cover a finite set, so the cursor resets and the workspace is archived.
    let clockMs = Date.UTC(2021, 6, 1);
    const service = executionWorkspaceService(db, {
      resolvePullRequestDetails: async () => ({ state: "unknown", headRef: null, headSha: null }),
      now: () => new Date(clockMs),
      workspaceReaperCooldownDays: 0,
    });

    // An eligible ancestry workspace with an old updatedAt. Its source issue
    // starts non-terminal, so the first sweeps skip it and pass the cursor.
    const eligible = await seedAncestryTerminalWorkspace({ updatedAt: new Date(Date.UTC(2021, 0, 2)) });
    await db
      .update(issues)
      .set({ status: "in_progress" })
      .where(eq(issues.id, eligible.sourceIssueId));

    // One older skipped candidate. With a single-row page it sorts before the
    // eligible workspace, so the first sweep advances the cursor onto it.
    const olderSkippedId = randomUUID();
    const olderOpenIssueId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: olderSkippedId,
      companyId: eligible.companyId,
      projectId: eligible.projectId,
      mode: "isolated_workspace",
      strategyType: "local_fs",
      name: "skip-older",
      status: "active",
      providerType: "local_fs",
      updatedAt: new Date(Date.UTC(2021, 0, 1)),
    });
    await db.insert(issues).values({
      id: olderOpenIssueId,
      companyId: eligible.companyId,
      projectId: eligible.projectId,
      title: "Older open",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: olderSkippedId,
    });
    await db
      .update(executionWorkspaces)
      .set({ sourceIssueId: olderOpenIssueId, updatedAt: new Date(Date.UTC(2021, 0, 1)) })
      .where(eq(executionWorkspaces.id, olderSkippedId));

    // Sweep once per row so the cursor lands on the eligible workspace while it
    // is still non-terminal.
    await service.sweepTerminalWorkspaces(1); // reads olderSkipped
    await service.sweepTerminalWorkspaces(1); // reads eligible, still non-terminal

    const [afterSkip] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, eligible.executionWorkspaceId));
    expect(afterSkip?.status).toBe("active");

    // The workspace becomes eligible now. Its updatedAt stays old, so it is
    // behind the cursor.
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, eligible.sourceIssueId));

    // Drive continuous churn. Each sweep, advance the clock and add a newer
    // skipped candidate ahead of the cursor. Without the frozen bound the cursor
    // would chase this churn forever and never revisit the eligible workspace.
    let archived = false;
    for (let attempt = 0; attempt < 8 && !archived; attempt += 1) {
      clockMs += 24 * 60 * 60 * 1000;
      const churnId = randomUUID();
      const churnIssueId = randomUUID();
      await db.insert(executionWorkspaces).values({
        id: churnId,
        companyId: eligible.companyId,
        projectId: eligible.projectId,
        mode: "isolated_workspace",
        strategyType: "local_fs",
        name: `churn-${attempt}`,
        status: "active",
        providerType: "local_fs",
        updatedAt: new Date(clockMs),
      });
      await db.insert(issues).values({
        id: churnIssueId,
        companyId: eligible.companyId,
        projectId: eligible.projectId,
        title: `Churn ${attempt}`,
        status: "in_progress",
        priority: "medium",
        executionWorkspaceId: churnId,
      });
      await db
        .update(executionWorkspaces)
        .set({ sourceIssueId: churnIssueId, updatedAt: new Date(clockMs) })
        .where(eq(executionWorkspaces.id, churnId));

      const sweep = await service.sweepTerminalWorkspaces(1);
      if (sweep.archived > 0) archived = true;
    }

    expect(archived).toBe(true);
    const [finalState] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, eligible.executionWorkspaceId));
    expect(finalState?.status).toBe("archived");
  }, 30_000);

  describe("reaper cooldown", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const nowMs = Date.UTC(2026, 5, 1);

    function cooldownService(cooldownDays: number) {
      return executionWorkspaceService(db, {
        resolvePullRequestDetails: async (companyId, reference) =>
          pullRequestDetailsByKey.get(`${companyId}:${reference.number}`)
          ?? { state: "unknown", headRef: null, headSha: null },
        now: () => new Date(nowMs),
        workspaceReaperCooldownDays: cooldownDays,
      });
    }

    async function statusOf(executionWorkspaceId: string) {
      const [row] = await db
        .select({ status: executionWorkspaces.status })
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, executionWorkspaceId));
      return row?.status ?? null;
    }

    it("skips a terminal tree that is younger than the cooldown", async () => {
      const seeded = await seedTerminalWorkspace({ mergedPr: true });
      // Keep the workspace inside the sweep boundary that the fixed clock sets.
      await db
        .update(executionWorkspaces)
        .set({ updatedAt: new Date(nowMs - DAY_MS) })
        .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
      // The issue became terminal one day ago. A cooldown of seven days is not
      // over yet.
      await db
        .update(issues)
        .set({ completedAt: new Date(nowMs - DAY_MS) })
        .where(eq(issues.id, seeded.sourceIssueId));

      const sweep = await cooldownService(7).sweepTerminalWorkspaces();

      expect(sweep).toMatchObject({ archived: 0, skippedCooldown: 1 });
      expect(await statusOf(seeded.executionWorkspaceId)).toBe("active");
    }, 20_000);

    it("archives a terminal tree that is older than the cooldown", async () => {
      const seeded = await seedTerminalWorkspace({ mergedPr: true });
      await db
        .update(executionWorkspaces)
        .set({ updatedAt: new Date(nowMs - DAY_MS) })
        .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
      // The issue became terminal ten days ago. The seven-day cooldown is over.
      await db
        .update(issues)
        .set({ completedAt: new Date(nowMs - 10 * DAY_MS) })
        .where(eq(issues.id, seeded.sourceIssueId));

      const sweep = await cooldownService(7).sweepTerminalWorkspaces();

      expect(sweep).toMatchObject({ archived: 1, skippedCooldown: 0 });
      expect(await statusOf(seeded.executionWorkspaceId)).toBe("archived");
    }, 20_000);

    it("archives immediately when the cooldown is zero", async () => {
      const seeded = await seedTerminalWorkspace({ mergedPr: true });
      await db
        .update(executionWorkspaces)
        .set({ updatedAt: new Date(nowMs - DAY_MS) })
        .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
      // The issue became terminal now. A cooldown of zero disables the wait.
      await db
        .update(issues)
        .set({ completedAt: new Date(nowMs) })
        .where(eq(issues.id, seeded.sourceIssueId));

      const sweep = await cooldownService(0).sweepTerminalWorkspaces();

      expect(sweep).toMatchObject({ archived: 1, skippedCooldown: 0 });
      expect(await statusOf(seeded.executionWorkspaceId)).toBe("archived");
    }, 20_000);

    it("falls back to updatedAt when completedAt is null and gates the archive", async () => {
      const seeded = await seedTerminalWorkspace({ mergedPr: true });
      // The done issue has no completedAt. The anchor falls back to updatedAt.
      // Set updatedAt two days ago, inside the seven-day cooldown, so the sweep
      // must skip.
      await db
        .update(executionWorkspaces)
        .set({ updatedAt: new Date(nowMs - 2 * DAY_MS) })
        .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
      await db
        .update(issues)
        .set({ completedAt: null, updatedAt: new Date(nowMs - 2 * DAY_MS) })
        .where(eq(issues.id, seeded.sourceIssueId));

      const sweep = await cooldownService(7).sweepTerminalWorkspaces();

      expect(sweep).toMatchObject({ archived: 0, skippedCooldown: 1 });
      expect(await statusOf(seeded.executionWorkspaceId)).toBe("active");
    }, 20_000);
  });

  it("does not treat an unrelated inbound issue mention as delivery evidence", async () => {
    const seeded = await seedTerminalWorkspace();
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values({
      id: unrelatedIssueId,
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      title: `Investigate ${seeded.identifier} follow-up`,
      status: "done",
      priority: "medium",
    });
    await db.insert(issueReferenceMentions).values({
      companyId: seeded.companyId,
      sourceIssueId: unrelatedIssueId,
      targetIssueId: seeded.sourceIssueId,
      sourceKind: "title",
      sourceRecordId: null,
      documentKey: null,
      matchedText: seeded.identifier,
    });
    await db.insert(issueWorkProducts).values({
      companyId: seeded.companyId,
      issueId: unrelatedIssueId,
      type: "pull_request",
      provider: "github",
      title: "Unrelated merged PR",
      url: "https://github.com/paperclipai/paperclip/pull/10624",
      status: "merged",
    });

    const readiness = await svc.getCloseReadiness(seeded.executionWorkspaceId);
    const sweep = await svc.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({
        status: executionWorkspaces.status,
        cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
        cleanupReason: executionWorkspaces.cleanupReason,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(readiness?.deliveryState).toBe("unmerged");
    expect(sweep).toMatchObject({ archived: 0, skippedUndelivered: 1 });
    expect(workspace).toMatchObject({
      status: "active",
      cleanupEligibleAt: null,
      cleanupReason: null,
    });
  });

  it("does not trust directly linked merged products for a different repository or branch", async () => {
    const seeded = await seedTerminalWorkspace();
    await db.insert(issueWorkProducts).values([
      {
        companyId: seeded.companyId,
        issueId: seeded.sourceIssueId,
        executionWorkspaceId: seeded.executionWorkspaceId,
        type: "pull_request",
        provider: "github",
        title: "Wrong branch merged PR",
        url: "https://github.com/paperclipai/paperclip/pull/10624",
        status: "merged",
      },
      {
        companyId: seeded.companyId,
        issueId: seeded.sourceIssueId,
        executionWorkspaceId: seeded.executionWorkspaceId,
        type: "pull_request",
        provider: "github",
        title: "Wrong repository merged PR",
        url: "https://github.com/unrelated/paperclip/pull/10623",
        status: "merged",
      },
    ]);

    const readiness = await svc.getCloseReadiness(seeded.executionWorkspaceId);
    const sweep = await svc.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(readiness?.deliveryState).toBe("unmerged");
    expect(sweep).toMatchObject({ archived: 0, skippedUndelivered: 1 });
    expect(workspace?.status).toBe("active");
  });

  it("does not trust a previously merged PR after new workspace commits", async () => {
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    await fs.writeFile(path.join(seeded.worktreePath, "new-work.txt"), "not delivered\n", "utf8");
    await runGit(seeded.worktreePath, ["add", "new-work.txt"]);
    await runGit(seeded.worktreePath, ["commit", "-m", "New undelivered work"]);

    const readiness = await svc.getCloseReadiness(seeded.executionWorkspaceId);
    const sweep = await svc.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(readiness?.deliveryState).toBe("unmerged");
    expect(readiness?.warnings).toContain(
      "This workspace is 2 commits ahead of main and is not merged.",
    );
    expect(sweep).toMatchObject({ archived: 0, skippedUndelivered: 1 });
    expect(workspace?.status).toBe("active");
  });

  it("does not reap uncommitted work after the workspace HEAD was delivered", async () => {
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    await fs.writeFile(path.join(seeded.worktreePath, "uncommitted.txt"), "not delivered\n", "utf8");

    const readiness = await svc.getCloseReadiness(seeded.executionWorkspaceId);
    const sweep = await svc.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(readiness?.deliveryState).toBe("merged_via_pr");
    expect(readiness?.warnings).toContain("The workspace has 1 untracked file.");
    expect(sweep).toMatchObject({ archived: 0, skippedUndelivered: 1 });
    expect(workspace?.status).toBe("active");
  });

  it("refuses cleanup when the worktree changes after delivery assessment", async () => {
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    await db.update(executionWorkspaces).set({
      metadata: {
        createdByRuntime: true,
        config: { cleanupCommand: "rm -f late-work.txt" },
      },
    }).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    const racingService = executionWorkspaceService(db, {
      resolvePullRequestDetails: async (_companyId, reference) =>
        pullRequestDetailsByKey.get(`${seeded.companyId}:${reference.number}`) ?? { state: "unknown" },
      workspaceReaperCooldownDays: 0,
      beforeTerminalWorkspaceCleanup: async () => {
        await fs.writeFile(path.join(seeded.worktreePath, "late-work.txt"), "not delivered\n", "utf8");
      },
    });

    const sweep = await racingService.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({ status: executionWorkspaces.status, cleanupReason: executionWorkspaces.cleanupReason })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(sweep).toMatchObject({ archived: 0, cleanupFailed: 1 });
    expect(workspace?.status).toBe("cleanup_failed");
    expect(workspace?.cleanupReason).toContain("git worktree changed after delivery was verified");
    await expect(fs.readFile(path.join(seeded.worktreePath, "late-work.txt"), "utf8"))
      .resolves.toBe("not delivered\n");
  });

  it("does not write stale cleanup-failure state onto a newer archive lifecycle", async () => {
    // Reproduce the cleanup-failure race. The reaper archives the workspace at one
    // generation and captures it. The cleanup then throws. Before the catch handler
    // writes the cleanup-failed status, a reopen and a fresh archive raise the
    // generation. The catch handler must skip its write, so the stale failure never
    // overwrites the newer archive lifecycle.
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    const newerReason = "newer_archive_lifecycle_marker";
    const racingService = executionWorkspaceService(db, {
      resolvePullRequestDetails: async (_companyId, reference) =>
        pullRequestDetailsByKey.get(`${seeded.companyId}:${reference.number}`) ?? { state: "unknown" },
      workspaceReaperCooldownDays: 0,
      beforeTerminalWorkspaceCleanup: async (workspace) => {
        // Stand in for a reopen and a fresh archive that ran after this sweep
        // captured the generation. Raise the generation past the captured value,
        // keep the row closed, then force the cleanup to throw.
        await db
          .update(executionWorkspaces)
          .set({
            status: "archived",
            cleanupReason: newerReason,
            metadata: { [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 2 },
            updatedAt: new Date(),
          })
          .where(eq(executionWorkspaces.id, workspace.id));
        throw new Error("forced cleanup failure");
      },
    });

    const sweep = await racingService.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({
        status: executionWorkspaces.status,
        cleanupReason: executionWorkspaces.cleanupReason,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(sweep).toMatchObject({ cleanupFailed: 1 });
    // The fenced write saw the raised generation and skipped, so the newer
    // lifecycle state survives untouched.
    expect(workspace?.status).toBe("archived");
    expect(workspace?.cleanupReason).toBe(newerReason);
    expect(
      (workspace?.metadata as Record<string, unknown> | null)?.[EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY],
    ).toBe(2);
  });

  it("archives terminal workspaces without running configured cleanup hooks", async () => {
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    const cleanupMarker = path.join(path.dirname(seeded.worktreePath), `cleanup-marker-${randomUUID()}`);
    tempDirs.add(cleanupMarker);
    await db.update(executionWorkspaces).set({
      metadata: {
        createdByRuntime: true,
        config: { cleanupCommand: `touch ${cleanupMarker}` },
      },
    }).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    const sweep = await svc.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(sweep).toMatchObject({ archived: 1, cleanupFailed: 0 });
    expect(workspace?.status).toBe("archived");
    await expect(fs.access(seeded.worktreePath)).rejects.toThrow();
    await expect(fs.access(cleanupMarker)).rejects.toThrow();
  });

  it("does not reap a reopened workspace while the source issue is still terminal", async () => {
    // Reproduce the reverse-ordering race. A resume reopens the archived
    // workspace and publishes it active, but the route has not yet changed the
    // source issue out of the terminal state. The sweep must not archive and
    // destroy the rebuilt worktree in this window.
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        cleanupEligibleAt: null,
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 4,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
          // A fresh timestamp marks the reopen as in flight, so the sweep skips it.
          [EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY]: new Date().toISOString(),
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    const sweep = await svc.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({ status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(sweep).toMatchObject({ archived: 0, skippedReopened: 1 });
    expect(workspace?.status).toBe("active");
    // The reopen flag stays until the source issue leaves the terminal state.
    expect(metadataHasReopenPendingConsumption(workspace?.metadata as Record<string, unknown> | null)).toBe(true);
    // The rebuilt worktree is intact.
    await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();
  });

  it("clears a stranded reopen flag whose consumer never ran, then reaps on a later sweep", async () => {
    // A reopen published the workspace active and set the flag, but the consuming
    // request never moved the source issue out of the terminal state, and the
    // response-end clear never landed. The flag is older than the grace period.
    // The first sweep clears the stranded flag; a later sweep archives the row.
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    const strandedSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        cleanupEligibleAt: null,
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 4,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY]: strandedSince,
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    const firstSweep = await svc.sweepTerminalWorkspaces();
    const [afterClear] = await db
      .select({ status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    // The first sweep clears the stranded flag but keeps the row active, so a
    // retried resume can still reuse the rebuilt worktree.
    expect(firstSweep).toMatchObject({ archived: 0, clearedStaleReopenPending: 1 });
    expect(afterClear?.status).toBe("active");
    expect(metadataHasReopenPendingConsumption(afterClear?.metadata as Record<string, unknown> | null)).toBe(false);
    await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();

    // A later sweep archives the reclaimed workspace through the normal path.
    const secondSweep = await svc.sweepTerminalWorkspaces();
    const [afterArchive] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(secondSweep).toMatchObject({ archived: 1 });
    expect(afterArchive?.status).toBe("archived");
  });

  it("keeps the reopen fence for a request that outruns the grace period", async () => {
    // A reopen published the workspace active and set the flag. The consuming
    // request still runs, but it outran the grace period, so the flag looks
    // stale by age. A live run owns the fence, so the sweep must not clear it.
    // If the sweep cleared it, a later sweep could archive and destroy the
    // rebuilt worktree under the running request.
    const seeded = await seedTerminalWorkspace({ mergedPr: true, activeRun: true });
    const staleSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        cleanupEligibleAt: null,
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 4,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY]: staleSince,
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    const sweep = await svc.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({ status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    // The live run holds the fence, so the sweep skips the workspace and keeps
    // the flag. It clears nothing.
    expect(sweep).toMatchObject({ archived: 0, skippedReopened: 1, clearedStaleReopenPending: 0 });
    expect(workspace?.status).toBe("active");
    expect(metadataHasReopenPendingConsumption(workspace?.metadata as Record<string, unknown> | null)).toBe(true);
    // The rebuilt worktree is intact.
    await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();
  });

  it("refreshes the reopen fence for an in-flight request, so a later sweep keeps it", async () => {
    // The consuming request is an HTTP request, not a heartbeat run, so the sweep
    // cannot see it through the active-run check. The request re-stamps the flag on
    // an interval below the grace period. This test drives one re-stamp on a flag
    // that already looks stale by age. After the re-stamp the flag looks fresh, so
    // the sweep skips the workspace and clears nothing, even with no active run.
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    const staleSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        cleanupEligibleAt: null,
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 4,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY]: staleSince,
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    const result = await svc.refreshReopenPendingConsumption({
      workspaceId: seeded.executionWorkspaceId,
      expectedGeneration: 4,
    });
    expect(result).toEqual({ refreshed: true });

    const [afterRefresh] = await db
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    const refreshedSince = readMetadataReopenPendingConsumptionSince(
      afterRefresh?.metadata as Record<string, unknown> | null,
    );
    // The re-stamp moved the timestamp forward, so the flag no longer looks stale.
    expect(refreshedSince).not.toBeNull();
    expect(refreshedSince!.getTime()).toBeGreaterThan(new Date(staleSince).getTime());

    const sweep = await svc.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({ status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    // The fresh flag keeps the fence, so the sweep skips the workspace and clears
    // nothing, even though no heartbeat run owns it.
    expect(sweep).toMatchObject({ archived: 0, skippedReopened: 1, clearedStaleReopenPending: 0 });
    expect(workspace?.status).toBe("active");
    expect(metadataHasReopenPendingConsumption(workspace?.metadata as Record<string, unknown> | null)).toBe(true);
    await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();
  });

  it("does not refresh the reopen fence when a newer generation owns it", async () => {
    // A newer reopen or an archive raised the generation, so the flag belongs to a
    // new owner. A stale caller must not re-stamp another owner's fence. The
    // refresh reports refreshed=false and leaves the timestamp unchanged.
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    const since = new Date(Date.now() - 60 * 1000).toISOString();
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        cleanupEligibleAt: null,
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 7,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY]: since,
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    const result = await svc.refreshReopenPendingConsumption({
      workspaceId: seeded.executionWorkspaceId,
      expectedGeneration: 4,
    });
    expect(result).toEqual({ refreshed: false });

    const [afterRefresh] = await db
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    const unchangedSince = readMetadataReopenPendingConsumptionSince(
      afterRefresh?.metadata as Record<string, unknown> | null,
    );
    expect(unchangedSince?.toISOString()).toBe(since);
  });

  it("does not refresh the reopen fence when the flag is already clear", async () => {
    // The response-end clear already removed the flag. A late keepalive tick must
    // not revive it. The refresh reports refreshed=false and adds no flag.
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        cleanupEligibleAt: null,
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 4,
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    const result = await svc.refreshReopenPendingConsumption({
      workspaceId: seeded.executionWorkspaceId,
      expectedGeneration: 4,
    });
    expect(result).toEqual({ refreshed: false });

    const [afterRefresh] = await db
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    expect(metadataHasReopenPendingConsumption(afterRefresh?.metadata as Record<string, unknown> | null)).toBe(false);
  });

  it("clears the reopen flag once the source issue leaves the terminal state", async () => {
    // The resume transition committed, so the source issue is non-terminal. The
    // sweep clears the stale reopen flag so a later terminal cycle can reap the
    // workspace normally.
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    await db
      .update(executionWorkspaces)
      .set({
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 4,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    await db
      .update(issues)
      .set({ status: "in_progress" })
      .where(eq(issues.id, seeded.sourceIssueId));

    const sweep = await svc.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({ status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(sweep).toMatchObject({ archived: 0, skippedNonTerminalTree: 1 });
    expect(workspace?.status).toBe("active");
    expect(metadataHasReopenPendingConsumption(workspace?.metadata as Record<string, unknown> | null)).toBe(false);
    await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();
  });

  it("refuses to archive a reopen-pending workspace and leaves the row unchanged", async () => {
    // Close the second destructive path. The archive route calls
    // archiveWorkspaceUnderLifecycleLock. A reopen published this row active with
    // the reopen-pending flag while the source issue is still terminal. The
    // archive must not close or clear the flag, so the destruction fence never
    // removes the rebuilt worktree during the reopen consumption window.
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        cleanupEligibleAt: null,
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 4,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    const result = await svc.archiveWorkspaceUnderLifecycleLock({
      id: seeded.executionWorkspaceId,
      patch: {},
      closedAt: new Date(),
    });

    expect(result).toEqual({ outcome: "reopen_pending" });

    const [workspace] = await db
      .select({
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    // The row stays active, keeps the flag, and keeps its generation.
    expect(workspace?.status).toBe("active");
    expect(workspace?.closedAt).toBeNull();
    expect(metadataHasReopenPendingConsumption(workspace?.metadata as Record<string, unknown> | null)).toBe(true);
    expect(
      (workspace?.metadata as Record<string, unknown> | null)?.[EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY],
    ).toBe(4);
    // The rebuilt worktree is intact.
    await expect(fs.access(seeded.worktreePath)).resolves.toBeUndefined();
  });

  it("does not overwrite a newer archive when a stale cleanup failure lands late", async () => {
    // The archive route records a cleanup failure through the generation-fenced
    // write after the destructive cleanup throws. Simulate a reopen and a fresh
    // archive that raised the generation before the stale failure lands. The
    // generation guard skips the stale write, so the newer archive keeps its own
    // closedAt, cleanupReason, and status.
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    const staleClosedAt = new Date(Date.now() - 60_000);
    // The first archive closed the row at generation 2.
    await db
      .update(executionWorkspaces)
      .set({
        status: "archived",
        closedAt: staleClosedAt,
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 2,
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    // A resume reopened the row and a fresh archive raised the generation to 3.
    const newerClosedAt = new Date();
    await db
      .update(executionWorkspaces)
      .set({
        status: "archived",
        closedAt: newerClosedAt,
        cleanupReason: "newer archive",
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 3,
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    // The first archive's cleanup failure lands late at the captured generation 2.
    const skipped = await svc.applyClosedWorkspaceCleanupOutcome({
      id: seeded.executionWorkspaceId,
      closedAt: staleClosedAt,
      capturedGeneration: 2,
      cleanupReason: "stale teardown boom",
      markCleanupFailed: true,
    });
    expect(skipped).toBeNull();

    const [row] = await db
      .select({
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
        cleanupReason: executionWorkspaces.cleanupReason,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    // The newer archive survives; the stale failure did not overwrite it.
    expect(row?.status).toBe("archived");
    expect(row?.cleanupReason).toBe("newer archive");
    expect(row?.closedAt?.getTime()).toBe(newerClosedAt.getTime());
  });

  it("applies the cleanup outcome only while the row is still closed at the captured generation", async () => {
    // The archive route records the cleanup outcome after the destruction fence
    // returns. While the row is still closed at the captured generation, the
    // guarded write records the warnings and the cleanup_failed status. After a
    // resume reopened the row and raised the generation, the guard skips the write
    // so a stale patch does not overwrite the rebuilt worktree's active state.
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    await db
      .update(executionWorkspaces)
      .set({
        status: "archived",
        closedAt: new Date(),
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 2,
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    const closedAt = new Date();
    const applied = await svc.applyClosedWorkspaceCleanupOutcome({
      id: seeded.executionWorkspaceId,
      closedAt,
      capturedGeneration: 2,
      cleanupReason: "teardown warning",
      markCleanupFailed: true,
    });
    expect(applied?.status).toBe("cleanup_failed");
    expect(applied?.cleanupReason).toBe("teardown warning");

    // Simulate a resume that reopened the row and raised the generation after the
    // destruction fence returned.
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 3,
        },
      })
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    const skipped = await svc.applyClosedWorkspaceCleanupOutcome({
      id: seeded.executionWorkspaceId,
      closedAt: new Date(),
      capturedGeneration: 2,
      cleanupReason: "stale teardown warning",
      markCleanupFailed: true,
    });
    expect(skipped).toBeNull();

    const [row] = await db
      .select({ status: executionWorkspaces.status, cleanupReason: executionWorkspaces.cleanupReason })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    // The reopened active row survives; the stale cleanup patch did not land.
    expect(row?.status).toBe("active");
    expect(row?.cleanupReason).toBeNull();
  });

  it("routes every terminal-workspace write through one generation-fenced gateway that skips a stale generation", async () => {
    // One gateway gates every destructive terminal-workspace write. This test
    // raises the lifecycle generation past the value each writer captured, then
    // drives all four refactored writers. Each writer must skip, because the one
    // gateway sees the newer generation. This proves the single choke-point.

    // Writer 1 (clearReopenPendingConsumptionUnderLock), reached through
    // clearReopenPendingConsumptionForUnconsumedReopen. A reopen published the row
    // active at generation 5 and set the flag. A newer reopen then raised the
    // generation to 6. A clear that presents the stale generation 5 must skip.
    const clearSeed = await seedTerminalWorkspace({ mergedPr: true });
    const clearSince = new Date(Date.now() - 60_000).toISOString();
    await db
      .update(executionWorkspaces)
      .set({
        status: "active",
        closedAt: null,
        cleanupReason: null,
        cleanupEligibleAt: null,
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 6,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY]: true,
          [EXECUTION_WORKSPACE_REOPEN_PENDING_SINCE_METADATA_KEY]: clearSince,
        },
      })
      .where(eq(executionWorkspaces.id, clearSeed.executionWorkspaceId));
    const clearResult = await svc.clearReopenPendingConsumptionForUnconsumedReopen({
      workspaceId: clearSeed.executionWorkspaceId,
      issue: { id: clearSeed.sourceIssueId, companyId: clearSeed.companyId },
      actor: { agentId: null, actorType: "user" },
      expectedGeneration: 5,
    });
    expect(clearResult).toEqual({ cleared: false });
    const [afterClear] = await db
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, clearSeed.executionWorkspaceId));
    // The newer owner keeps its flag, so the stale clear did not touch the fence.
    expect(metadataHasReopenPendingConsumption(afterClear?.metadata as Record<string, unknown> | null)).toBe(true);

    // Writer 2 (refreshReopenPendingConsumptionUnderLock), reached through
    // refreshReopenPendingConsumption. A refresh that presents the stale
    // generation 5 must skip and leave the timestamp unchanged.
    const refreshResult = await svc.refreshReopenPendingConsumption({
      workspaceId: clearSeed.executionWorkspaceId,
      expectedGeneration: 5,
    });
    expect(refreshResult).toEqual({ refreshed: false });
    const [afterRefresh] = await db
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, clearSeed.executionWorkspaceId));
    expect(
      readMetadataReopenPendingConsumptionSince(afterRefresh?.metadata as Record<string, unknown> | null)?.toISOString(),
    ).toBe(clearSince);

    // Writer 3 (cleanupTerminalWorkspace) runs its destructive cleanup through the
    // same gateway call as fenceClosedWorkspaceDestruction, with the same
    // closed-status guard. The row is closed at generation 3, but the caller
    // captured generation 2, so the gateway skips and never runs the destroy body.
    const destroySeed = await seedTerminalWorkspace({ mergedPr: true });
    await db
      .update(executionWorkspaces)
      .set({
        status: "archived",
        closedAt: new Date(),
        metadata: {
          createdByRuntime: true,
          [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 3,
        },
      })
      .where(eq(executionWorkspaces.id, destroySeed.executionWorkspaceId));
    const destroy = vi.fn(async () => "destroyed");
    const destroyResult = await svc.fenceClosedWorkspaceDestruction({
      workspaceId: destroySeed.executionWorkspaceId,
      capturedGeneration: 2,
      destroy,
    });
    expect(destroyResult).toEqual({ skippedReopened: true });
    expect(destroy).not.toHaveBeenCalled();

    // Writer 4 (markTerminalCleanupFailedFenced). The reaper archives the row at
    // one generation and captures it. The cleanup then throws. Before the catch
    // handler writes cleanup_failed, a reopen and a fresh archive raise the
    // generation. The fenced write must skip, so the newer archive survives.
    const failSeed = await seedTerminalWorkspace({ mergedPr: true });
    const newerReason = "newer_archive_lifecycle_marker";
    const racingService = executionWorkspaceService(db, {
      resolvePullRequestDetails: async (_companyId, reference) =>
        pullRequestDetailsByKey.get(`${failSeed.companyId}:${reference.number}`) ?? { state: "unknown" },
      workspaceReaperCooldownDays: 0,
      beforeTerminalWorkspaceCleanup: async (workspace) => {
        await db
          .update(executionWorkspaces)
          .set({
            status: "archived",
            cleanupReason: newerReason,
            metadata: { [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: 2 },
            updatedAt: new Date(),
          })
          .where(eq(executionWorkspaces.id, workspace.id));
        throw new Error("forced cleanup failure");
      },
    });
    const sweep = await racingService.sweepTerminalWorkspaces();
    expect(sweep).toMatchObject({ cleanupFailed: 1 });
    const [afterFail] = await db
      .select({
        status: executionWorkspaces.status,
        cleanupReason: executionWorkspaces.cleanupReason,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, failSeed.executionWorkspaceId));
    // The fenced write saw the raised generation and skipped, so the newer
    // lifecycle state survives untouched.
    expect(afterFail?.status).toBe("archived");
    expect(afterFail?.cleanupReason).toBe(newerReason);
    expect(
      (afterFail?.metadata as Record<string, unknown> | null)?.[EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY],
    ).toBe(2);
  });

  it("holds Git index and ref locks across terminal cleanup", async () => {
    const seeded = await seedTerminalWorkspace({ mergedPr: true });
    await db.update(executionWorkspaces).set({
      metadata: { createdByRuntime: true },
    }).where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));
    let commitFailure = "";
    let refUpdateFailure = "";
    const lockingService = executionWorkspaceService(db, {
      resolvePullRequestDetails: async (_companyId, reference) =>
        pullRequestDetailsByKey.get(`${seeded.companyId}:${reference.number}`) ?? { state: "unknown" },
      workspaceReaperCooldownDays: 0,
      beforeTerminalWorkspaceCleanup: async () => {
        try {
          await runGit(seeded.worktreePath, ["commit", "--allow-empty", "-m", "Late commit"]);
        } catch (error) {
          commitFailure = error instanceof Error ? error.message : String(error);
        }
        try {
          await runGit(seeded.worktreePath, ["update-ref", "HEAD", seeded.headSha]);
        } catch (error) {
          refUpdateFailure = error instanceof Error ? error.message : String(error);
        }
      },
    });

    const sweep = await lockingService.sweepTerminalWorkspaces();
    const [workspace] = await db
      .select({ status: executionWorkspaces.status, cleanupReason: executionWorkspaces.cleanupReason })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(commitFailure).toContain("index.lock");
    expect(refUpdateFailure).toMatch(/HEAD\.lock|refs\/heads\/PAP-16015-delivery\.lock/);
    expect(sweep).toMatchObject({ archived: 1, cleanupFailed: 0 });
    expect(workspace).toMatchObject({ status: "archived", cleanupReason: "issue_terminal" });
    await expect(fs.access(seeded.worktreePath)).rejects.toThrow();
    expect(await readGit(seeded.repoRoot, ["branch", "--list", "PAP-16015-delivery"])).toBeNull();
  });

  it("does not treat a descendant PR on the shared workspace as parent delivery evidence", async () => {
    const seeded = await seedTerminalWorkspace();
    const descendantIssueId = randomUUID();
    await db.insert(issues).values({
      id: descendantIssueId,
      companyId: seeded.companyId,
      projectId: seeded.projectId,
      parentId: seeded.sourceIssueId,
      title: "Delivered descendant",
      status: "done",
      priority: "medium",
      executionWorkspaceId: seeded.executionWorkspaceId,
    });
    await db.insert(issueWorkProducts).values({
      companyId: seeded.companyId,
      issueId: descendantIssueId,
      executionWorkspaceId: seeded.executionWorkspaceId,
      type: "pull_request",
      provider: "github",
      title: "Descendant delivery",
      url: "https://github.com/paperclipai/paperclip/pull/10625",
      status: "merged",
    });

    const readiness = await svc.getCloseReadiness(seeded.executionWorkspaceId);
    const sweep = await svc.sweepTerminalWorkspaces();
    const [parentWorkspace] = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.executionWorkspaceId));

    expect(readiness?.deliveryState).toBe("unmerged");
    expect(sweep).toMatchObject({ archived: 0, skippedUndelivered: 1 });
    expect(parentWorkspace?.status).toBe("active");
  });

  it("reaps only fully-terminal delivered workspaces without active checkout runs", async () => {
    const eligible = await seedTerminalWorkspace({ mergedPr: true, childStatus: "done" });
    const activeRun = await seedTerminalWorkspace({ mergedPr: true, activeRun: true });
    const openDescendant = await seedTerminalWorkspace({ mergedPr: true, childStatus: "todo" });
    const undelivered = await seedTerminalWorkspace();

    const result = await svc.sweepTerminalWorkspaces();
    const rows = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status, cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt, cleanupReason: executionWorkspaces.cleanupReason })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [
        eligible.executionWorkspaceId,
        activeRun.executionWorkspaceId,
        openDescendant.executionWorkspaceId,
        undelivered.executionWorkspaceId,
      ]));
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(result).toMatchObject({ archived: 1, skippedActiveRun: 1, skippedNonTerminalTree: 1, skippedUndelivered: 1 });
    expect(byId.get(eligible.executionWorkspaceId)).toMatchObject({ status: "archived", cleanupReason: "issue_terminal" });
    expect(byId.get(eligible.executionWorkspaceId)?.cleanupEligibleAt).toBeInstanceOf(Date);
    expect(byId.get(activeRun.executionWorkspaceId)?.status).toBe("active");
    expect(byId.get(openDescendant.executionWorkspaceId)?.status).toBe("active");
    expect(byId.get(undelivered.executionWorkspaceId)?.status).toBe("active");

    const second = await svc.sweepTerminalWorkspaces();
    expect(second.archived).toBe(0);
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, eligible.executionWorkspaceId)))[0]?.status).toBe("archived");

    await issueService(db).update(eligible.sourceIssueId, {
      status: "todo",
      actorUserId: "local-board",
    });
    const reopenedWorkspace = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, eligible.executionWorkspaceId))
      .then((rows) => rows[0]);
    const reopenActivities = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, eligible.executionWorkspaceId));
    expect(reopenedWorkspace?.status).toBe("archived");
    expect(reopenActivities).toContainEqual({ action: "execution_workspace.source_issue_reopened" });
  }, 20_000);

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
      deliveryState: "unknown",
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

  it("reconciles forward when the recorded branch has no resolvable commit and the worktree is clean", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-missing-recorded-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["worktree", "add", "-b", "feature/current", worktreePath, "HEAD"]);
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
      name: "Missing recorded branch",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      identifier: "PAP-124",
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
      name: "feature/never-created",
      status: "idle",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/never-created",
      baseRef: "main",
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
      fromBranch: "feature/never-created",
      toBranch: "feature/current",
      fromSha: null,
      ancestryVerdict: "unknown",
      cleanliness: "clean",
    });

    const [comment] = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comment?.body).toContain("Execution workspace branch reconciled.");
    expect(comment?.body).toContain("- From branch: `feature/never-created`");
    expect(comment?.body).toContain("- To branch: `feature/current`");
  }, 20_000);

  it("keeps forward reconciliation fail-closed when the recorded branch is missing but the worktree is dirty", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-missing-recorded-dirty-${randomUUID()}`);
    tempDirs.add(worktreePath);

    await runGit(repoRoot, ["worktree", "add", "-b", "feature/current", worktreePath, "HEAD"]);
    await fs.writeFile(path.join(worktreePath, "uncommitted.txt"), "dirty work\n", "utf8");

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
      name: "Missing recorded branch dirty",
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
      name: "feature/never-created",
      status: "idle",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/never-created",
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
      message: expect.stringContaining("requires the recorded branch to be an ancestor"),
    });
  }, 20_000);

  it("keeps forward reconciliation fail-closed when the checked-out branch ref does not resolve either", async () => {
    const repoRoot = await createTempRepo();
    tempDirs.add(repoRoot);
    const worktreePath = path.join(path.dirname(repoRoot), `paperclip-missing-both-refs-${randomUUID()}`);
    tempDirs.add(worktreePath);

    // An empty tree keeps the worktree clean even after its branch ref is
    // deleted, so this exercises the adoption gate rather than cleanliness.
    const emptyTreeSha = (await readGit(repoRoot, ["hash-object", "-t", "tree", "/dev/null"]))!;
    const emptyCommitSha = (await readGit(repoRoot, ["commit-tree", emptyTreeSha, "-m", "empty base"]))!;
    await runGit(repoRoot, ["branch", "empty-base", emptyCommitSha]);
    await runGit(repoRoot, ["worktree", "add", "-b", "feature/current", worktreePath, "empty-base"]);
    // Deleting the local ref while it is checked out leaves symbolic-ref still
    // reporting the branch name even though nothing resolves to a commit.
    await runGit(repoRoot, ["update-ref", "-d", "refs/heads/feature/current"]);

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
      name: "Missing both branch refs",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      identifier: "PAP-126",
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
      name: "feature/never-created",
      status: "idle",
      providerType: "git_worktree",
      cwd: worktreePath,
      providerRef: worktreePath,
      branchName: "feature/never-created",
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
      message: expect.stringContaining("requires the recorded branch to be an ancestor"),
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

  it("returns full details at the observed volume without multiplying unconfigured shared service history", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const workspaceCount = 6_176;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace scale regression",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      isPrimary: true,
      cwd: "/tmp/workspace-scale-regression",
    });

    const workspaceRows = Array.from({ length: workspaceCount }, (_, index) => ({
      id: randomUUID(),
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "shared_workspace" as const,
      strategyType: "project_primary" as const,
      name: `Shared workspace ${index + 1}`,
      status: "idle" as const,
      providerType: "local_fs" as const,
      cwd: "/tmp/workspace-scale-regression",
    }));
    for (let offset = 0; offset < workspaceRows.length; offset += 400) {
      await db.insert(executionWorkspaces).values(workspaceRows.slice(offset, offset + 400));
    }
    await db.insert(workspaceRuntimeServices).values(
      Array.from({ length: 163 }, (_, index) => ({
        id: randomUUID(),
        companyId,
        projectId,
        projectWorkspaceId,
        scopeType: "project_workspace",
        scopeId: projectWorkspaceId,
        serviceName: `historical-service-${index + 1}`,
        status: "stopped",
        lifecycle: "shared",
        reuseKey: `historical-service-${index + 1}`,
        command: `pnpm historical:${index + 1}`,
        cwd: "/tmp/workspace-scale-regression",
        provider: "local_process",
        healthStatus: "unknown",
      })),
    );

    const workspaces = await svc.list(companyId);

    expect(workspaces).toHaveLength(workspaceCount);
    expect(workspaces.reduce((count, workspace) => count + (workspace.runtimeServices?.length ?? 0), 0)).toBe(0);
    expect(JSON.stringify(workspaces).length).toBeLessThan(12_000_000);

    const overview = await svc.listOverview(companyId, { limit: 1, offset: 0 });
    expect(overview.total).toBe(workspaceCount);
    expect(overview.items[0]).toMatchObject({
      serviceCount: 0,
      runningServiceCount: 0,
      primaryService: null,
      hasRuntimeConfig: false,
    });
  }, 30_000);

  it("inherits only runtime-service rows matching the current project workspace configuration and reuse scopes", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const currentWebServiceId = randomUUID();
    const currentWorkerServiceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Configured runtime selection",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      isPrimary: true,
      cwd: "/tmp/configured-runtime-selection",
      metadata: {
        runtimeConfig: {
          workspaceRuntime: {
            services: [
              { name: "web", command: "pnpm dev" },
              {
                name: "worker",
                command: "pnpm worker",
                reuseScope: "execution_workspace",
              },
            ],
          },
          desiredState: "stopped",
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
      name: "Shared configured workspace",
      status: "idle",
      providerType: "local_fs",
      cwd: "/tmp/configured-runtime-selection",
    });
    await db.insert(workspaceRuntimeServices).values([
      {
        id: randomUUID(),
        companyId,
        projectId,
        projectWorkspaceId,
        scopeType: "project_workspace",
        scopeId: projectWorkspaceId,
        serviceName: "web",
        status: "stopped",
        lifecycle: "shared",
        reuseKey: "old-web",
        command: "pnpm dev",
        cwd: "/tmp/configured-runtime-selection",
        provider: "local_process",
        healthStatus: "unknown",
        updatedAt: new Date("2026-07-29T10:00:00.000Z"),
      },
      {
        id: currentWebServiceId,
        companyId,
        projectId,
        projectWorkspaceId,
        scopeType: "project_workspace",
        scopeId: projectWorkspaceId,
        serviceName: "web",
        status: "stopped",
        lifecycle: "shared",
        reuseKey: "current-web",
        command: "pnpm dev",
        cwd: "/tmp/configured-runtime-selection",
        provider: "local_process",
        healthStatus: "unknown",
        updatedAt: new Date("2026-07-30T10:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        projectId,
        projectWorkspaceId,
        scopeType: "project_workspace",
        scopeId: projectWorkspaceId,
        serviceName: "removed-worker",
        status: "stopped",
        lifecycle: "shared",
        reuseKey: "removed-worker",
        command: "pnpm worker",
        cwd: "/tmp/configured-runtime-selection",
        provider: "local_process",
        healthStatus: "unknown",
        updatedAt: new Date("2026-07-31T10:00:00.000Z"),
      },
      {
        id: currentWorkerServiceId,
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId,
        scopeType: "execution_workspace",
        scopeId: executionWorkspaceId,
        serviceName: "worker",
        status: "running",
        lifecycle: "shared",
        reuseKey: "current-worker",
        command: "pnpm worker",
        cwd: "/tmp/configured-runtime-selection",
        provider: "local_process",
        healthStatus: "healthy",
        updatedAt: new Date("2026-07-31T11:00:00.000Z"),
      },
    ]);

    const [workspace] = await svc.list(companyId);
    expect(workspace?.runtimeServices).toEqual([
      expect.objectContaining({
        id: currentWebServiceId,
        serviceName: "web",
        configIndex: 0,
      }),
      expect.objectContaining({
        id: currentWorkerServiceId,
        serviceName: "worker",
        configIndex: 1,
      }),
    ]);

    const overview = await svc.listOverview(companyId, { limit: 10, offset: 0 });
    expect(overview.items[0]).toMatchObject({
      serviceCount: 2,
      runningServiceCount: 1,
      hasRuntimeConfig: true,
      primaryService: {
        id: currentWorkerServiceId,
        serviceName: "worker",
        status: "running",
      },
    });
  });

  it("serializes the verified HTTPS URL as canonical and never falls back to the HTTP backend", async () => {
    // PAP-17158: the UI's workspace/project/issue launch links read `url` off the
    // serialized runtime service. Two things have to hold for a managed HTTPS
    // runtime: once exposure is `ready` the canonical `url` is the HTTPS public
    // URL, and while exposure is *not* ready the canonical `url` stays null even
    // though the row still knows its loopback `backendUrl`. Serializing that
    // backend URL would put `http://…` back into a launch link, which is exactly
    // the fail-closed contract this feature exists to enforce.
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const readyWorkspaceId = randomUUID();
    const provisioningWorkspaceId = randomUUID();
    const readyServiceId = randomUUID();
    const provisioningServiceId = randomUUID();
    const hostname = "paperclip-dev.tail29c1aa.ts.net";
    const httpsUrl = `https://${hostname}:42010`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "HTTPS URL serialization",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      isPrimary: true,
      cwd: "/tmp/https-url-serialization",
      metadata: {
        runtimeConfig: {
          workspaceRuntime: { services: [{ name: "paperclip-dev", command: "pnpm dev" }] },
          desiredState: "running",
        },
      },
    });
    await db.insert(executionWorkspaces).values([
      {
        id: readyWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "dedicated_worktree",
        strategyType: "git_worktree",
        name: "Exposed workspace",
        status: "idle",
        providerType: "local_fs",
        cwd: "/tmp/https-url-serialization/ready",
      },
      {
        id: provisioningWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "dedicated_worktree",
        strategyType: "git_worktree",
        name: "Provisioning workspace",
        status: "idle",
        providerType: "local_fs",
        cwd: "/tmp/https-url-serialization/provisioning",
      },
    ]);
    await db.insert(workspaceRuntimeServices).values([
      {
        id: readyServiceId,
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: readyWorkspaceId,
        scopeType: "execution_workspace",
        scopeId: readyWorkspaceId,
        serviceName: "paperclip-dev",
        status: "running",
        lifecycle: "shared",
        reuseKey: "ready-dev",
        command: "pnpm dev",
        cwd: "/tmp/https-url-serialization/ready",
        port: 42_010,
        url: httpsUrl,
        // The loopback backend is still recorded; it must never be serialized.
        backendUrl: "http://127.0.0.1:42010",
        provider: "local_process",
        healthStatus: "healthy",
        exposure: {
          provider: "tailscale_https",
          state: "ready",
          publicUrl: httpsUrl,
          hostname,
          listeners: [
            { purpose: "app", publicPort: 42_010, targetPort: 42_010 },
            { purpose: "vite_hmr", publicPort: 52_010, targetPort: 52_010 },
          ],
          brokerRef: "broker-ref-1",
          lastError: null,
          updatedAt: "2026-08-12T10:00:00.000Z",
        },
        updatedAt: new Date("2026-08-12T10:00:00.000Z"),
      },
      {
        id: provisioningServiceId,
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId: provisioningWorkspaceId,
        scopeType: "execution_workspace",
        scopeId: provisioningWorkspaceId,
        serviceName: "paperclip-dev",
        status: "running",
        lifecycle: "shared",
        reuseKey: "provisioning-dev",
        command: "pnpm dev",
        cwd: "/tmp/https-url-serialization/provisioning",
        port: 42_020,
        url: null,
        backendUrl: "http://127.0.0.1:42020",
        provider: "local_process",
        healthStatus: "healthy",
        exposure: {
          provider: "tailscale_https",
          state: "pending",
          publicUrl: null,
          hostname,
          listeners: [],
          brokerRef: null,
          lastError: null,
          updatedAt: "2026-08-12T10:00:00.000Z",
        },
        updatedAt: new Date("2026-08-12T10:00:00.000Z"),
      },
    ]);

    const workspaces = await svc.list(companyId);
    const readyService = workspaces
      .find((workspace) => workspace.id === readyWorkspaceId)
      ?.runtimeServices.find((service) => service.id === readyServiceId);
    expect(readyService).toMatchObject({
      url: httpsUrl,
      port: 42_010,
      exposure: { provider: "tailscale_https", state: "ready", publicUrl: httpsUrl, hostname },
    });
    // Lease handles are server-private and must never reach a serialized DTO.
    expect(readyService).not.toHaveProperty("exposureHandle");

    const provisioningService = workspaces
      .find((workspace) => workspace.id === provisioningWorkspaceId)
      ?.runtimeServices.find((service) => service.id === provisioningServiceId);
    expect(provisioningService?.url).toBeNull();
    expect(provisioningService?.exposure).toMatchObject({ state: "pending", publicUrl: null });
    expect(JSON.stringify(provisioningService)).not.toContain("http://127.0.0.1:42020");

    // The overview feeds the workspace list launch links.
    const overview = await svc.listOverview(companyId, { limit: 10, offset: 0 });
    const readyItem = overview.items.find((item) => item.workspaceId === readyWorkspaceId);
    expect(readyItem?.primaryService).toMatchObject({
      id: readyServiceId,
      status: "running",
      url: httpsUrl,
      exposure: { state: "ready", publicUrl: httpsUrl },
    });
    expect(new URL(readyItem!.primaryService!.url!).protocol).toBe("https:");

    const provisioningItem = overview.items.find((item) => item.workspaceId === provisioningWorkspaceId);
    expect(provisioningItem?.primaryService).toMatchObject({
      id: provisioningServiceId,
      status: "running",
      url: null,
      exposure: { state: "pending" },
    });
    expect(JSON.stringify(provisioningItem)).not.toContain("http://127.0.0.1:42020");
  }, 30_000);

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
      deliveryState: "unmerged",
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
