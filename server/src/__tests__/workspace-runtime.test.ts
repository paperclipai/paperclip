import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseEnvContents } from "dotenv";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  buildWorkspaceRuntimeDesiredStatePatch,
  cleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable,
  ensureServerWorkspaceLinksCurrent,
  ensureRuntimeServicesForRun,
  listConfiguredRuntimeServiceEntries,
  normalizeAdapterManagedRuntimeServices,
  reconcilePersistedRuntimeServicesOnStartup,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  resetRuntimeServicesForTests,
  resolveWorkspaceRuntimeReadinessTimeoutSec,
  resolveShell,
  sanitizeRuntimeServiceBaseEnv,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import { readLocalServicePortOwner, writeLocalServiceRegistryRecord } from "../services/local-service-supervisor.ts";
import { resolvePaperclipConfigPath } from "../paths.ts";
import type { WorkspaceOperation } from "@paperclipai/shared";
import type { WorkspaceOperationRecorder } from "../services/workspace-operations.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const execFileAsync = promisify(execFile);

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

function workspaceBranchIncoherenceFingerprintForTest(input: {
  sourceIssueId: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: "clean" | "dirty" | "unknown";
  expectedHeadSha: string | null;
  actualHeadSha: string | null;
}) {
  const digest = createHash("sha256")
    .update(stableStringifyForTest({
      version: 1,
      reason: "git_worktree_branch_incoherence",
      sourceIssueId: input.sourceIssueId,
      executionWorkspaceId: input.executionWorkspaceId,
      worktreePath: path.resolve(input.worktreePath),
      expectedBranch: input.expectedBranch,
      actualBranch: input.actualBranch,
      cleanliness: input.cleanliness,
      expectedHeadSha: input.expectedHeadSha,
      actualHeadSha: input.actualHeadSha,
    }))
    .digest("hex");
  return `workspace_incoherence:v1:sha256:${digest}`;
}

const leasedRunIds = new Set<string>();
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace-runtime tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}
const provisionWorktreeScriptPath = new URL("../../../scripts/provision-worktree.sh", import.meta.url);

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function readGit(cwd: string, args: string[]) {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

async function runPnpm(cwd: string, args: string[]) {
  await execFileAsync("pnpm", args, { cwd });
}

async function createTempRepo(defaultBranch = "main") {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", defaultBranch]);
  return repoRoot;
}

async function expectPersistedBranchMismatchRejected(input: {
  repoRoot: string;
  worktreePath: string;
  expectedBranch: string;
  actualBranch: string;
  issueId: string;
  executionWorkspaceId: string;
  expectedAncestryVerdict: "diverged" | "unknown";
  expectedReason?: string;
}) {
  let error: unknown = null;
  try {
    await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: input.repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: input.executionWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: input.worktreePath,
        providerRef: input.worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: input.expectedBranch,
      },
      issue: {
        id: input.issueId,
        identifier: "PAP-459",
        title: "Reject unsafe forward branch reconciliation",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      enableWorkspaceBranchReconcileForward: true,
    });
  } catch (err) {
    error = err;
  }

  expect(error).toMatchObject({
    code: "workspace_validation_failed",
    resultJson: {
      workspaceValidation: expect.objectContaining({
        reason: "git_worktree_branch_incoherence",
        sourceIssueId: input.issueId,
        executionWorkspaceId: input.executionWorkspaceId,
        expectedBranch: input.expectedBranch,
        actualBranch: input.actualBranch,
        provenance: expect.objectContaining({
          ancestryVerdict: input.expectedAncestryVerdict,
        }),
        safeRepair: expect.objectContaining({
          eligible: false,
          attempted: false,
          succeeded: false,
          ...(input.expectedReason ? { reason: input.expectedReason } : {}),
        }),
      }),
    },
  });
}

