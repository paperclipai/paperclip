import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
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
  cleanupExecutionWorkspaceArtifacts,
  ensureServerWorkspaceLinksCurrent,
  ensureRuntimeServicesForRun,
  normalizeAdapterManagedRuntimeServices,
  reconcilePersistedRuntimeServicesOnStartup,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  resetRuntimeServicesForTests,
  resolveShell,
  sanitizeRuntimeServiceBaseEnv,
  stopRuntimeServicesForExecutionWorkspace,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import { writeLocalServiceRegistryRecord } from "../services/local-service-supervisor.ts";
import { resolvePaperclipConfigPath } from "../paths.ts";
import type { WorkspaceOperation } from "@paperclipai/shared";
import type { WorkspaceOperationRecorder } from "../services/workspace-operations.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const execFileAsync = promisify(execFile);
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
  });

  it("writes an isolated repo-local Paperclip config and worktree branding when provisioning", async () => {
    const repoRoot = await createTempRepo();
    const previousCwd = process.cwd();
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-home-"));
    const isolatedWorktreeHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktrees-"));
    const instanceId = "worktree-base";
    const sharedConfigDir = path.join(paperclipHome, "instances", instanceId);
    const sharedConfigPath = path.join(sharedConfigDir, "config.json");
    const sharedEnvPath = path.join(sharedConfigDir, ".env");

    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = instanceId;
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedWorktreeHome;

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
          identifier: "PAP-885",
          title: "Show worktree banner",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
      });

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
    } finally {
      process.chdir(previousCwd);
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
  });

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
          // No baseRef configured — should auto-detect "master"
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
    // The worktree should have been created successfully (baseRef resolved to "master")
    const worktreeOp = operations.find(op => op.phase === "worktree_prepare" && op.metadata?.created);
    expect(worktreeOp).toBeDefined();
    expect(worktreeOp!.metadata!.baseRef).toBe("master");
  });

  it("auto-detects the default branch via symbolic-ref when origin/HEAD is set", async () => {
    // Create a repo with "master" as default branch
    const repoRoot = await createTempRepo("master");

    // Set up a bare remote and push
    const bareRemote = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-bare-symref-"));
    await runGit(bareRemote, ["init", "--bare"]);
    await runGit(repoRoot, ["remote", "add", "origin", bareRemote]);
    await runGit(repoRoot, ["push", "-u", "origin", "master"]);
    await runGit(repoRoot, ["fetch", "origin"]);
    // Explicitly set refs/remotes/origin/HEAD to exercise the symbolic-ref path
    // (git remote set-head -a requires the remote to advertise HEAD, so we set it manually)
    await runGit(repoRoot, ["remote", "set-head", "origin", "master"]);

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
          // No baseRef configured — should auto-detect "master" via symbolic-ref
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
    expect(worktreeOp!.metadata!.baseRef).toBe("master");
  });

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
  });

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
  });

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
    process.env.SHELL = "/usr/bin/zsh";
    expect(resolveShell()).toBe("/usr/bin/zsh");
  });

  it("trims whitespace from SHELL env var", () => {
    process.env.SHELL = "  /usr/bin/fish  ";
    expect(resolveShell()).toBe("/usr/bin/fish");
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