async function createClonedRepoWithRemote() {
  const sourceRepo = await createTempRepo("master");
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-remote-"));
  const remotePath = path.join(remoteDir, "paperclip.git");
  await execFileAsync("git", ["clone", "--bare", sourceRepo, remotePath]);

  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-clone-"));
  const repoRoot = path.join(cloneRoot, "paperclip");
  await execFileAsync("git", ["clone", remotePath, repoRoot]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  return { sourceRepo, remotePath, repoRoot };
}

async function advanceRemoteMaster(sourceRepo: string, remotePath: string, fileName: string) {
  await fs.writeFile(path.join(sourceRepo, fileName), `${fileName}\n`, "utf8");
  await runGit(sourceRepo, ["add", fileName]);
  await runGit(sourceRepo, ["commit", "-m", `Add ${fileName}`]);
  await runGit(sourceRepo, ["push", remotePath, "master"]);
  return readGit(sourceRepo, ["rev-parse", "master"]);
}

function realizeWorktreeForTest(repoRoot: string, repoRef: string | null) {
  return realizeExecutionWorkspace({
    base: {
      baseCwd: repoRoot,
      source: "project_primary",
      projectId: "project-1",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef,
    },
    config: {
      workspaceStrategy: {
        type: "git_worktree",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
      },
    },
    issue: {
      id: "issue-1",
      identifier: "PAP-447",
      title: "Add Worktree Support",
    },
    agent: {
      id: "agent-1",
      name: "Codex Coder",
      companyId: "company-1",
    },
  });
}

function buildWorkspace(cwd: string): RealizedExecutionWorkspace {
  return {
    baseCwd: cwd,
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: "HEAD",
    strategy: "project_primary",
    cwd,
    branchName: null,
    worktreePath: null,
    warnings: [],
    created: false,
  };
}

function createWorkspaceOperationRecorderDouble() {
  const operations: Array<{
    phase: string;
    command: string | null;
    cwd: string | null;
    metadata: Record<string, unknown> | null;
    result: {
      status?: string;
      exitCode?: number | null;
      stdout?: string | null;
      stderr?: string | null;
      system?: string | null;
      metadata?: Record<string, unknown> | null;
    };
  }> = [];
  let executionWorkspaceId: string | null = null;

  const recorder: WorkspaceOperationRecorder = {
    attachExecutionWorkspaceId: async (nextExecutionWorkspaceId) => {
      executionWorkspaceId = nextExecutionWorkspaceId;
    },
    recordOperation: async (input) => {
      const result = await input.run();
      operations.push({
        phase: input.phase,
        command: input.command ?? null,
        cwd: input.cwd ?? null,
        metadata: {
          ...(input.metadata ?? {}),
          ...(executionWorkspaceId ? { executionWorkspaceId } : {}),
        },
        result,
      });
      return {
        id: `op-${operations.length}`,
        companyId: "company-1",
        executionWorkspaceId,
        heartbeatRunId: "run-1",
        issueId: null,
        phase: input.phase,
        command: input.command ?? null,
        cwd: input.cwd ?? null,
        status: (result.status ?? "succeeded") as WorkspaceOperation["status"],
        exitCode: result.exitCode ?? null,
        logStore: "local_file",
        logRef: `op-${operations.length}.ndjson`,
        logBytes: 0,
        logSha256: null,
        logCompressed: false,
        stdoutExcerpt: result.stdout ?? null,
        stderrExcerpt: result.stderr ?? null,
        metadata: input.metadata ?? null,
        startedAt: new Date(),
        finishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  };

  return { recorder, operations };
}

afterEach(async () => {
  await Promise.all(
    Array.from(leasedRunIds).map(async (runId) => {
      await releaseRuntimeServicesForRun(runId);
      leasedRunIds.delete(runId);
    }),
  );
  delete process.env.PAPERCLIP_CONFIG;
  delete process.env.PAPERCLIP_HOME;
  delete process.env.PAPERCLIP_INSTANCE_ID;
  delete process.env.PAPERCLIP_WORKTREES_DIR;
  delete process.env.DATABASE_URL;
  await resetRuntimeServicesForTests();
});

describe("sanitizeRuntimeServiceBaseEnv", () => {
  it("removes inherited Paperclip and pnpm auth flags before spawning runtime services", () => {
    const sanitized = sanitizeRuntimeServiceBaseEnv({
      PATH: process.env.PATH,
      DATABASE_URL: "postgres://example.test/paperclip",
      PAPERCLIP_HOME: "/tmp/paperclip-home",
      PAPERCLIP_INSTANCE_ID: "runtime-instance",
      npm_config_tailscale_auth: "true",
      npm_config_authenticated_private: "true",
      HOST: "0.0.0.0",
    });

    expect(sanitized.PAPERCLIP_HOME).toBeUndefined();
    expect(sanitized.PAPERCLIP_INSTANCE_ID).toBeUndefined();
    expect(sanitized.DATABASE_URL).toBeUndefined();
    expect(sanitized.npm_config_tailscale_auth).toBeUndefined();
    expect(sanitized.npm_config_authenticated_private).toBeUndefined();
    expect(sanitized.HOST).toBe("0.0.0.0");
  });
});

describe("ensureServerWorkspaceLinksCurrent", () => {
  it("relinks stale server workspace dependencies inside the current repo root", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-links-"));
    const staleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-links-stale-"));
    const serverNodeModulesScopeDir = path.join(repoRoot, "server", "node_modules", "@paperclipai");
    const expectedPackageDir = path.join(repoRoot, "packages", "db");
    const stalePackageDir = path.join(staleRoot, "db");

    await fs.mkdir(path.join(repoRoot, "server"), { recursive: true });
    await fs.mkdir(expectedPackageDir, { recursive: true });
    await fs.mkdir(stalePackageDir, { recursive: true });
    await fs.mkdir(serverNodeModulesScopeDir, { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: /tmp/paperclip-main/.git/worktrees/runtime-links\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - server\n", "utf8");
    await fs.writeFile(
      path.join(repoRoot, "server", "package.json"),
      JSON.stringify({
        name: "@paperclipai/server",
        dependencies: {
          "@paperclipai/db": "workspace:*",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(expectedPackageDir, "package.json"),
      JSON.stringify({ name: "@paperclipai/db" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stalePackageDir, "package.json"),
      JSON.stringify({ name: "@paperclipai/db" }),
      "utf8",
    );
    await fs.symlink(stalePackageDir, path.join(serverNodeModulesScopeDir, "db"));

    await ensureServerWorkspaceLinksCurrent(path.join(repoRoot, "server"));
    expect(await fs.realpath(path.join(serverNodeModulesScopeDir, "db"))).toBe(await fs.realpath(expectedPackageDir));
  });

  it("skips relinking when server workspace dependencies already point at the repo", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-links-current-"));
    const serverNodeModulesScopeDir = path.join(repoRoot, "server", "node_modules", "@paperclipai");
    const expectedPackageDir = path.join(repoRoot, "packages", "db");

    await fs.mkdir(path.join(repoRoot, "server"), { recursive: true });
    await fs.mkdir(expectedPackageDir, { recursive: true });
    await fs.mkdir(serverNodeModulesScopeDir, { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: /tmp/paperclip-main/.git/worktrees/runtime-links-current\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - server\n", "utf8");
    await fs.writeFile(
      path.join(repoRoot, "server", "package.json"),
      JSON.stringify({
        name: "@paperclipai/server",
        dependencies: {
          "@paperclipai/db": "workspace:*",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(expectedPackageDir, "package.json"),
      JSON.stringify({ name: "@paperclipai/db" }),
      "utf8",
    );
    await fs.symlink(expectedPackageDir, path.join(serverNodeModulesScopeDir, "db"));

    await ensureServerWorkspaceLinksCurrent(path.join(repoRoot, "server"));
  });

  it("skips relinking outside linked git worktrees", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-links-non-worktree-"));
    const staleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-links-non-worktree-stale-"));
    const serverNodeModulesScopeDir = path.join(repoRoot, "server", "node_modules", "@paperclipai");
    const expectedPackageDir = path.join(repoRoot, "packages", "db");
    const stalePackageDir = path.join(staleRoot, "db");

    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "server"), { recursive: true });
    await fs.mkdir(expectedPackageDir, { recursive: true });
    await fs.mkdir(stalePackageDir, { recursive: true });
    await fs.mkdir(serverNodeModulesScopeDir, { recursive: true });
    await fs.writeFile(path.join(repoRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n  - server\n", "utf8");
    await fs.writeFile(
      path.join(repoRoot, "server", "package.json"),
      JSON.stringify({
        name: "@paperclipai/server",
        dependencies: {
          "@paperclipai/db": "workspace:*",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(expectedPackageDir, "package.json"),
      JSON.stringify({ name: "@paperclipai/db" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(stalePackageDir, "package.json"),
      JSON.stringify({ name: "@paperclipai/db" }),
      "utf8",
    );
    await fs.symlink(stalePackageDir, path.join(serverNodeModulesScopeDir, "db"));

    await ensureServerWorkspaceLinksCurrent(path.join(repoRoot, "server"));
    expect(await fs.realpath(path.join(serverNodeModulesScopeDir, "db"))).toBe(await fs.realpath(stalePackageDir));
  });
});

describe("realizeExecutionWorkspace", () => {
  it("defaults new git worktrees to freshly fetched origin/master", async () => {
    const sourceRepo = await createTempRepo("master");
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-remote-"));
    const remotePath = path.join(remoteDir, "paperclip.git");
    await execFileAsync("git", ["clone", "--bare", sourceRepo, remotePath]);

    const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-clone-"));
    const repoRoot = path.join(cloneRoot, "paperclip");
    await execFileAsync("git", ["clone", remotePath, repoRoot]);
    await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
    await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);

    await fs.writeFile(path.join(sourceRepo, "auth-fix.txt"), "cookie fix\n", "utf8");
    await runGit(sourceRepo, ["add", "auth-fix.txt"]);
    await runGit(sourceRepo, ["commit", "-m", "Add auth fix"]);
    await runGit(sourceRepo, ["push", remotePath, "master"]);
    const expectedRemoteHead = await readGit(sourceRepo, ["rev-parse", "master"]);
    expect(await readGit(repoRoot, ["rev-parse", "origin/master"])).not.toBe(expectedRemoteHead);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: null,
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(workspace.baseRefSha).toBe(expectedRemoteHead);
    expect(await readGit(repoRoot, ["rev-parse", "origin/master"])).toBe(expectedRemoteHead);
    expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(expectedRemoteHead);
  });

  it("creates and reuses a git worktree for an issue-scoped branch", async () => {
    const repoRoot = await createTempRepo();

    const first = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(first.strategy).toBe("git_worktree");
    expect(first.created).toBe(true);
    expect(first.branchName).toBe("PAP-447-add-worktree-support");
    expect(first.cwd).toContain(path.join(".paperclip", "worktrees"));
    await expect(fs.stat(path.join(first.cwd, ".git"))).resolves.toBeTruthy();

    const second = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(second.created).toBe(false);
    expect(second.cwd).toBe(first.cwd);
    expect(second.branchName).toBe(first.branchName);
  });

  it("warns when reusing a git worktree whose base ref has advanced", async () => {
    const repoRoot = await createTempRepo();

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "main",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });
    expect(initial.baseRefSha).toMatch(/^[0-9a-f]{40}$/);

    await fs.writeFile(path.join(repoRoot, "server-auth-fix.txt"), "cookie fix\n", "utf8");
    await runGit(repoRoot, ["add", "server-auth-fix.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add auth runtime fix"]);

    const reused = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "main",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(reused.created).toBe(false);
    expect(reused.cwd).toBe(initial.cwd);
    expect(reused.warnings).toEqual([
      expect.stringContaining("is behind main by 1 commit"),
    ]);
  });

  it("bases a fresh worktree on origin/master even when local master has unpushed commits", async () => {
    const { repoRoot } = await createClonedRepoWithRemote();
    const originHead = await readGit(repoRoot, ["rev-parse", "origin/master"]);

    await fs.writeFile(path.join(repoRoot, "unpushed.txt"), "local only\n", "utf8");
    await runGit(repoRoot, ["add", "unpushed.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Unpushed local work"]);
    const localHead = await readGit(repoRoot, ["rev-parse", "master"]);
    expect(localHead).not.toBe(originHead);

    const workspace = await realizeWorktreeForTest(repoRoot, null);

    expect(workspace.baseRefSha).toBe(originHead);
    expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(originHead);
  });

  it("maps a configured local branch base ref to origin/<branch> for fresh worktrees", async () => {
    const { repoRoot } = await createClonedRepoWithRemote();
    const originHead = await readGit(repoRoot, ["rev-parse", "origin/master"]);

    await fs.writeFile(path.join(repoRoot, "unpushed.txt"), "local only\n", "utf8");
    await runGit(repoRoot, ["add", "unpushed.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Unpushed local work"]);
    const localHead = await readGit(repoRoot, ["rev-parse", "master"]);
    expect(localHead).not.toBe(originHead);

    const workspace = await realizeWorktreeForTest(repoRoot, "master");

    expect(workspace.repoRef).toBe("origin/master");
    expect(workspace.baseRefSha).toBe(originHead);
    expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(originHead);
  });

  it("fast-forwards an unstarted reused worktree to the advanced origin/master", async () => {
    const { sourceRepo, remotePath, repoRoot } = await createClonedRepoWithRemote();

    const initial = await realizeWorktreeForTest(repoRoot, null);
    const initialHead = await readGit(initial.cwd, ["rev-parse", "HEAD"]);

    const advancedHead = await advanceRemoteMaster(sourceRepo, remotePath, "auth-fix.txt");
    expect(advancedHead).not.toBe(initialHead);

    const reused = await realizeWorktreeForTest(repoRoot, null);

    expect(reused.created).toBe(false);
    expect(reused.cwd).toBe(initial.cwd);
    expect(await readGit(reused.cwd, ["rev-parse", "HEAD"])).toBe(advancedHead);
    expect(reused.baseRefSha).toBe(advancedHead);
    expect(reused.warnings).toEqual([]);
  });

  it("does not reset a reused worktree that already has task commits", async () => {
    const { sourceRepo, remotePath, repoRoot } = await createClonedRepoWithRemote();

    const initial = await realizeWorktreeForTest(repoRoot, null);
    await fs.writeFile(path.join(initial.cwd, "task-work.txt"), "in progress\n", "utf8");
    await runGit(initial.cwd, ["add", "task-work.txt"]);
    await runGit(initial.cwd, ["commit", "-m", "Task work in progress"]);
    const taskHead = await readGit(initial.cwd, ["rev-parse", "HEAD"]);

    await advanceRemoteMaster(sourceRepo, remotePath, "auth-fix.txt");

    const reused = await realizeWorktreeForTest(repoRoot, null);

    expect(reused.created).toBe(false);
    expect(await readGit(reused.cwd, ["rev-parse", "HEAD"])).toBe(taskHead);
    expect(reused.warnings).toEqual([
      expect.stringContaining("is behind origin/master by 1 commit"),
    ]);
  });

  it("does not reset a reused worktree with untracked changes", async () => {
    const { sourceRepo, remotePath, repoRoot } = await createClonedRepoWithRemote();

    const initial = await realizeWorktreeForTest(repoRoot, null);
    const initialHead = await readGit(initial.cwd, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(initial.cwd, "scratch.txt"), "uncommitted scratch\n", "utf8");

    await advanceRemoteMaster(sourceRepo, remotePath, "auth-fix.txt");

    const reused = await realizeWorktreeForTest(repoRoot, null);

    expect(reused.created).toBe(false);
    expect(await readGit(reused.cwd, ["rev-parse", "HEAD"])).toBe(initialHead);
    await expect(fs.readFile(path.join(reused.cwd, "scratch.txt"), "utf8")).resolves.toBe(
      "uncommitted scratch\n",
    );
    expect(reused.warnings).toEqual([
      expect.stringContaining("is behind origin/master by 1 commit"),
    ]);
  });

  it("does not reset a reused worktree with untracked changes when status.showUntrackedFiles=no", async () => {
    const { sourceRepo, remotePath, repoRoot } = await createClonedRepoWithRemote();

    const initial = await realizeWorktreeForTest(repoRoot, null);
    const initialHead = await readGit(initial.cwd, ["rev-parse", "HEAD"]);
    // Without `--untracked-files=all`, this config hides untracked files from
    // `git status --porcelain`, which would let the clean-tree guard pass and a
    // `reset --hard` destroy the scratch file below.
    await readGit(initial.cwd, ["config", "status.showUntrackedFiles", "no"]);
    await fs.writeFile(path.join(initial.cwd, "scratch.txt"), "uncommitted scratch\n", "utf8");

    await advanceRemoteMaster(sourceRepo, remotePath, "auth-fix.txt");

    const reused = await realizeWorktreeForTest(repoRoot, null);

    expect(reused.created).toBe(false);
    expect(await readGit(reused.cwd, ["rev-parse", "HEAD"])).toBe(initialHead);
    await expect(fs.readFile(path.join(reused.cwd, "scratch.txt"), "utf8")).resolves.toBe(
      "uncommitted scratch\n",
    );
    expect(reused.warnings).toEqual([
      expect.stringContaining("is behind origin/master by 1 commit"),
    ]);
  });

  it("rejects reusing an empty directory that only looks like a worktree because it sits inside the repo", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-447-add-worktree-support";
    const poisonedPath = path.join(repoRoot, ".paperclip", "worktrees", branchName);
    await fs.mkdir(poisonedPath, { recursive: true });

    await expect(
      realizeExecutionWorkspace({
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        config: {
          workspaceStrategy: {
            type: "git_worktree",
            branchTemplate: "{{issue.identifier}}-{{slug}}",
          },
        },
        issue: {
          id: "issue-1",
          identifier: "PAP-447",
          title: "Add Worktree Support",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
      }),
    ).rejects.toThrow(/not a reusable git worktree \(path is not registered in `git worktree list`\)\./);
  });

  it("reuses the current linked worktree instead of nesting another worktree inside it", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-1355-worktree-reuse";
    const currentWorktree = path.join(repoRoot, ".paperclip", "worktrees", branchName);

    await fs.mkdir(path.dirname(currentWorktree), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", branchName, currentWorktree, "HEAD"], { cwd: repoRoot });

    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: currentWorktree,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-1355",
        title: "worktree reuse",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    const expectedWorktreePath = await fs.realpath(currentWorktree);
    expect(realized.created).toBe(false);
    await expect(fs.realpath(realized.cwd)).resolves.toBe(expectedWorktreePath);
    await expect(fs.realpath(realized.worktreePath ?? "")).resolves.toBe(expectedWorktreePath);
  });

  it("repairs a clean linked worktree whose branch drifted from the expected issue branch", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await runGit(initial.cwd, ["checkout", "-b", "unexpected-branch"]);

    const repaired = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(repaired.created).toBe(false);
    expect(repaired.cwd).toBe(initial.cwd);
    await expect(readGit(initial.cwd, ["branch", "--show-current"])).resolves.toBe("PAP-447-add-worktree-support");
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "worktree_prepare",
          command: "git checkout PAP-447-add-worktree-support",
          metadata: expect.objectContaining({
            branchIncoherenceRepair: true,
            expectedBranchName: "PAP-447-add-worktree-support",
            actualBranchName: "unexpected-branch",
            sourceIssueId: "issue-1",
            fingerprint: expect.stringMatching(/^workspace_incoherence:v1:sha256:/),
          }),
        }),
      ]),
    );
  });

  it("reuses an already checked out branch from git worktree metadata even when the target path differs", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-1355-worktree-reuse";
    const existingWorktree = path.join(repoRoot, ".paperclip", "worktrees", branchName);
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    await fs.mkdir(path.dirname(existingWorktree), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", branchName, existingWorktree, "HEAD"], { cwd: repoRoot });

    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: existingWorktree,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          worktreeParentDir: ".paperclip/other-worktrees",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-1355",
        title: "worktree reuse",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    const expectedWorktreePath = await fs.realpath(existingWorktree);
    expect(realized.created).toBe(false);
    await expect(fs.realpath(realized.cwd)).resolves.toBe(expectedWorktreePath);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.phase).toBe("worktree_prepare");
    expect(operations[0]?.command).toBeNull();
    expect(operations[0]?.metadata).toMatchObject({
      branchName,
      created: false,
      reused: true,
      worktreePath: expectedWorktreePath,
    });
  });

  it("slugifies unsafe issue titles for branch names and worktree folders", async () => {
    const repoRoot = await createTempRepo();

    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-unsafe",
        identifier: "PAP-991",
        title: "there should be a setting for the allowance of thumbs up / thumbs down data; `rm -rf`",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(realized.branchName).toBe(
      "PAP-991-there-should-be-a-setting-for-the-allowance-of-thumbs-up-thumbs-down-data-rm-rf",
    );
    expect(realized.branchName?.includes("/")).toBe(false);
    expect(path.basename(realized.cwd)).toBe(realized.branchName);
  });

  it("preserves intentional slashes and dots from the branch template", async () => {
    const repoRoot = await createTempRepo();

    const realized = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "release/{{issue.identifier}}.{{slug}}",
        },
      },
      issue: {
        id: "issue-template-safe",
        identifier: "PAP-992",
        title: "Hotfix / April.1",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(realized.branchName).toBe("release/PAP-992.hotfix-april-1");
    expect(path.basename(realized.cwd)).toBe("PAP-992.hotfix-april-1");
  });

  it("runs a configured provision command inside the derived worktree", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf '%s\\n' \"$PAPERCLIP_WORKSPACE_BRANCH\" > .paperclip-provision-branch",
        "printf '%s\\n' \"$PAPERCLIP_WORKSPACE_BASE_CWD\" > .paperclip-provision-base",
        "printf '%s\\n' \"$PAPERCLIP_WORKSPACE_CREATED\" > .paperclip-provision-created",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add worktree provision script"]);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-448",
        title: "Run provision command",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(workspace.cwd, ".paperclip-provision-branch"), "utf8")).resolves.toBe(
      "PAP-448-run-provision-command\n",
    );
    await expect(fs.readFile(path.join(workspace.cwd, ".paperclip-provision-base"), "utf8")).resolves.toBe(
      `${repoRoot}\n`,
    );
    await expect(fs.readFile(path.join(workspace.cwd, ".paperclip-provision-created"), "utf8")).resolves.toBe(
      "true\n",
    );

    const reused = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-448",
        title: "Run provision command",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(reused.cwd, ".paperclip-provision-created"), "utf8")).resolves.toBe("false\n");
  });

  it("uses the latest repo-managed provision script when reusing an existing worktree", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf 'v1\\n' > .paperclip-provision-version",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add initial provision script"]);

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-449",
        title: "Reuse latest provision script",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(initial.cwd, ".paperclip-provision-version"), "utf8")).resolves.toBe("v1\n");

    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf 'v2\\n' > .paperclip-provision-version",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Update provision script"]);

    await expect(fs.readFile(path.join(initial.cwd, "scripts", "provision.sh"), "utf8")).resolves.toContain("v1");

    const reused = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-449",
        title: "Reuse latest provision script",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(reused.cwd, ".paperclip-provision-version"), "utf8")).resolves.toBe("v2\n");
  }, 30_000);

  it("writes an isolated repo-local Paperclip config and worktree branding when provisioning", async () => {
    const repoRoot = await createTempRepo();
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-home-"));
    const isolatedWorktreeHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktrees-"));
    const isolatedBin = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-bin-"));
    const instanceId = "worktree-base";
    const sharedConfigDir = path.join(paperclipHome, "instances", instanceId);
    const sharedConfigPath = path.join(sharedConfigDir, "config.json");
    const sharedEnvPath = path.join(sharedConfigDir, ".env");

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = instanceId;
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedWorktreeHome;
    // Keep this server-side fixture on provision-worktree.sh's config writer path;
    // CLI/database seeding is covered by the CLI worktree tests.
    await fs.symlink(process.execPath, path.join(isolatedBin, "node"));
    process.env.PATH = `${isolatedBin}${path.delimiter}/usr/bin${path.delimiter}/bin`;

    await fs.mkdir(sharedConfigDir, { recursive: true });
    await fs.writeFile(
      sharedConfigPath,
      JSON.stringify(
        {
          $meta: {
            version: 1,
            updatedAt: "2026-03-26T00:00:00.000Z",
            source: "doctor",
          },
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(sharedConfigDir, "db"),
            embeddedPostgresPort: 54329,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(sharedConfigDir, "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(sharedConfigDir, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3100,
            allowedHostnames: [],
            serveUi: true,
          },
          auth: {
            baseUrlMode: "auto",
            disableSignUp: false,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(sharedConfigDir, "storage"),
            },
            s3: {
              bucket: "paperclip",
              region: "us-east-1",
              prefix: "",
              forcePathStyle: false,
            },
          },
          secrets: {
            provider: "local_encrypted",
            strictMode: false,
            localEncrypted: {
              keyFilePath: path.join(sharedConfigDir, "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(sharedEnvPath, 'DATABASE_URL="postgres://worktree:test@db.example.com:6543/paperclip"\n', "utf8");

    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.copyFile(
      fileURLToPath(new URL("../../../scripts/provision-worktree.sh", import.meta.url)),
      path.join(repoRoot, "scripts", "provision-worktree.sh"),
    );
    await runGit(repoRoot, ["add", "scripts/provision-worktree.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add worktree provision script"]);

    try {
      const workspaceInput = {
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        config: {
          workspaceStrategy: {
            type: "git_worktree",
            branchTemplate: "{{issue.identifier}}-{{slug}}",
            provisionCommand: "bash ./scripts/provision-worktree.sh",
          },
        },
        issue: {
          id: "issue-1",
          identifier: "PAP-885",
          title: "Show worktree banner",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
      } satisfies Parameters<typeof realizeExecutionWorkspace>[0];
      const workspace = await realizeExecutionWorkspace(workspaceInput);

      const configPath = path.join(workspace.cwd, ".paperclip", "config.json");
      const envPath = path.join(workspace.cwd, ".paperclip", ".env");
      const envContents = await fs.readFile(envPath, "utf8");
      const configContents = JSON.parse(await fs.readFile(configPath, "utf8"));
      const configStats = await fs.lstat(configPath);
      const expectedInstanceId = "pap-885-show-worktree-banner";
      const expectedInstanceRoot = path.join(
        isolatedWorktreeHome,
        "instances",
        expectedInstanceId,
      );

      expect(configStats.isSymbolicLink()).toBe(false);
      expect(configContents.database.embeddedPostgresDataDir).toBe(path.join(expectedInstanceRoot, "db"));
      expect(configContents.database.embeddedPostgresDataDir).not.toBe(path.join(sharedConfigDir, "db"));
      expect(configContents.server.port).not.toBe(3100);
      expect(configContents.secrets.localEncrypted.keyFilePath).toBe(
        path.join(expectedInstanceRoot, "secrets", "master.key"),
      );
      expect(envContents).not.toContain("DATABASE_URL=");
      const envVars = parseEnvContents(envContents);
      expect(envVars.PAPERCLIP_HOME).toBe(isolatedWorktreeHome);
      expect(envVars.PAPERCLIP_INSTANCE_ID).toBe(expectedInstanceId);
      expect(await fs.realpath(envVars.PAPERCLIP_CONFIG!)).toBe(await fs.realpath(configPath));
      expect(envVars.PAPERCLIP_IN_WORKTREE).toBe("true");
      expect(envVars.PAPERCLIP_WORKTREE_NAME).toBe("PAP-885-show-worktree-banner");

      process.chdir(workspace.cwd);
      expect(resolvePaperclipConfigPath()).toBe(configPath);

      const preservedPort = 39999;
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            ...configContents,
            server: {
              ...configContents.server,
              port: preservedPort,
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      await fs.writeFile(envPath, `${envContents}PAPERCLIP_WORKTREE_COLOR="#112233"\n`, "utf8");

      const reusedWorkspace = await realizeExecutionWorkspace(workspaceInput);
      const reusedConfigContents = JSON.parse(await fs.readFile(configPath, "utf8"));
      const reusedEnvContents = await fs.readFile(envPath, "utf8");

      expect(reusedWorkspace.cwd).toBe(workspace.cwd);
      expect(reusedWorkspace.created).toBe(false);
      expect(reusedConfigContents.server.port).toBe(preservedPort);
      expect(reusedConfigContents.database.embeddedPostgresDataDir).toBe(path.join(expectedInstanceRoot, "db"));
      expect(reusedEnvContents).toContain('PAPERCLIP_WORKTREE_COLOR="#112233"');
    } finally {
      process.chdir(previousCwd);
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  }, 15_000);

  it(
    "provisions worktree-local pnpm node_modules instead of reusing base-repo links",
    async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "packages", "shared"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "server"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          name: "workspace-root",
          private: true,
          packageManager: "pnpm@9.15.4",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "pnpm-workspace.yaml"),
      ["packages:", "  - packages/*", "  - server", ""].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "packages", "shared", "package.json"),
      JSON.stringify(
        {
          name: "@repo/shared",
          version: "1.0.0",
          private: true,
          type: "module",
          exports: "./index.js",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(repoRoot, "packages", "shared", "index.js"), "export const value = 'shared';\n", "utf8");
    await fs.writeFile(
      path.join(repoRoot, "server", "package.json"),
      JSON.stringify(
        {
          name: "server",
          private: true,
          type: "module",
          dependencies: {
            "@repo/shared": "workspace:*",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(repoRoot, "server", "index.js"), "export {};\n", "utf8");
    await fs.copyFile(provisionWorktreeScriptPath, path.join(repoRoot, "scripts", "provision-worktree.sh"));
    await fs.chmod(path.join(repoRoot, "scripts", "provision-worktree.sh"), 0o755);
    await runPnpm(repoRoot, ["install"]);
    await runGit(repoRoot, ["add", "."]);
    await runGit(repoRoot, ["commit", "-m", "Add pnpm workspace fixture"]);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-551",
        title: "Provision local workspace dependencies",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect((await fs.lstat(path.join(workspace.cwd, "node_modules"))).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(workspace.cwd, "server", "node_modules"))).isSymbolicLink()).toBe(false);
    await expect(fs.realpath(path.join(workspace.cwd, "server", "node_modules", "@repo", "shared"))).resolves.toBe(
      await fs.realpath(path.join(workspace.cwd, "packages", "shared")),
    );
    await expect(fs.realpath(path.join(repoRoot, "server", "node_modules", "@repo", "shared"))).resolves.toBe(
      await fs.realpath(path.join(repoRoot, "packages", "shared")),
    );
    },
    30_000,
  );

  it("provisions successfully when install is needed but there are no symlinked node_modules to move", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          name: "workspace-root",
          private: true,
          packageManager: "pnpm@9.15.4",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "",
        "settings:",
        "  autoInstallPeers: true",
        "  excludeLinksFromLockfile: false",
        "",
        "importers:",
        "  .: {}",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.copyFile(provisionWorktreeScriptPath, path.join(repoRoot, "scripts", "provision-worktree.sh"));
    await fs.chmod(path.join(repoRoot, "scripts", "provision-worktree.sh"), 0o755);

    await fs.mkdir(path.join(repoRoot, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "node_modules", ".keep"), "", "utf8");

    await runGit(repoRoot, ["add", "package.json", "pnpm-lock.yaml", "scripts/provision-worktree.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add minimal provision fixture"]);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-552",
        title: "Install without moved symlinks",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(workspace.cwd, ".paperclip", "config.json"), "utf8")).resolves.toContain(
      "\"database\"",
    );
  }, 30_000);

  it("reinstalls worktree-local pnpm dependencies when package metadata changes", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-stale-deps-"));
    const baseRoot = path.join(tempRoot, "base");
    const worktreeRoot = path.join(tempRoot, "worktree");
    const fakeBin = path.join(tempRoot, "bin");
    const fakePnpmPath = path.join(fakeBin, "pnpm");
    const scriptPath = path.join(worktreeRoot, "provision-worktree.sh");
    const installLogPath = path.join(tempRoot, "install.log");

    try {
      await fs.mkdir(path.join(baseRoot, "node_modules"), { recursive: true });
      await fs.mkdir(path.join(worktreeRoot, "node_modules"), { recursive: true });
      await fs.mkdir(path.join(worktreeRoot, "ui"), { recursive: true });
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.copyFile(provisionWorktreeScriptPath, scriptPath);
      await fs.chmod(scriptPath, 0o755);
      await fs.writeFile(
        path.join(worktreeRoot, "package.json"),
        JSON.stringify(
          {
            name: "workspace-root",
            private: true,
            packageManager: "pnpm@9.15.4",
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.writeFile(
        path.join(worktreeRoot, "pnpm-lock.yaml"),
        ["lockfileVersion: '9.0'", "", "importers:", "  .: {}", ""].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(worktreeRoot, "ui", "package.json"),
        JSON.stringify({ name: "ui", private: true, dependencies: {} }, null, 2),
        "utf8",
      );
      await fs.writeFile(
        fakePnpmPath,
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"paperclipai\" ] && [ \"$2\" = \"--help\" ]; then",
          "  exit 1",
          "fi",
          "if [ \"$1\" = \"install\" ] && [ \"$2\" = \"--prod=false\" ] && [ \"$3\" = \"--frozen-lockfile\" ]; then",
          "  mkdir -p \"$PWD/node_modules\"",
          `  echo "install:$*" >> ${JSON.stringify(installLogPath)}`,
          "  exit 0",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.chmod(fakePnpmPath, 0o755);

      const runScript = () => execFileAsync(scriptPath, [], {
        cwd: worktreeRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PAPERCLIP_WORKSPACE_BASE_CWD: baseRoot,
          PAPERCLIP_WORKSPACE_CWD: worktreeRoot,
        },
      });

      await runScript();
      await runScript();
      await expect(fs.readFile(installLogPath, "utf8")).resolves.toBe(
        "install:install --prod=false --frozen-lockfile\n",
      );

      await fs.writeFile(
        path.join(worktreeRoot, "ui", "package.json"),
        JSON.stringify(
          { name: "ui", private: true, dependencies: { "@xterm/addon-fit": "^0.11.0" } },
          null,
          2,
        ),
        "utf8",
      );

      await runScript();
      await expect(fs.readFile(installLogPath, "utf8")).resolves.toBe(
        "install:install --prod=false --frozen-lockfile\ninstall:install --prod=false --frozen-lockfile\n",
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails instead of writing an unseeded fallback config when worktree init errors after CLI detection succeeds", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-provision-fail-"));
    const baseRoot = path.join(tempRoot, "base");
    const worktreeRoot = path.join(tempRoot, "worktree");
    const fakeBin = path.join(tempRoot, "bin");
    const fakePnpmPath = path.join(fakeBin, "pnpm");
    const scriptPath = path.join(worktreeRoot, "provision-worktree.sh");

    try {
      await fs.mkdir(baseRoot, { recursive: true });
      await fs.mkdir(worktreeRoot, { recursive: true });
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.copyFile(provisionWorktreeScriptPath, scriptPath);
      await fs.chmod(scriptPath, 0o755);
      await fs.writeFile(
        fakePnpmPath,
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"paperclipai\" ] && [ \"$2\" = \"--help\" ]; then",
          "  exit 0",
          "fi",
          "if [ \"$1\" = \"paperclipai\" ] && [ \"$2\" = \"worktree\" ] && [ \"$3\" = \"init\" ]; then",
          "  echo \"simulated init failure\" >&2",
          "  exit 42",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.chmod(fakePnpmPath, 0o755);

      let caught: Error | null = null;
      try {
        await execFileAsync(scriptPath, [], {
          cwd: worktreeRoot,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            PAPERCLIP_WORKSPACE_BASE_CWD: baseRoot,
            PAPERCLIP_WORKSPACE_CWD: worktreeRoot,
          },
        });
      } catch (error) {
        caught = error as Error;
      }

      expect(caught).toBeTruthy();
      expect(String(caught)).toContain("simulated init failure");
      await expect(fs.stat(path.join(worktreeRoot, ".paperclip", "config.json"))).rejects.toThrow();
      await expect(fs.stat(path.join(worktreeRoot, ".paperclip", ".env"))).rejects.toThrow();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("regenerates stale worktree config that points at another host", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-stale-config-"));
    const baseRoot = path.join(tempRoot, "base");
    const worktreeRoot = path.join(tempRoot, "worktree");
    const fakeBin = path.join(tempRoot, "bin");
    const fakePnpmPath = path.join(fakeBin, "pnpm");
    const scriptPath = path.join(worktreeRoot, "provision-worktree.sh");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");

    try {
      await fs.mkdir(baseRoot, { recursive: true });
      await fs.mkdir(paperclipDir, { recursive: true });
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.copyFile(provisionWorktreeScriptPath, scriptPath);
      await fs.chmod(scriptPath, 0o755);
      await fs.writeFile(
        path.join(paperclipDir, "config.json"),
        JSON.stringify({
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: "/Users/example/.paperclip-worktrees/instances/stale/db",
          },
          logging: {
            mode: "file",
            logDir: "/Users/example/.paperclip-worktrees/instances/stale/logs",
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: "/Users/example/.paperclip-worktrees/instances/stale/data/storage",
            },
          },
          secrets: {
            provider: "local_encrypted",
            localEncrypted: {
              keyFilePath: "/Users/example/.paperclip-worktrees/instances/stale/secrets/master.key",
            },
          },
        }),
        "utf8",
      );
      await fs.writeFile(
        path.join(paperclipDir, ".env"),
        [
          "PAPERCLIP_HOME=/Users/example/.paperclip-worktrees",
          "PAPERCLIP_INSTANCE_ID=stale",
          `PAPERCLIP_CONFIG=/Users/example/paperclip/${path.basename(worktreeRoot)}/.paperclip/config.json`,
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        fakePnpmPath,
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"paperclipai\" ] && [ \"$2\" = \"--help\" ]; then",
          "  exit 0",
          "fi",
          "if [ \"$1\" = \"paperclipai\" ] && [ \"$2\" = \"worktree\" ] && [ \"$3\" = \"init\" ]; then",
          "  mkdir -p \"$PWD/.paperclip\"",
          "  printf '%s\\n' '{\"database\":{\"embeddedPostgresDataDir\":\"'$PWD'/.paperclip/runtime/db\"}}' > \"$PWD/.paperclip/config.json\"",
          "  printf '%s\\n' \"PAPERCLIP_HOME=$PWD/.paperclip/runtime\" \"PAPERCLIP_INSTANCE_ID=healthy\" \"PAPERCLIP_CONFIG=$PWD/.paperclip/config.json\" > \"$PWD/.paperclip/.env\"",
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.chmod(fakePnpmPath, 0o755);

      const result = await execFileAsync(scriptPath, [], {
        cwd: worktreeRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PAPERCLIP_WORKSPACE_BASE_CWD: baseRoot,
          PAPERCLIP_WORKSPACE_CWD: worktreeRoot,
        },
      });

      expect(result.stderr).toContain("Existing isolated Paperclip worktree config is stale for this host; regenerating.");
      await expect(fs.readFile(path.join(paperclipDir, ".env"), "utf8")).resolves.toContain(
        `PAPERCLIP_CONFIG=${worktreeRoot}/.paperclip/config.json`,
      );
      await expect(fs.readFile(path.join(paperclipDir, "config.json"), "utf8")).resolves.toContain(worktreeRoot);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("retries worktree-local pnpm install without a frozen lockfile when the lockfile is outdated", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-outdated-lockfile-"));
    const baseRoot = path.join(tempRoot, "base");
    const worktreeRoot = path.join(tempRoot, "worktree");
    const fakeBin = path.join(tempRoot, "bin");
    const fakePnpmPath = path.join(fakeBin, "pnpm");
    const scriptPath = path.join(worktreeRoot, "provision-worktree.sh");

    try {
      await fs.mkdir(path.join(baseRoot, "node_modules"), { recursive: true });
      await fs.mkdir(worktreeRoot, { recursive: true });
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.copyFile(provisionWorktreeScriptPath, scriptPath);
      await fs.chmod(scriptPath, 0o755);
      await fs.writeFile(
        path.join(worktreeRoot, "package.json"),
        JSON.stringify(
          {
            name: "workspace-root",
            private: true,
            packageManager: "pnpm@9.15.4",
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.writeFile(
        path.join(worktreeRoot, "pnpm-lock.yaml"),
        ["lockfileVersion: '9.0'", "", "importers:", "  .: {}", ""].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        fakePnpmPath,
        [
          "#!/bin/sh",
          "if [ \"$1\" = \"paperclipai\" ] && [ \"$2\" = \"--help\" ]; then",
          "  exit 1",
          "fi",
          "if [ \"$1\" = \"install\" ] && [ \"$2\" = \"--prod=false\" ] && [ \"$3\" = \"--frozen-lockfile\" ]; then",
          "  echo \"ERR_PNPM_OUTDATED_LOCKFILE\" >&2",
          "  exit 1",
          "fi",
          "if [ \"$1\" = \"install\" ] && [ \"$2\" = \"--prod=false\" ] && [ \"$3\" = \"--no-frozen-lockfile\" ]; then",
          "  mkdir -p \"$PWD/node_modules\"",
          "  : > \"$PWD/node_modules/.retry-success\"",
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      await fs.chmod(fakePnpmPath, 0o755);

      const result = await execFileAsync(scriptPath, [], {
        cwd: worktreeRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          PAPERCLIP_WORKSPACE_BASE_CWD: baseRoot,
          PAPERCLIP_WORKSPACE_CWD: worktreeRoot,
        },
      });

      expect(result.stderr).toContain("retrying install without --frozen-lockfile");
      await expect(fs.readFile(path.join(worktreeRoot, "node_modules", ".retry-success"), "utf8")).resolves.toBe("");
      await expect(fs.readFile(path.join(worktreeRoot, ".paperclip", "config.json"), "utf8")).resolves.toContain(
        "\"database\"",
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it(
    "provisions worktree-local pnpm node_modules instead of reusing base-repo links",
    async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "packages", "shared"), { recursive: true });
    await fs.mkdir(path.join(repoRoot, "server"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          name: "workspace-root",
          private: true,
          packageManager: "pnpm@9.15.4",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "pnpm-workspace.yaml"),
      ["packages:", "  - packages/*", "  - server", ""].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(repoRoot, "packages", "shared", "package.json"),
      JSON.stringify(
        {
          name: "@repo/shared",
          version: "1.0.0",
          private: true,
          type: "module",
          exports: "./index.js",
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(repoRoot, "packages", "shared", "index.js"), "export const value = 'shared';\n", "utf8");
    await fs.writeFile(
      path.join(repoRoot, "server", "package.json"),
      JSON.stringify(
        {
          name: "server",
          private: true,
          type: "module",
          dependencies: {
            "@repo/shared": "workspace:*",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(repoRoot, "server", "index.js"), "export {};\n", "utf8");
    await fs.copyFile(provisionWorktreeScriptPath, path.join(repoRoot, "scripts", "provision-worktree.sh"));
    await fs.chmod(path.join(repoRoot, "scripts", "provision-worktree.sh"), 0o755);
    await runPnpm(repoRoot, ["install"]);
    await runGit(repoRoot, ["add", "."]);
    await runGit(repoRoot, ["commit", "-m", "Add pnpm workspace fixture"]);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision-worktree.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-551",
        title: "Provision local workspace dependencies",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect((await fs.lstat(path.join(workspace.cwd, "node_modules"))).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(workspace.cwd, "server", "node_modules"))).isSymbolicLink()).toBe(false);
    await expect(fs.realpath(path.join(workspace.cwd, "server", "node_modules", "@repo", "shared"))).resolves.toBe(
      await fs.realpath(path.join(workspace.cwd, "packages", "shared")),
    );
    await expect(fs.realpath(path.join(repoRoot, "server", "node_modules", "@repo", "shared"))).resolves.toBe(
      await fs.realpath(path.join(repoRoot, "packages", "shared")),
    );
    },
    15_000,
  );

  it("records worktree setup and provision operations when a recorder is provided", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf 'provisioned\\n'",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add recorder provision script"]);

    await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-540",
        title: "Record workspace operations",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(operations.map((operation) => operation.phase)).toEqual([
      "worktree_prepare",
      "workspace_provision",
    ]);
    expect(operations[0]?.command).toContain("git worktree add");
    expect(operations[0]?.metadata).toMatchObject({
      branchName: "PAP-540-record-workspace-operations",
      created: true,
    });
    expect(operations[1]?.command).toBe("bash ./scripts/provision.sh");
  });

  it("truncates oversized provision command output before storing it in memory", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "noisy.js"),
      'process.stdout.write("x".repeat(400000));\n',
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/noisy.js"]);
    await runGit(repoRoot, ["commit", "-m", "Add noisy provision script"]);

    await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "node ./scripts/noisy.js",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-1142",
        title: "Limit noisy provision output",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    const provisionOperation = operations.find((operation) => operation.phase === "workspace_provision");
    expect(provisionOperation?.result.metadata).toMatchObject({
      stdoutTruncated: true,
      stderrTruncated: false,
    });
    expect(provisionOperation?.result.stdout).toContain("[output truncated to last");
    expect(provisionOperation?.result.stdout?.length ?? 0).toBeLessThan(300000);
  }, 10_000);

  it("reuses an existing branch without resetting it when recreating a missing worktree", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-450-recreate-missing-worktree";

    await runGit(repoRoot, ["checkout", "-b", branchName]);
    await fs.writeFile(path.join(repoRoot, "feature.txt"), "preserve me\n", "utf8");
    await runGit(repoRoot, ["add", "feature.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add preserved feature"]);
    const expectedHead = (await execFileAsync("git", ["rev-parse", branchName], { cwd: repoRoot })).stdout.trim();
    await runGit(repoRoot, ["checkout", "main"]);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-450",
        title: "Recreate missing worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(workspace.branchName).toBe(branchName);
    await expect(fs.readFile(path.join(workspace.cwd, "feature.txt"), "utf8")).resolves.toBe("preserve me\n");
    const actualHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace.cwd })).stdout.trim();
    expect(actualHead).toBe(expectedHead);
  });

  it("reattaches a missing persisted git worktree before manual control starts it", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-451-restore-persisted-worktree";
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "restore.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf '%s\\n' \"$PAPERCLIP_WORKSPACE_BRANCH\" > .paperclip-restored-branch",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(path.join(repoRoot, "scripts", "restore.sh"), 0o755);
    await runGit(repoRoot, ["add", "scripts/restore.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add restore script"]);

    await runGit(repoRoot, ["checkout", "-b", branchName]);
    await fs.writeFile(path.join(repoRoot, "feature.txt"), "persisted\n", "utf8");
    await runGit(repoRoot, ["add", "feature.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add persisted feature"]);
    const expectedHead = (await execFileAsync("git", ["rev-parse", branchName], { cwd: repoRoot })).stdout.trim();
    await runGit(repoRoot, ["checkout", "main"]);

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/restore.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-451",
        title: "Restore persisted worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await fs.rm(initial.cwd, { recursive: true, force: true });

    const restored = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: initial.cwd,
        providerRef: initial.worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName,
        config: {
          provisionCommand: "bash ./scripts/restore.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-451",
        title: "Restore persisted worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(restored).not.toBeNull();
    expect(restored?.cwd).toBe(initial.cwd);
    await expect(fs.readFile(path.join(initial.cwd, "feature.txt"), "utf8")).resolves.toBe("persisted\n");
    await expect(fs.readFile(path.join(initial.cwd, ".paperclip-restored-branch"), "utf8")).resolves.toBe(`${branchName}\n`);
    const actualHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: initial.cwd })).stdout.trim();
    expect(actualHead).toBe(expectedHead);
  }, 15_000);

  it("repairs a clean persisted git worktree branch mismatch when both branches point at the same commit", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-454-repair-clean-branch-mismatch";
    const actualBranch = "PAP-454-publish-head";
    const realWorktreeRoot = path.join(repoRoot, ".paperclip", "real-worktrees");
    const symlinkedWorktreeRoot = path.join(repoRoot, ".paperclip", "worktrees");
    const realWorktreePath = path.join(realWorktreeRoot, expectedBranch);
    const worktreePath = path.join(symlinkedWorktreeRoot, expectedBranch);
    await fs.mkdir(realWorktreeRoot, { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, realWorktreePath, "HEAD"]);
    await fs.symlink(realWorktreeRoot, symlinkedWorktreeRoot, "dir");
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const restored = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: "execution-workspace-1",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: worktreePath,
        providerRef: worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: expectedBranch,
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-454",
        title: "Repair clean branch mismatch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(restored?.cwd).toBe(worktreePath);
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "worktree_prepare",
          command: "git checkout PAP-454-repair-clean-branch-mismatch",
          metadata: expect.objectContaining({
            branchIncoherenceRepair: true,
            expectedBranchName: expectedBranch,
            actualBranchName: actualBranch,
            sourceIssueId: "issue-1",
            executionWorkspaceId: "execution-workspace-1",
            fingerprint: expect.stringMatching(/^workspace_incoherence:v1:sha256:/),
          }),
        }),
      ]),
    );
  }, 15_000);

  it("reattaches a clean forward detached HEAD to the recorded persisted git worktree branch", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-454-reattach-detached-head";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", branchName);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", branchName]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, branchName]);
    await runGit(worktreePath, ["checkout", "--detach"]);
    await fs.writeFile(path.join(worktreePath, "detached.txt"), "detached work\n", "utf8");
    await runGit(worktreePath, ["add", "detached.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Add detached work"]);
    const detachedHead = await readGit(worktreePath, ["rev-parse", "HEAD"]);

    const restored = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: "execution-workspace-detached",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: worktreePath,
        providerRef: worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName,
      },
      issue: {
        id: "issue-detached",
        identifier: "PAP-454",
        title: "Repair detached branch mismatch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(restored?.branchName).toBe(branchName);
    expect(restored?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("moved the recorded branch to that HEAD"),
    ]));
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(branchName);
    await expect(readGit(worktreePath, ["rev-parse", "HEAD"])).resolves.toBe(detachedHead);
  }, 15_000);

  it("rejects dirty persisted git worktree branch incoherence with bounded recovery evidence", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-455-reject-dirty-branch-mismatch";
    const actualBranch = "PAP-455-publish-head";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, "HEAD"]);
    await fs.writeFile(path.join(worktreePath, "untracked.txt"), "not safe to switch\n", "utf8");

    await expect(ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: "execution-workspace-2",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: worktreePath,
        providerRef: worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: expectedBranch,
      },
      issue: {
        id: "issue-2",
        identifier: "PAP-455",
        title: "Reject dirty branch mismatch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          fingerprint: expect.stringMatching(/^workspace_incoherence:v1:sha256:/),
          sourceIssueId: "issue-2",
          sourceIdentifier: "PAP-455",
          executionWorkspaceId: "execution-workspace-2",
          expectedBranch,
          actualBranch,
          cleanliness: "dirty",
          provenance: expect.objectContaining({
            expectedBranchExists: true,
            actualBranchExists: true,
            sameHead: true,
            ancestryVerdict: "ancestor",
            plainLanguageReason: expect.stringContaining("same commit"),
          }),
          safeRepair: expect.objectContaining({
            eligible: false,
            attempted: false,
            succeeded: false,
            reason: "worktree is not clean",
          }),
        }),
      },
    });
  }, 15_000);

  it("routes non-reusable persisted git worktrees through workspace validation recovery", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-455-not-registered-worktree";
    const detachedWorktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);
    await fs.mkdir(path.dirname(detachedWorktreePath), { recursive: true });
    await execFileAsync("git", ["clone", repoRoot, detachedWorktreePath]);
    await runGit(detachedWorktreePath, ["checkout", "-B", expectedBranch]);

    await expect(ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: "execution-workspace-not-registered",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: detachedWorktreePath,
        providerRef: detachedWorktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: expectedBranch,
      },
      issue: {
        id: "issue-not-registered",
        identifier: "PAP-455",
        title: "Reject unregistered persisted worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: {
          reason: "git_worktree_not_reusable",
          reasonCode: "not_registered",
          worktreePath: detachedWorktreePath,
          executionWorkspaceId: "execution-workspace-not-registered",
        },
      },
    });
  }, 15_000);

  it("adopts an existing persisted git worktree when the checked-out branch is forward of the recorded branch", async () => {
    const repoRoot = await createTempRepo();

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-456",
        title: "Keep persisted branch coherent",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    const actualBranch = "PAP-456-push-pr-head";
    await runGit(initial.cwd, ["checkout", "-b", actualBranch]);
    await fs.writeFile(path.join(initial.cwd, "publish.txt"), "publish\n", "utf8");
    await runGit(initial.cwd, ["add", "publish.txt"]);
    await runGit(initial.cwd, ["commit", "-m", "Add publish branch work"]);

    if (!initial.branchName) throw new Error("expected realized worktree branch name");
    const restored = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: "execution-workspace-3",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: initial.cwd,
        providerRef: initial.worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: initial.branchName,
      },
      issue: {
        id: "issue-3",
        identifier: "PAP-456",
        title: "Keep persisted branch coherent",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(restored?.branchName).toBe(actualBranch);
    expect(restored?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("adopted it for subsequent runs"),
    ]));
    await expect(readGit(initial.cwd, ["branch", "--show-current"])).resolves.toBe(actualBranch);
  }, 15_000);

  it("classifies persisted git worktree branch incoherence as diverged when the checked-out branch is not forward", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-457-recorded-work";
    const actualBranch = "PAP-457-sibling-work";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, "HEAD"]);

    await runGit(repoRoot, ["checkout", expectedBranch]);
    await fs.writeFile(path.join(repoRoot, "recorded.txt"), "recorded branch work\n", "utf8");
    await runGit(repoRoot, ["add", "recorded.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add recorded branch work"]);

    await fs.writeFile(path.join(worktreePath, "actual.txt"), "actual branch work\n", "utf8");
    await runGit(worktreePath, ["add", "actual.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Add actual branch work"]);

    let error: unknown = null;
    try {
      await ensurePersistedExecutionWorkspaceAvailable({
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        workspace: {
          id: "execution-workspace-diverged",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: worktreePath,
          providerRef: worktreePath,
          projectId: "project-1",
          projectWorkspaceId: "workspace-1",
          repoUrl: null,
          baseRef: "HEAD",
          branchName: expectedBranch,
        },
        issue: {
          id: "issue-diverged",
          identifier: "PAP-457",
          title: "Classify diverged branch incoherence",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
        enableWorkspaceBranchReconcileForward: true,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          sourceIssueId: "issue-diverged",
          sourceIdentifier: "PAP-457",
          executionWorkspaceId: "execution-workspace-diverged",
          expectedBranch,
          actualBranch,
          cleanliness: "clean",
          provenance: expect.objectContaining({
            expectedBranchExists: true,
            actualBranchExists: true,
            sameHead: false,
            ancestryVerdict: "diverged",
            plainLanguageReason: expect.stringContaining("cannot prove a forward-only reconciliation"),
          }),
        }),
      },
    });
  }, 15_000);

  it("classifies persisted git worktree branch incoherence as unknown when the recorded branch was deleted", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-458-deleted-recorded-branch";
    const actualBranch = "PAP-458-actual-work";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, "HEAD"]);
    await runGit(repoRoot, ["branch", "-D", expectedBranch]);

    let error: unknown = null;
    try {
      await ensurePersistedExecutionWorkspaceAvailable({
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        workspace: {
          id: "execution-workspace-deleted-branch",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: worktreePath,
          providerRef: worktreePath,
          projectId: "project-1",
          projectWorkspaceId: "workspace-1",
          repoUrl: null,
          baseRef: "HEAD",
          branchName: expectedBranch,
        },
        issue: {
          id: "issue-deleted-branch",
          identifier: "PAP-458",
          title: "Classify deleted branch ancestry",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
        enableWorkspaceBranchReconcileForward: true,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          sourceIssueId: "issue-deleted-branch",
          sourceIdentifier: "PAP-458",
          executionWorkspaceId: "execution-workspace-deleted-branch",
          expectedBranch,
          actualBranch,
          cleanliness: "clean",
          provenance: expect.objectContaining({
            expectedBranchExists: false,
            actualBranchExists: true,
            expectedHeadSha: null,
            sameHead: false,
            ancestryVerdict: "unknown",
            plainLanguageReason: expect.stringContaining("missing a resolvable HEAD commit"),
          }),
          safeRepair: expect.objectContaining({
            eligible: false,
            attempted: false,
            succeeded: false,
            reason: "expected branch does not exist",
          }),
        }),
      },
    });
  }, 15_000);

  it("keeps forward reconciliation fail-closed for same-content rewritten history", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-459-recorded-content";
    const actualBranch = "PAP-459-rewritten-content";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);

    await runGit(repoRoot, ["checkout", "-b", expectedBranch]);
    await fs.writeFile(path.join(repoRoot, "same-content.txt"), "same content\n", "utf8");
    await runGit(repoRoot, ["add", "same-content.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add content on recorded branch"]);
    await runGit(repoRoot, ["checkout", "main"]);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, "main"]);
    await fs.writeFile(path.join(worktreePath, "same-content.txt"), "same content\n", "utf8");
    await runGit(worktreePath, ["add", "same-content.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Add content on rewritten branch"]);

    await expectPersistedBranchMismatchRejected({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      issueId: "issue-rewritten-history",
      executionWorkspaceId: "execution-workspace-rewritten-history",
      expectedAncestryVerdict: "diverged",
      expectedReason: "expected branch and current HEAD differ",
    });
  }, 15_000);

  it("keeps forward reconciliation fail-closed for an unrelated task branch", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-459-recorded-task";
    const actualBranch = "PAP-999-unrelated-task";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);

    await runGit(repoRoot, ["checkout", "-b", expectedBranch]);
    await fs.writeFile(path.join(repoRoot, "recorded-task.txt"), "recorded task work\n", "utf8");
    await runGit(repoRoot, ["add", "recorded-task.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add recorded task work"]);
    await runGit(repoRoot, ["checkout", "main"]);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, "main"]);
    await fs.writeFile(path.join(worktreePath, "unrelated-task.txt"), "unrelated task work\n", "utf8");
    await runGit(worktreePath, ["add", "unrelated-task.txt"]);
    await runGit(worktreePath, ["commit", "-m", "Add unrelated task work"]);

    await expectPersistedBranchMismatchRejected({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      issueId: "issue-unrelated-task",
      executionWorkspaceId: "execution-workspace-unrelated-task",
      expectedAncestryVerdict: "diverged",
      expectedReason: "expected branch and current HEAD differ",
    });
  }, 15_000);

  it("keeps forward reconciliation fail-closed when the live branch is behind the recorded branch", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-459-recorded-ahead";
    const actualBranch = "PAP-459-live-behind";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, expectedBranch]);

    await runGit(repoRoot, ["checkout", expectedBranch]);
    await fs.writeFile(path.join(repoRoot, "recorded-ahead.txt"), "recorded branch moved ahead\n", "utf8");
    await runGit(repoRoot, ["add", "recorded-ahead.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Move recorded branch ahead"]);

    await expectPersistedBranchMismatchRejected({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      issueId: "issue-live-behind",
      executionWorkspaceId: "execution-workspace-live-behind",
      expectedAncestryVerdict: "diverged",
      expectedReason: "expected branch and current HEAD differ",
    });
  }, 15_000);

  it("does not reuse a missing persisted local filesystem workspace", async () => {
    const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-base-"));
    const missingCwd = path.join(baseCwd, "missing-workspace");

    const restored = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      },
      workspace: {
        mode: "shared_workspace",
        strategyType: "project_primary",
        cwd: missingCwd,
        providerRef: null,
        projectId: "project-1",
        projectWorkspaceId: null,
        repoUrl: null,
        baseRef: null,
        branchName: null,
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-453",
        title: "Missing local workspace",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(restored).toBeNull();
  });

  it("reprovisions an existing persisted git worktree before manual control starts it", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "restore.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf 'reprovisioned\\n' > .paperclip-restored-state",
      ].join("\n"),
      "utf8",
    );
    await fs.chmod(path.join(repoRoot, "scripts", "restore.sh"), 0o755);
    await runGit(repoRoot, ["add", "scripts/restore.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add reprovision script"]);

    const initial = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/restore.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-452",
        title: "Reprovision persisted worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await fs.rm(path.join(initial.cwd, ".paperclip-restored-state"), { force: true });

    await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: initial.cwd,
        providerRef: initial.worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName: initial.branchName,
        config: {
          provisionCommand: "bash ./scripts/restore.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-452",
        title: "Reprovision persisted worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(initial.cwd, ".paperclip-restored-state"), "utf8")).resolves.toBe("reprovisioned\n");
  }, 15_000);

  it("auto-detects the default branch when baseRef is not configured", async () => {
    // Create a repo with "master" as default branch (not "main")
    const repoRoot = await createTempRepo("master");

    // Set up a bare remote and push master so refs/remotes/origin/master
    // exists locally. Note: refs/remotes/origin/HEAD is NOT set by a manual
    // fetch — that requires git clone or git remote set-head. This test
    // exercises the heuristic fallback path in detectDefaultBranch.
    const bareRemote = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-bare-"));
    await runGit(bareRemote, ["init", "--bare"]);
    await runGit(repoRoot, ["remote", "add", "origin", bareRemote]);
    await runGit(repoRoot, ["push", "-u", "origin", "master"]);
    await runGit(repoRoot, ["fetch", "origin"]);

    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: null,
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          // No baseRef configured — should default to origin/master.
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-460",
        title: "Auto detect default branch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(workspace.strategy).toBe("git_worktree");
    expect(workspace.created).toBe(true);
    // The worktree should have been created successfully from the canonical remote base.
    const worktreeOp = operations.find(op => op.phase === "worktree_prepare" && op.metadata?.created);
    expect(worktreeOp).toBeDefined();
    expect(worktreeOp!.metadata!.baseRef).toBe("origin/master");
  }, 10_000);

  it("auto-detects the default branch via symbolic-ref when origin/HEAD is set", async () => {
    const repoRoot = await createTempRepo("main");
    await runGit(repoRoot, ["branch", "-f", "master", "main"]);

    const bareRemote = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-bare-symref-"));
    await runGit(bareRemote, ["init", "--bare"]);
    await runGit(repoRoot, ["remote", "add", "origin", bareRemote]);
    await runGit(repoRoot, ["branch", "-f", "master"]);
    await runGit(repoRoot, ["push", "-u", "origin", "main", "master"]);
    await runGit(repoRoot, ["fetch", "origin"]);
    // Explicitly set refs/remotes/origin/HEAD to exercise the symbolic-ref path
    // (git remote set-head -a requires the remote to advertise HEAD, so we set it manually)
    await runGit(repoRoot, ["remote", "set-head", "origin", "main"]);

    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: null,
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          // No baseRef configured — origin/master is preferred over the symbolic-ref.
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-461",
        title: "Auto detect default branch via symref",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(workspace.strategy).toBe("git_worktree");
    expect(workspace.created).toBe(true);
    const worktreeOp = operations.find(op => op.phase === "worktree_prepare" && op.metadata?.created);
    expect(worktreeOp).toBeDefined();
    expect(worktreeOp!.metadata!.baseRef).toBe("origin/master");
  }, 10_000);

  it("removes a created git worktree and branch during cleanup", async () => {
    const repoRoot = await createTempRepo();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-449",
        title: "Cleanup workspace",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: null,
      },
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toEqual([]);
    await expect(fs.stat(workspace.cwd)).rejects.toThrow();
    await expect(
      execFileAsync("git", ["branch", "--list", workspace.branchName!], { cwd: repoRoot }),
    ).resolves.toMatchObject({
      stdout: "",
    });
  });

  it("keeps an unmerged runtime-created branch and warns instead of force deleting it", async () => {
    const repoRoot = await createTempRepo();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-451",
        title: "Keep unmerged branch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await fs.writeFile(path.join(workspace.cwd, "unmerged.txt"), "still here\n", "utf8");
    await runGit(workspace.cwd, ["add", "unmerged.txt"]);
    await runGit(workspace.cwd, ["commit", "-m", "Keep unmerged work"]);

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: null,
      },
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toHaveLength(1);
    expect(cleanup.warnings[0]).toContain(`Skipped deleting branch "${workspace.branchName}"`);
    await expect(
      execFileAsync("git", ["branch", "--list", workspace.branchName!], { cwd: repoRoot }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining(workspace.branchName!),
    });
  }, 10_000);

  it("records teardown and cleanup operations when a recorder is provided", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-541",
        title: "Cleanup recorder",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: "printf 'cleanup ok\\n'",
      },
      recorder,
    });

    expect(operations.map((operation) => operation.phase)).toEqual([
      "workspace_teardown",
      "worktree_cleanup",
      "worktree_cleanup",
    ]);
    expect(operations[0]?.command).toBe("printf 'cleanup ok\\n'");
    expect(operations[1]?.metadata).toMatchObject({
      cleanupAction: "worktree_remove",
    });
    expect(operations[2]?.metadata).toMatchObject({
      cleanupAction: "branch_delete",
    });
  });
});

describe("ensureRuntimeServicesForRun", () => {
  it("leaves manual runtime services untouched during agent runs", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-manual-"));
    const workspace = buildWorkspace(workspaceRoot);

    const services = await ensureRuntimeServicesForRun({
      runId: "run-manual",
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config: {
        desiredState: "manual",
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command: "node -e \"throw new Error('should not start')\"",
              port: { type: "auto" },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    expect(services).toEqual([]);
  });

  it("reuses shared runtime services across runs and starts a new service after release", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-workspace-"));
    const workspace = buildWorkspace(workspaceRoot);
    const serviceCommand =
      "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"";

    const config = {
      workspaceRuntime: {
        services: [
          {
            name: "web",
            command: serviceCommand,
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            expose: {
              type: "url",
              urlTemplate: "http://127.0.0.1:{{port}}",
            },
            lifecycle: "shared",
            reuseScope: "project_workspace",
            stopPolicy: {
              type: "on_run_finish",
            },
          },
        ],
      },
    };

    const run1 = "run-1";
    const run2 = "run-2";
    leasedRunIds.add(run1);
    leasedRunIds.add(run2);

    const first = await ensureRuntimeServicesForRun({
      runId: run1,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(first).toHaveLength(1);
    expect(first[0]?.reused).toBe(false);
    expect(first[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(first[0]!.url!);
    expect(await response.text()).toBe("ok");

    const second = await ensureRuntimeServicesForRun({
      runId: run2,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(second).toHaveLength(1);
    expect(second[0]?.reused).toBe(true);
    expect(second[0]?.id).toBe(first[0]?.id);

    await releaseRuntimeServicesForRun(run1);
    leasedRunIds.delete(run1);
    await releaseRuntimeServicesForRun(run2);
    leasedRunIds.delete(run2);

    const run3 = "run-3";
    leasedRunIds.add(run3);
    const third = await ensureRuntimeServicesForRun({
      runId: run3,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(third).toHaveLength(1);
    expect(third[0]?.reused).toBe(false);
    expect(third[0]?.id).not.toBe(first[0]?.id);
  }, 10_000);

  it("does not reuse project-scoped shared services across different workspace launch contexts", async () => {
    const primaryWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-primary-"));
    const worktreeWorkspaceRoot = path.join(primaryWorkspaceRoot, ".paperclip", "worktrees", "PAP-874-chat-speed-issues");
    await fs.mkdir(worktreeWorkspaceRoot, { recursive: true });

    const primaryWorkspace = buildWorkspace(primaryWorkspaceRoot);
    const executionWorkspace: RealizedExecutionWorkspace = {
      ...buildWorkspace(worktreeWorkspaceRoot),
      source: "task_session",
      strategy: "git_worktree",
      cwd: worktreeWorkspaceRoot,
      branchName: "PAP-874-chat-speed-issues",
      worktreePath: worktreeWorkspaceRoot,
    };
    const serviceCommand =
      "node -e \"require('node:http').createServer((req,res)=>res.end(process.env.PAPERCLIP_HOME)).listen(Number(process.env.PORT), '127.0.0.1')\"";
    const config = {
      workspaceRuntime: {
        services: [
          {
            name: "paperclip-dev",
            command: serviceCommand,
            cwd: ".",
            env: {
              PAPERCLIP_HOME: "{{workspace.cwd}}/.paperclip/runtime-services",
            },
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            expose: {
              type: "url",
              urlTemplate: "http://127.0.0.1:{{port}}",
            },
            lifecycle: "shared",
            reuseScope: "project_workspace",
            stopPolicy: {
              type: "on_run_finish",
            },
          },
        ],
      },
    };

    const primaryRunId = "run-project-workspace";
    const executionRunId = "run-execution-workspace";
    leasedRunIds.add(primaryRunId);
    leasedRunIds.add(executionRunId);

    const primaryServices = await ensureRuntimeServicesForRun({
      runId: primaryRunId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace: primaryWorkspace,
      config,
      adapterEnv: {},
    });

    const executionServices = await ensureRuntimeServicesForRun({
      runId: executionRunId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace: executionWorkspace,
      executionWorkspaceId: "execution-workspace-1",
      config,
      adapterEnv: {},
    });

    expect(primaryServices).toHaveLength(1);
    expect(executionServices).toHaveLength(1);
    expect(primaryServices[0]?.reused).toBe(false);
    expect(executionServices[0]?.reused).toBe(false);
    expect(executionServices[0]?.id).not.toBe(primaryServices[0]?.id);
    expect(executionServices[0]?.executionWorkspaceId).toBe("execution-workspace-1");
    expect(executionServices[0]?.cwd).toBe(worktreeWorkspaceRoot);
    expect(executionServices[0]?.url).not.toBe(primaryServices[0]?.url);

    const primaryResponse = await fetch(primaryServices[0]!.url!);
    expect(await primaryResponse.text()).toBe(path.join(primaryWorkspaceRoot, ".paperclip", "runtime-services"));

    const executionResponse = await fetch(executionServices[0]!.url!);
    expect(await executionResponse.text()).toBe(path.join(worktreeWorkspaceRoot, ".paperclip", "runtime-services"));
  });

  it("does not leak parent Paperclip instance env into runtime service commands", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-env-"));
    const workspace = buildWorkspace(workspaceRoot);
    const envCapturePath = path.join(workspaceRoot, "captured-env.json");
    const serviceCommand = [
      "node -e",
      JSON.stringify(
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(envCapturePath)}, JSON.stringify({`,
          "paperclipConfig: process.env.PAPERCLIP_CONFIG ?? null,",
          "paperclipHome: process.env.PAPERCLIP_HOME ?? null,",
          "paperclipInstanceId: process.env.PAPERCLIP_INSTANCE_ID ?? null,",
          "databaseUrl: process.env.DATABASE_URL ?? null,",
          "customEnv: process.env.RUNTIME_CUSTOM_ENV ?? null,",
          "port: process.env.PORT ?? null,",
          "}));",
          "require('node:http').createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
        ].join(" "),
      ),
    ].join(" ");

    process.env.PAPERCLIP_CONFIG = "/tmp/base-paperclip-config.json";
    process.env.PAPERCLIP_HOME = "/tmp/base-paperclip-home";
    process.env.PAPERCLIP_INSTANCE_ID = "base-instance";
    process.env.DATABASE_URL = "postgres://shared-db.example.com/paperclip";

    const runId = "run-env";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command: serviceCommand,
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "on_run_finish",
              },
            },
          ],
        },
      },
      adapterEnv: {
        RUNTIME_CUSTOM_ENV: "from-adapter",
      },
    });

    expect(services).toHaveLength(1);
    const captured = JSON.parse(await fs.readFile(envCapturePath, "utf8")) as Record<string, string | null>;
    expect(captured.paperclipConfig).toBeNull();
    expect(captured.paperclipHome).toBeNull();
    expect(captured.paperclipInstanceId).toBeNull();
    expect(captured.databaseUrl).toBeNull();
    expect(captured.customEnv).toBe("from-adapter");
    expect(captured.port).toMatch(/^\d+$/);
    expect(services[0]?.executionWorkspaceId).toBe("execution-workspace-1");
    expect(services[0]?.scopeType).toBe("execution_workspace");
    expect(services[0]?.scopeId).toBe("execution-workspace-1");
  });

  it("stops execution workspace runtime services by executionWorkspaceId", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-stop-"));
    const workspace = buildWorkspace(workspaceRoot);
    const runId = "run-stop";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-stop",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    expect(services[0]?.url).toBeTruthy();
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-stop",
      workspaceCwd: workspace.cwd,
    });
    await releaseRuntimeServicesForRun(runId);
    leasedRunIds.delete(runId);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await expect(fetch(services[0]!.url!)).rejects.toThrow();
  });

  it("does not stop services in sibling directories when matching by workspace cwd", async () => {
    const workspaceParent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-sibling-"));
    const targetWorkspaceRoot = path.join(workspaceParent, "project");
    const siblingWorkspaceRoot = path.join(workspaceParent, "project-extended", "service");
    await fs.mkdir(targetWorkspaceRoot, { recursive: true });
    await fs.mkdir(siblingWorkspaceRoot, { recursive: true });

    const siblingWorkspace = buildWorkspace(siblingWorkspaceRoot);
    const runId = "run-sibling";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace: siblingWorkspace,
      executionWorkspaceId: "execution-workspace-sibling",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-target",
      workspaceCwd: targetWorkspaceRoot,
    });

    const response = await fetch(services[0]!.url!);
    expect(await response.text()).toBe("ok");

    await releaseRuntimeServicesForRun(runId);
    leasedRunIds.delete(runId);
  });

  it("starts only the selected workspace-controlled runtime service", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-control-start-"));
    const workspace = buildWorkspace(workspaceRoot);

    const services = await startRuntimeServicesForWorkspaceControl({
      actor: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-control-start",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('web')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
            },
            {
              name: "worker",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('worker')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
            },
          ],
        },
      },
      adapterEnv: {},
      serviceIndex: 1,
    });

    expect(services).toHaveLength(1);
    expect(services[0]?.serviceName).toBe("worker");
    await expect(fetch(services[0]!.url!)).resolves.toMatchObject({ ok: true });

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-control-start",
      workspaceCwd: workspace.cwd,
    });
  });

  it("stops only the selected execution workspace runtime service", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-control-stop-"));
    const workspace = buildWorkspace(workspaceRoot);

    const services = await startRuntimeServicesForWorkspaceControl({
      actor: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-control-stop",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('web')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
            {
              name: "worker",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('worker')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    expect(services).toHaveLength(2);
    const web = services.find((service) => service.serviceName === "web");
    const worker = services.find((service) => service.serviceName === "worker");

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-control-stop",
      workspaceCwd: workspace.cwd,
      runtimeServiceId: web?.id ?? null,
    });

    await expect(fetch(web!.url!)).rejects.toThrow();
    await expect(fetch(worker!.url!)).resolves.toMatchObject({ ok: true });

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-control-stop",
      workspaceCwd: workspace.cwd,
      runtimeServiceId: worker?.id ?? null,
    });
  }, 10_000);
});

describe("buildWorkspaceRuntimeDesiredStatePatch", () => {
  it("derives service entries from command-first runtime config", () => {
    const services = listConfiguredRuntimeServiceEntries({
      workspaceRuntime: {
        commands: [
          { id: "web", name: "web", kind: "service", command: "pnpm dev" },
          { id: "db-migrate", name: "db:migrate", kind: "job", command: "pnpm db:migrate" },
        ],
      },
    });

    expect(services).toEqual([
      expect.objectContaining({
        id: "web",
        kind: "service",
        command: "pnpm dev",
      }),
    ]);
  });

  it("preserves sibling service state when updating a single configured runtime service", () => {
    const patch = buildWorkspaceRuntimeDesiredStatePatch({
      config: {
        workspaceRuntime: {
          services: [
            { name: "web", command: "pnpm dev" },
            { name: "worker", command: "pnpm worker" },
          ],
        },
      },
      currentDesiredState: "running",
      currentServiceStates: null,
      action: "stop",
      serviceIndex: 1,
    });

    expect(patch).toEqual({
      desiredState: "running",
      serviceStates: {
        "0": "running",
        "1": "stopped",
      },
    });
  });

  it("preserves manual service state when manually starting or stopping services", () => {
    const baseInput = {
      config: {
        workspaceRuntime: {
          services: [
            { name: "web", command: "pnpm dev" },
          ],
        },
      },
      currentDesiredState: "manual" as const,
      currentServiceStates: null,
      serviceIndex: 0,
    };

    expect(buildWorkspaceRuntimeDesiredStatePatch({
      ...baseInput,
      action: "start",
    })).toEqual({
      desiredState: "manual",
      serviceStates: {
        "0": "manual",
      },
    });

    expect(buildWorkspaceRuntimeDesiredStatePatch({
      ...baseInput,
      action: "stop",
    })).toEqual({
      desiredState: "manual",
      serviceStates: {
        "0": "manual",
      },
    });
  });
});

describe("resolveWorkspaceRuntimeReadinessTimeoutSec", () => {
  it("extends the default readiness timeout for dev-server commands", () => {
    expect(
      resolveWorkspaceRuntimeReadinessTimeoutSec({
        command: "pnpm dev",
        readiness: {
          type: "http",
          urlTemplate: "http://127.0.0.1:{{port}}",
        },
      }),
    ).toBe(90);
    expect(
      resolveWorkspaceRuntimeReadinessTimeoutSec({
        command: "npm run dev -- --host 127.0.0.1",
        readiness: {
          type: "http",
          urlTemplate: "http://127.0.0.1:{{port}}",
        },
      }),
    ).toBe(90);
  });

  it("keeps explicit readiness timeouts and non-dev defaults unchanged", () => {
    expect(
      resolveWorkspaceRuntimeReadinessTimeoutSec({
        command: "pnpm dev",
        readiness: {
          type: "http",
          timeoutSec: 12,
          urlTemplate: "http://127.0.0.1:{{port}}",
        },
      }),
    ).toBe(12);
    expect(
      resolveWorkspaceRuntimeReadinessTimeoutSec({
        command: "node server.js",
        readiness: {
          type: "http",
          urlTemplate: "http://127.0.0.1:{{port}}",
        },
      }),
    ).toBe(30);
  });
});

describe("resolveShell (shell fallback)", () => {
  const originalShell = process.env.SHELL;
  const originalPlatform = process.platform;

  afterEach(() => {
    if (originalShell !== undefined) {
      process.env.SHELL = originalShell;
    } else {
      delete process.env.SHELL;
    }
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("returns process.env.SHELL when set", () => {
    process.env.SHELL = process.execPath;
    expect(resolveShell()).toBe(process.execPath);
  });

  it("trims whitespace from SHELL env var", () => {
    process.env.SHELL = `  ${process.execPath}  `;
    expect(resolveShell()).toBe(process.execPath);
  });

  it("preserves non-absolute shell names so PATH lookup still works", () => {
    process.env.SHELL = "zsh";
    expect(resolveShell()).toBe("zsh");
  });

  it("falls back to /bin/sh on non-Windows when SHELL is unset", () => {
    delete process.env.SHELL;
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(resolveShell()).toBe("/bin/sh");
  });

  it("falls back to sh (bare) on Windows when SHELL is unset", () => {
    delete process.env.SHELL;
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(resolveShell()).toBe("sh");
  });

  it("falls back to /bin/sh on darwin when SHELL is unset", () => {
    delete process.env.SHELL;
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(resolveShell()).toBe("/bin/sh");
  });

  it("treats empty SHELL as unset and uses platform fallback", () => {
    process.env.SHELL = "";
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(resolveShell()).toBe("/bin/sh");
  });

  it("treats whitespace-only SHELL as unset and uses platform fallback", () => {
    process.env.SHELL = "   ";
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(resolveShell()).toBe("sh");
  });

  it("falls back when SHELL points to a missing absolute path", () => {
    process.env.SHELL = "/definitely/missing/zsh";
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(resolveShell()).toBe("/bin/sh");
  });
});

describe("readLocalServicePortOwner", () => {
  it("detects the owner of a listening TCP port", async () => {
    try {
      await execFileAsync("lsof", ["-v"]);
    } catch {
      return;
    }

    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      expect(port).toBeTypeOf("number");

      const owner = await readLocalServicePortOwner(port!);
      expect(owner).toBe(process.pid);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });
});

describeEmbeddedPostgres("workspace runtime startup reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-runtime-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(workspaceRuntimeServices);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  it("adopts a live auto-port shared service after runtime state is reset", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-reconcile-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `runtime-reconcile-${randomUUID()}`;

    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
      updatedAt: new Date(),
    });

    const workspace = {
      ...buildWorkspace(workspaceRoot),
      projectId: null,
      workspaceId: null,
    };
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      db,
      runId,
      agent: {
        id: agentId,
        name: "Codex Coder",
        companyId,
      },
      issue: null,
      workspace,
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "agent",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    expect(services).toHaveLength(1);
    const service = services[0];
    expect(service?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await expect(fetch(service!.url!)).resolves.toMatchObject({ ok: true });

    await fs.rm(paperclipHome, { recursive: true, force: true });
    await resetRuntimeServicesForTests();

    const result = await reconcilePersistedRuntimeServicesOnStartup(db);
    expect(result).toMatchObject({ reconciled: 1, adopted: 1, stopped: 0 });

    const persisted = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(eq(workspaceRuntimeServices.id, service!.id))
      .then((rows) => rows[0] ?? null);
    expect(persisted?.status).toBe("running");
    expect(persisted?.providerRef).toMatch(/^\d+$/);

    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId,
      workspaceCwd: workspace.cwd,
    });

    await expect(fetch(service!.url!)).rejects.toThrow();
  });

  it("does not reuse a stopped auto-port service port while another process owns it", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-unhealthy-adopt-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `runtime-unhealthy-adopt-${randomUUID()}`;

    const portProbe = net.createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const address = portProbe.address();
    const stalePort = typeof address === "object" && address ? address.port : null;
    await new Promise<void>((resolve, reject) => {
      portProbe.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    expect(stalePort).toBeTypeOf("number");

    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const runId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const stoppedServiceId = randomUUID();
    const serviceCommand =
      "node -e \"const http=require('node:http'); const stale=process.env.STALE_HEALTH==='1'; http.createServer((req,res)=>{ if (req.url==='/api/health' && stale) { res.statusCode=503; res.end('database_unreachable'); return; } res.end('ok'); }).listen(Number(process.env.PORT), '127.0.0.1')\"";
    const scopeType = "agent";
    const scopeId = agentId;
    const reuseKey = createHash("sha256")
      .update(
        stableStringifyForTest({
          scopeType,
          scopeId,
          serviceName: "paperclip-dev",
          command: serviceCommand,
          cwd: workspaceRoot,
          port: null,
          env: {},
        }),
      )
      .digest("hex");

    const staleProcess = spawn(resolveShell(), ["-lc", serviceCommand], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PORT: String(stalePort),
        STALE_HEALTH: "1",
      },
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    staleProcess.unref();

    try {
      const rootUrl = `http://127.0.0.1:${stalePort}`;
      const healthUrl = `${rootUrl}/api/health`;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          const response = await fetch(rootUrl);
          if (response.ok) break;
        } catch {
          // Keep polling until the stale process has bound its port.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await expect(fetch(rootUrl)).resolves.toMatchObject({ ok: true });
      await expect(fetch(healthUrl)).resolves.toMatchObject({ ok: false, status: 503 });

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "running",
        startedAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Runtime unhealthy adoption test",
        status: "in_progress",
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: null,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Runtime unhealthy adoption",
        status: "active",
        cwd: workspaceRoot,
        providerType: "git_worktree",
        providerRef: workspaceRoot,
      });
      await db.insert(workspaceRuntimeServices).values({
        id: stoppedServiceId,
        companyId,
        projectId,
        projectWorkspaceId: null,
        executionWorkspaceId,
        issueId: null,
        scopeType,
        scopeId,
        serviceName: "paperclip-dev",
        status: "stopped",
        lifecycle: "shared",
        reuseKey,
        command: serviceCommand,
        cwd: workspaceRoot,
        port: stalePort,
        url: rootUrl,
        provider: "local_process",
        providerRef: String(staleProcess.pid ?? ""),
        ownerAgentId: null,
        startedByRunId: null,
        lastUsedAt: new Date(),
        startedAt: new Date(),
        stoppedAt: new Date(),
        stopPolicy: { type: "manual" },
        healthStatus: "unknown",
      });

      leasedRunIds.add(runId);
      const services = await ensureRuntimeServicesForRun({
        db,
        runId,
        agent: {
          id: agentId,
          name: "Codex Coder",
          companyId,
        },
        issue: null,
        workspace: {
          ...buildWorkspace(workspaceRoot),
          projectId,
          workspaceId: null,
        },
        executionWorkspaceId,
        config: {
          workspaceRuntime: {
            services: [
              {
                name: "paperclip-dev",
                command: serviceCommand,
                cwd: ".",
                port: { type: "auto" },
                readiness: {
                  type: "http",
                  urlTemplate: "http://127.0.0.1:{{port}}",
                  timeoutSec: 10,
                  intervalMs: 100,
                },
                expose: {
                  type: "url",
                  urlTemplate: "http://127.0.0.1:{{port}}",
                },
                lifecycle: "shared",
                reuseScope: "agent",
                stopPolicy: {
                  type: "manual",
                },
              },
            ],
          },
        },
        adapterEnv: {},
      });

      expect(services).toHaveLength(1);
      expect(services[0]?.reused).toBe(false);
      expect(services[0]?.id).toBe(stoppedServiceId);
      expect(services[0]?.port).not.toBe(stalePort);
      expect(services[0]?.url).not.toBe(rootUrl);
      await expect(fetch(services[0]!.url!)).resolves.toMatchObject({ ok: true });
      await expect(fetch(healthUrl)).resolves.toMatchObject({ ok: false, status: 503 });
      expect(await readLocalServicePortOwner(stalePort!)).toBe(staleProcess.pid);
    } finally {
      leasedRunIds.delete(runId);
      await releaseRuntimeServicesForRun(runId);
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId,
        workspaceCwd: workspaceRoot,
      });
      if (staleProcess.pid) {
        try {
          process.kill(-staleProcess.pid, "SIGKILL");
        } catch {
          try {
            process.kill(staleProcess.pid, "SIGKILL");
          } catch {
            // Ignore cleanup races.
          }
        }
      }
    }
  }, 20_000);

  it("marks persisted local services stopped when the registry pid is stale", async () => {
    const companyId = randomUUID();
    const runtimeServiceId = randomUUID();
    const startedAt = new Date("2026-04-04T17:00:00.000Z");
    const updatedAt = new Date("2026-04-04T17:10:00.000Z");
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Runtime reconcile test",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: "/tmp/paperclip-primary",
      isPrimary: true,
    });
    await db.insert(workspaceRuntimeServices).values({
      id: runtimeServiceId,
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
      reuseKey: `project_workspace:${projectWorkspaceId}:paperclip-dev`,
      command: "pnpm dev",
      cwd: "/tmp/paperclip-primary",
      port: 49195,
      url: "http://127.0.0.1:49195",
      provider: "local_process",
      providerRef: "999999",
      ownerAgentId: null,
      startedByRunId: null,
      lastUsedAt: updatedAt,
      startedAt,
      stoppedAt: null,
      stopPolicy: { type: "manual" },
      healthStatus: "healthy",
      createdAt: startedAt,
      updatedAt,
    });
    await writeLocalServiceRegistryRecord({
      version: 1,
      serviceKey: "workspace-runtime-paperclip-dev-stale",
      profileKind: "workspace-runtime",
      serviceName: "paperclip-dev",
      command: "pnpm dev",
      cwd: "/tmp/paperclip-primary",
      envFingerprint: "fingerprint",
      port: 49195,
      url: "http://127.0.0.1:49195",
      pid: 999999,
      processGroupId: 999999,
      provider: "local_process",
      runtimeServiceId,
      reuseKey: `project_workspace:${projectWorkspaceId}:paperclip-dev`,
      startedAt: startedAt.toISOString(),
      lastSeenAt: updatedAt.toISOString(),
      metadata: null,
    });

    const result = await reconcilePersistedRuntimeServicesOnStartup(db);

    expect(result).toMatchObject({ reconciled: 1, adopted: 0, stopped: 1 });
    const persisted = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(eq(workspaceRuntimeServices.id, runtimeServiceId))
      .then((rows) => rows[0] ?? null);
    expect(persisted?.status).toBe("stopped");
    expect(persisted?.stoppedAt).not.toBeNull();
  });

  it("persists controlled execution workspace stops as stopped", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-stop-persisted-"));
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const runId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      name: "Runtime stop test",
      status: "active",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Execution workspace stop test",
      status: "active",
      cwd: workspaceRoot,
      providerType: "local_fs",
      providerRef: workspaceRoot,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
      updatedAt: new Date(),
    });

    const workspace = {
      ...buildWorkspace(workspaceRoot),
      projectId: null,
      workspaceId: null,
    };
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      db,
      runId,
      agent: {
        id: agentId,
        name: "Codex Coder",
        companyId,
      },
      issue: null,
      workspace,
      executionWorkspaceId,
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    expect(services[0]?.url).toBeTruthy();

    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId,
      workspaceCwd: workspace.cwd,
    });
    await releaseRuntimeServicesForRun(runId);
    leasedRunIds.delete(runId);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await expect(fetch(services[0]!.url!)).rejects.toThrow();

    const persisted = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(eq(workspaceRuntimeServices.id, services[0]!.id))
      .then((rows) => rows[0] ?? null);

    expect(persisted?.status).toBe("stopped");
    expect(persisted?.healthStatus).toBe("unknown");
    expect(persisted?.stoppedAt).toBeTruthy();
  });

  it("restarts a stopped auto-port service on the same port when it is available", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-port-reuse-"));
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      name: "Runtime port reuse test",
      status: "active",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Execution workspace port reuse test",
      status: "active",
      cwd: workspaceRoot,
      providerType: "local_fs",
      providerRef: workspaceRoot,
    });

    const actor = {
      id: agentId,
      name: "Codex Coder",
      companyId,
    };
    const workspace = {
      ...buildWorkspace(workspaceRoot),
      projectId,
      workspaceId: null,
    };
    const config = {
      workspaceRuntime: {
        services: [
          {
            name: "web",
            command:
              "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            expose: {
              type: "url",
              urlTemplate: "http://127.0.0.1:{{port}}",
            },
            lifecycle: "shared",
            reuseScope: "execution_workspace",
            stopPolicy: {
              type: "manual",
            },
          },
        ],
      },
    };

    const first = await startRuntimeServicesForWorkspaceControl({
      db,
      actor,
      issue: null,
      workspace,
      executionWorkspaceId,
      config,
      adapterEnv: {},
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.port).toBeGreaterThan(0);
    await expect(fetch(first[0]!.url!)).resolves.toMatchObject({ ok: true });

    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId,
      workspaceCwd: workspace.cwd,
    });
    await expect(fetch(first[0]!.url!)).rejects.toThrow();

    const second = await startRuntimeServicesForWorkspaceControl({
      db,
      actor,
      issue: null,
      workspace,
      executionWorkspaceId,
      config,
      adapterEnv: {},
    });

    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.port).toBe(first[0]?.port);
    expect(second[0]?.url).toBe(first[0]?.url);
    await expect(fetch(second[0]!.url!)).resolves.toMatchObject({ ok: true });

    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId,
      workspaceCwd: workspace.cwd,
    });
  });
});

describe("normalizeAdapterManagedRuntimeServices", () => {
  it("fills workspace defaults and derives stable ids for adapter-managed services", () => {
    const workspace = buildWorkspace("/tmp/project");
    const now = new Date("2026-03-09T12:00:00.000Z");

    const first = normalizeAdapterManagedRuntimeServices({
      adapterType: "openclaw_gateway",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Worktree support",
      },
      workspace,
      reports: [
        {
          serviceName: "preview",
          url: "https://preview.example/run-1",
          providerRef: "sandbox-123",
          scopeType: "run",
        },
      ],
      now,
    });

    const second = normalizeAdapterManagedRuntimeServices({
      adapterType: "openclaw_gateway",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Worktree support",
      },
      workspace,
      reports: [
        {
          serviceName: "preview",
          url: "https://preview.example/run-1",
          providerRef: "sandbox-123",
          scopeType: "run",
        },
      ],
      now,
    });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: "workspace-1",
      executionWorkspaceId: null,
      issueId: "issue-1",
      serviceName: "preview",
      provider: "adapter_managed",
      status: "running",
      healthStatus: "healthy",
      startedByRunId: "run-1",
    });
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it("prefers execution workspace ids over cwd for execution-scoped adapter services", () => {
    const workspace = buildWorkspace("/tmp/project");

    const refs = normalizeAdapterManagedRuntimeServices({
      adapterType: "openclaw_gateway",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      reports: [
        {
          serviceName: "preview",
          scopeType: "execution_workspace",
        },
      ],
    });

    expect(refs[0]).toMatchObject({
      scopeType: "execution_workspace",
      scopeId: "execution-workspace-1",
      executionWorkspaceId: "execution-workspace-1",
    });
  });
});
