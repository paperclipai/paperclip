import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseEnvContents } from "dotenv";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
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
  refreshRemoteTrackingBaseRef,
  releaseRuntimeServicesForRun,
  UnresolvedWorkspaceBaseRefError,
  resetRuntimeServicesForTests,
  MANAGED_RUNTIME_PUBLIC_URL_ENV,
  resolveManagedPaperclipRuntimePublicOrigin,
  resolveRuntimeProvisionCommand,
  resolveWorkspaceRuntimeReadinessTimeoutSec,
  resolveShell,
  sanitizeRuntimeServiceBaseEnv,
  setWorkspaceRuntimeExposureDepsForTests,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
  stopRuntimeServicesForProjectWorkspace,
  WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import {
  findAdoptableLocalService,
  isLocalServiceRegistryCwdCompatible,
  isLocalServiceProcessOwnedBy,
  isLocalServiceProcessInWorkspace,
  readLocalServiceProcessCwd,
  readLocalServicePortOwner,
  writeLocalServiceRegistryRecord,
} from "../services/local-service-supervisor.ts";
import {
  buildWorkspaceRealizationRecord,
  buildWorkspaceRealizationRequest,
  readWorkspaceRealizationRequest,
} from "../services/workspace-realization.ts";
import {
  deriveViteHmrPort,
  type Environment,
  type EnvironmentLease,
} from "@paperclipai/shared";
import { resolvePaperclipConfigPath } from "../paths.ts";
import type { WorkspaceOperation } from "@paperclipai/shared";
import type { WorkspaceOperationRecorder } from "../services/workspace-operations.ts";
import { deriveWorktreeInstanceId } from "../services/workspace-instance-cleanup.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const RUNTIME_OWNED_GIT_BRANCH_METADATA = {
  createdByRuntime: true,
  gitBranchOwnershipVersion: 1,
} as const;

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

async function writeRegisteredSourceConfig(baseCwd: string, instanceId = "source-instance") {
  const configDir = path.join(baseCwd, ".paperclip");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "config.json"), "{}\n", "utf8");
  await fs.writeFile(
    path.join(configDir, ".env"),
    `PAPERCLIP_INSTANCE_ID=${instanceId}\n`,
    "utf8",
  );
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
        metadata: RUNTIME_OWNED_GIT_BRANCH_METADATA,
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

// Push a branch to the bare remote without leaving a local ref or a
// remote-tracking ref in `repoRoot`. This reproduces a remote-only feature
// branch: the clone was made before the push, so `repoRoot` learns the branch
// only after an authenticated fetch of `origin/<branch>`.
async function pushRemoteOnlyBranch(
  sourceRepo: string,
  remotePath: string,
  branch: string,
  fileName: string,
) {
  await runGit(sourceRepo, ["checkout", "-B", branch]);
  await fs.writeFile(path.join(sourceRepo, fileName), `${fileName}\n`, "utf8");
  await runGit(sourceRepo, ["add", fileName]);
  await runGit(sourceRepo, ["commit", "-m", `Add ${fileName}`]);
  await runGit(sourceRepo, ["push", remotePath, branch]);
  const sha = await readGit(sourceRepo, ["rev-parse", branch]);
  await runGit(sourceRepo, ["checkout", "master"]);
  return sha;
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

async function closeNetServer(server: net.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function listenOnPort(port: number) {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function findFreePort() {
  const server = await listenOnPort(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await closeNetServer(server);
  if (!port) throw new Error("Failed to find a free test port");
  return port;
}

async function reserveContiguousPorts(count: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const basePort = await findFreePort();
    if (basePort + count - 1 > 65_535) continue;
    const servers: net.Server[] = [];
    try {
      for (let offset = 0; offset < count; offset += 1) {
        servers.push(await listenOnPort(basePort + offset));
      }
      return { basePort, servers };
    } catch {
      await Promise.all(servers.map((server) => closeNetServer(server).catch(() => undefined)));
    }
  }
  throw new Error(`Failed to reserve ${count} contiguous test ports`);
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
      BETTER_AUTH_URL: "https://parent.example.test",
      BETTER_AUTH_BASE_URL: "https://legacy-parent.example.test",
      npm_config_tailscale_auth: "true",
      npm_config_authenticated_private: "true",
      HOST: "0.0.0.0",
    });

    expect(sanitized.PAPERCLIP_HOME).toBeUndefined();
    expect(sanitized.PAPERCLIP_INSTANCE_ID).toBeUndefined();
    expect(sanitized.BETTER_AUTH_URL).toBeUndefined();
    expect(sanitized.BETTER_AUTH_BASE_URL).toBeUndefined();
    expect(sanitized.DATABASE_URL).toBeUndefined();
    expect(sanitized.npm_config_tailscale_auth).toBeUndefined();
    expect(sanitized.npm_config_authenticated_private).toBeUndefined();
    expect(sanitized.HOST).toBe("0.0.0.0");
  });
});

describe("resolveManagedPaperclipRuntimePublicOrigin", () => {
  const baseInput = {
    serviceName: "paperclip-dev",
    command: "pnpm dev --bind lan",
  };

  it("leaves explicit operator origin configuration unchanged", () => {
    expect(resolveManagedPaperclipRuntimePublicOrigin({
      ...baseInput,
      environment: { PAPERCLIP_PUBLIC_URL: "https://operator.example.com" },
      exposedUrl: "https://managed-worktree.example.com",
    })).toBeNull();

    expect(resolveManagedPaperclipRuntimePublicOrigin({
      ...baseInput,
      environment: { BETTER_AUTH_URL: "https://auth.example.com" },
      exposedUrl: "https://managed-worktree.example.com",
    })).toBeNull();
  });

  it("infers browser-reachable HTTPS and loopback origins", () => {
    expect(resolveManagedPaperclipRuntimePublicOrigin({
      ...baseInput,
      environment: {},
      exposedUrl: "https://paperclip-dev.tail29c1aa.ts.net/path?ignored=true",
      exposedUrlTemplate: "https://{{workspace.branchName}}.tail29c1aa.ts.net",
    })).toBe("https://paperclip-dev.tail29c1aa.ts.net");
    expect(resolveManagedPaperclipRuntimePublicOrigin({
      ...baseInput,
      environment: {},
      exposedUrl: "http://127.0.0.1:45439",
    })).toBe("http://127.0.0.1:45439");
  });

  it("rejects internal-only and unsafe inferred origins with actionable guidance", () => {
    expect(() => resolveManagedPaperclipRuntimePublicOrigin({
      ...baseInput,
      environment: {},
      exposedUrl: "http://paperclip-dev:45439",
    })).toThrow(/internal-only.*Configure PAPERCLIP_PUBLIC_URL or BETTER_AUTH_URL/);
    expect(() => resolveManagedPaperclipRuntimePublicOrigin({
      ...baseInput,
      environment: {},
      exposedUrl: "http://10.0.0.8:45439",
    })).toThrow(/non-loopback OAuth callbacks require HTTPS/);
  });

  it("keeps interpolated hostnames inside the operator-configured domain", () => {
    expect(() => resolveManagedPaperclipRuntimePublicOrigin({
      ...baseInput,
      environment: {},
      exposedUrl: "https://evil.com/workaround.tail29c1aa.ts.net",
      exposedUrlTemplate: "https://{{workspace.branchName}}.tail29c1aa.ts.net",
    })).toThrow(/outside the hostname boundary configured by expose\.urlTemplate/);

    expect(() => resolveManagedPaperclipRuntimePublicOrigin({
      ...baseInput,
      environment: {},
      exposedUrl: "https://managed-worktree.paperclip.dev",
      exposedUrlTemplate: "https://{{workspace.branchName}}.com",
    })).toThrow(/does not define a stable hostname boundary/);
  });
});

describe("resolveRuntimeProvisionCommand", () => {
  it("backfills deferred seeding for legacy managed git worktrees", async () => {
    const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-provision-"));
    const cwd = path.join(baseCwd, "worktree");
    try {
      await fs.mkdir(path.join(baseCwd, "scripts"), { recursive: true });
      await fs.writeFile(
        path.join(baseCwd, "scripts", "provision-worktree-runtime.sh"),
        "#!/usr/bin/env bash\n",
      );
      const workspace = {
        ...buildWorkspace(cwd),
        baseCwd,
        strategy: "git_worktree" as const,
        worktreePath: cwd,
      };

      expect(resolveRuntimeProvisionCommand({ config: {}, workspace })).toBe(
        "bash ./scripts/provision-worktree-runtime.sh",
      );

      await fs.mkdir(path.join(cwd, ".paperclip"), { recursive: true });
      await fs.writeFile(path.join(cwd, ".paperclip", "config.json"), "{}\n");
      expect(resolveRuntimeProvisionCommand({ config: {}, workspace })).toBe(
        "bash ./scripts/provision-worktree-runtime.sh",
      );

      await fs.writeFile(path.join(cwd, ".paperclip", "seed-pending"), "{}\n");
      expect(resolveRuntimeProvisionCommand({ config: {}, workspace })).toBe(
        "bash ./scripts/provision-worktree-runtime.sh",
      );
      expect(resolveRuntimeProvisionCommand({
        config: { runtimeProvisionCommand: "./custom-provision.sh" },
        workspace,
      })).toBe("./custom-provision.sh");

      await fs.writeFile(path.join(cwd, ".paperclip", "seed-complete"), "{}\n");
      expect(resolveRuntimeProvisionCommand({ config: {}, workspace })).toBe(
        "bash ./scripts/provision-worktree-runtime.sh",
      );

      await fs.writeFile(
        path.join(cwd, ".paperclip", "seed-manifest.json"),
        JSON.stringify({ version: 2, state: "failed" }),
      );
      expect(resolveRuntimeProvisionCommand({ config: {}, workspace })).toBe(
        "bash ./scripts/provision-worktree-runtime.sh",
      );
      await fs.writeFile(
        path.join(cwd, ".paperclip", "seed-manifest.json"),
        JSON.stringify({ version: 2, state: "verified" }),
      );
      expect(resolveRuntimeProvisionCommand({ config: {}, workspace })).toBe(
        "bash ./scripts/provision-worktree-runtime.sh",
      );
      await fs.writeFile(
        path.join(cwd, ".paperclip", "seed-manifest.json"),
        JSON.stringify({
          version: 2,
          source: { instanceId: "source", configPath: "/source/config.json" },
          snapshotAt: "2026-08-18T00:00:00.000Z",
          seedMode: "full",
          migrationRevision: "0001",
          targetInstanceId: "target",
          phase: "complete",
          state: "verified",
          attemptId: "attempt",
          startedAt: "2026-08-18T00:00:00.000Z",
          finishedAt: "2026-08-18T00:01:00.000Z",
          diagnostics: [{ phase: "complete", status: "succeeded", at: "2026-08-18T00:01:00.000Z" }],
        }),
      );
      expect(resolveRuntimeProvisionCommand({ config: {}, workspace })).toBe("");
    } finally {
      await fs.rm(baseCwd, { recursive: true, force: true });
    }
  });
});

describe("refreshRemoteTrackingBaseRef git auth", () => {
  it("offers the remote URL to the provider and keeps ambient behavior when it returns null", async () => {
    const { remotePath, repoRoot } = await createClonedRepoWithRemote();
    const offeredUrls: string[] = [];
    const warnings = await refreshRemoteTrackingBaseRef(repoRoot, "origin/master", async (remoteUrl) => {
      offeredUrls.push(remoteUrl);
      return null;
    });
    expect(warnings).toEqual([]);
    expect(offeredUrls).toEqual([remotePath]);
  });

  it("attributes a failed authenticated fetch to the credential that was used", async () => {
    const { repoRoot } = await createClonedRepoWithRemote();
    await runGit(repoRoot, ["remote", "set-url", "origin", path.join(os.tmpdir(), "paperclip-missing-remote", "repo.git")]);
    const warnings = await refreshRemoteTrackingBaseRef(repoRoot, "origin/master", async () => ({
      configArgs: [],
      env: { GIT_TERMINAL_PROMPT: "0" },
      source: "company_secret",
      secretName: "GH_TOKEN",
    }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Could not refresh base ref origin/master");
    expect(warnings[0]).toContain("the GH_TOKEN company-secret GitHub credential");
  });

  it("keeps the unauthenticated failure warning credential-free without a provider", async () => {
    const { repoRoot } = await createClonedRepoWithRemote();
    await runGit(repoRoot, ["remote", "set-url", "origin", path.join(os.tmpdir(), "paperclip-missing-remote", "repo.git")]);
    const warnings = await refreshRemoteTrackingBaseRef(repoRoot, "origin/master");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Could not refresh base ref origin/master");
    expect(warnings[0]).not.toContain("GitHub credential");
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
    const realizationInput = {
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
    } satisfies Parameters<typeof realizeExecutionWorkspace>[0];

    const first = await realizeExecutionWorkspace(realizationInput);

    expect(first.strategy).toBe("git_worktree");
    expect(first.created).toBe(true);
    expect(first.branchCreatedByRuntime).toBe(true);
    expect(first.branchName).toBe("PAP-447-add-worktree-support");
    expect(first.cwd).toContain(path.join(".paperclip", "worktrees"));
    await expect(fs.stat(path.join(first.cwd, ".git"))).resolves.toBeTruthy();

    const second = await realizeExecutionWorkspace({
      ...realizationInput,
      recordedBranchOwnership: {
        branchName: first.branchName!,
        createdByRuntime: first.branchCreatedByRuntime,
      },
    });

    expect(second.created).toBe(false);
    expect(second.branchCreatedByRuntime).toBe(true);
    expect(second.cwd).toBe(first.cwd);
    expect(second.branchName).toBe(first.branchName);
  });

  it("defaults the repo-provided worktree provisioner for git worktree strategies", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision-worktree.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "mkdir -p .paperclip",
        "printf 'provisioned\\n' > .paperclip/default-provision-ran",
        "",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision-worktree.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add repository worktree provisioner"]);

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
        id: "issue-default-provision",
        identifier: "PAP-17684",
        title: "Default worktree provisioning",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(
      fs.readFile(path.join(workspace.cwd, ".paperclip", "default-provision-ran"), "utf8"),
    ).resolves.toBe("provisioned\n");
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

  it("bases a fresh worktree on a remote-only branch supplied as fix/foo", async () => {
    const { sourceRepo, remotePath, repoRoot } = await createClonedRepoWithRemote();
    const remoteSha = await pushRemoteOnlyBranch(sourceRepo, remotePath, "fix/foo", "remote-only.txt");

    // The clone never learned the branch: no local ref and no remote-tracking ref.
    await expect(readGit(repoRoot, ["rev-parse", "--verify", "fix/foo"])).rejects.toThrow();
    await expect(readGit(repoRoot, ["rev-parse", "--verify", "origin/fix/foo"])).rejects.toThrow();

    const workspace = await realizeWorktreeForTest(repoRoot, "fix/foo");

    expect(workspace.created).toBe(true);
    expect(workspace.repoRef).toBe("origin/fix/foo");
    expect(workspace.baseRefSha).toBe(remoteSha);
    expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(remoteSha);
  });

  it("bases a fresh worktree on a remote-only branch supplied as origin/fix/foo", async () => {
    const { sourceRepo, remotePath, repoRoot } = await createClonedRepoWithRemote();
    const remoteSha = await pushRemoteOnlyBranch(sourceRepo, remotePath, "fix/bar", "remote-only.txt");

    await expect(readGit(repoRoot, ["rev-parse", "--verify", "origin/fix/bar"])).rejects.toThrow();

    const workspace = await realizeWorktreeForTest(repoRoot, "origin/fix/bar");

    expect(workspace.created).toBe(true);
    expect(workspace.repoRef).toBe("origin/fix/bar");
    expect(workspace.baseRefSha).toBe(remoteSha);
    expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(remoteSha);
  });

  it("stops before git worktree add when the base ref is absent on origin", async () => {
    const { repoRoot } = await createClonedRepoWithRemote();

    const error = await realizeWorktreeForTest(repoRoot, "fix/does-not-exist").then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UnresolvedWorkspaceBaseRefError);
    const unresolved = error as UnresolvedWorkspaceBaseRefError;
    expect(unresolved.requestedRef).toBe("fix/does-not-exist");
    expect(unresolved.recoveryIdentityRef).toBe("origin/fix/does-not-exist");
    expect(unresolved.attemptedRefs).toEqual(["origin/fix/does-not-exist"]);
    // No worktree directory was created for the fresh-create path.
    await expect(
      fs.stat(path.join(repoRoot, ".paperclip", "worktrees", "PAP-447-add-worktree-support")),
    ).rejects.toThrow();
  });

  it("gives equivalent spellings of one absent remote ref the same recovery identity", async () => {
    const { repoRoot } = await createClonedRepoWithRemote();

    // The unqualified form and the remote-tracking form name the same remote
    // branch. Both must map to one `recoveryIdentityRef`, so recovery does not
    // treat a spelling change as a new blocker.
    const unqualified = await realizeWorktreeForTest(repoRoot, "fix/absent").then(
      () => null,
      (caught: unknown) => caught,
    );
    const remoteTracking = await realizeWorktreeForTest(repoRoot, "origin/fix/absent").then(
      () => null,
      (caught: unknown) => caught,
    );
    // The full remote-tracking spelling names the same branch as well. It must
    // map to the same canonical recovery identity, not to its raw spelling.
    const fullRemoteTracking = await realizeWorktreeForTest(repoRoot, "refs/remotes/origin/fix/absent").then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(unqualified).toBeInstanceOf(UnresolvedWorkspaceBaseRefError);
    expect(remoteTracking).toBeInstanceOf(UnresolvedWorkspaceBaseRefError);
    expect(fullRemoteTracking).toBeInstanceOf(UnresolvedWorkspaceBaseRefError);
    const unqualifiedError = unqualified as UnresolvedWorkspaceBaseRefError;
    const remoteTrackingError = remoteTracking as UnresolvedWorkspaceBaseRefError;
    const fullRemoteTrackingError = fullRemoteTracking as UnresolvedWorkspaceBaseRefError;
    // Each error keeps its own operator spelling for the human notice.
    expect(unqualifiedError.requestedRef).toBe("fix/absent");
    expect(remoteTrackingError.requestedRef).toBe("origin/fix/absent");
    expect(fullRemoteTrackingError.requestedRef).toBe("refs/remotes/origin/fix/absent");
    // All three share one canonical recovery identity.
    expect(unqualifiedError.recoveryIdentityRef).toBe("origin/fix/absent");
    expect(remoteTrackingError.recoveryIdentityRef).toBe("origin/fix/absent");
    expect(fullRemoteTrackingError.recoveryIdentityRef).toBe("origin/fix/absent");
  });

  it("surfaces an authenticated fetch failure as an unresolved base ref, not a crash", async () => {
    const { repoRoot } = await createClonedRepoWithRemote();
    // Point origin at a path that no repository backs. The authenticated fetch
    // fails, so the ref never resolves and the resolver reports the fetch error.
    await runGit(repoRoot, ["remote", "set-url", "origin", path.join(os.tmpdir(), "paperclip-missing-remote.git")]);

    const error = await realizeWorktreeForTest(repoRoot, "fix/unreachable").then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UnresolvedWorkspaceBaseRefError);
    const unresolved = error as UnresolvedWorkspaceBaseRefError;
    expect(unresolved.requestedRef).toBe("fix/unreachable");
    expect(unresolved.fetchError).toEqual(
      expect.stringContaining("Could not refresh base ref origin/fix/unreachable"),
    );
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
    await writeRegisteredSourceConfig(repoRoot, "worktree-base-source");
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousConfig = process.env.PAPERCLIP_CONFIG;
    const previousHome = process.env.PAPERCLIP_HOME;
    const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousWorktreesDir = process.env.PAPERCLIP_WORKTREES_DIR;
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
    delete process.env.PAPERCLIP_CONFIG;
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
      const expectedInstanceId = deriveWorktreeInstanceId(workspace.cwd);
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
      for (const [key, value] of [
        ["PAPERCLIP_CONFIG", previousConfig],
        ["PAPERCLIP_HOME", previousHome],
        ["PAPERCLIP_INSTANCE_ID", previousInstanceId],
        ["PAPERCLIP_WORKTREES_DIR", previousWorktreesDir],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }, 15_000);

  it(
    "provisions worktree-local pnpm node_modules instead of reusing base-repo links",
    async () => {
    const repoRoot = await createTempRepo();
    await writeRegisteredSourceConfig(repoRoot);
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
    await writeRegisteredSourceConfig(repoRoot);
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
      await writeRegisteredSourceConfig(baseRoot);
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
      await writeRegisteredSourceConfig(baseRoot);
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
      await writeRegisteredSourceConfig(baseRoot);
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
      await writeRegisteredSourceConfig(baseRoot);
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
    await writeRegisteredSourceConfig(repoRoot);
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
        metadata: RUNTIME_OWNED_GIT_BRANCH_METADATA,
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
        metadata: RUNTIME_OWNED_GIT_BRANCH_METADATA,
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
        metadata: RUNTIME_OWNED_GIT_BRANCH_METADATA,
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
      enableWorkspaceDirtyQuarantineRepair: false,
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
          dirtyPathSample: ["untracked.txt"],
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
        metadata: RUNTIME_OWNED_GIT_BRANCH_METADATA,
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
          metadata: RUNTIME_OWNED_GIT_BRANCH_METADATA,
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

  it("routes a deleted recorded branch with a clean worktree to forward adoption when reconcile-forward is enabled", async () => {
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
          metadata: RUNTIME_OWNED_GIT_BRANCH_METADATA,
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

    // Without a database the adoption cannot be audited, so it still fails closed —
    // but through the forward-adoption path rather than "expected branch does not exist".
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
            attempted: false,
            succeeded: false,
            reason: "forward reconciliation adoption requires database access to audit after workspace realization",
          }),
        }),
      },
    });
  }, 15_000);

  it("keeps a deleted recorded branch fail-closed when reconcile-forward is disabled", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "PAP-458-deleted-recorded-branch-flag-off";
    const actualBranch = "PAP-458-actual-work-flag-off";
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
          id: "execution-workspace-deleted-branch-flag-off",
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: worktreePath,
          providerRef: worktreePath,
          projectId: "project-1",
          projectWorkspaceId: "workspace-1",
          repoUrl: null,
          baseRef: "HEAD",
          branchName: expectedBranch,
          metadata: RUNTIME_OWNED_GIT_BRANCH_METADATA,
        },
        issue: {
          id: "issue-deleted-branch-flag-off",
          identifier: "PAP-458",
          title: "Classify deleted branch ancestry",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
        enableWorkspaceBranchReconcileForward: false,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          cleanliness: "clean",
          provenance: expect.objectContaining({
            expectedBranchExists: false,
            actualBranchExists: true,
            ancestryVerdict: "unknown",
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

  it("rejects an empty base checkout path with a clear cause", async () => {
    // An empty base path makes the later "git" spawn fail with a raw ENOENT.
    // The reopen must throw a clear cause first that names the empty checkout.
    let error: unknown = null;
    try {
      await ensurePersistedExecutionWorkspaceAvailable({
        base: {
          baseCwd: "",
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        workspace: {
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: "/does-not-exist/worktree",
          providerRef: "/does-not-exist/worktree",
          projectId: "project-1",
          projectWorkspaceId: "workspace-1",
          repoUrl: null,
          baseRef: "HEAD",
          branchName: "feature-branch",
        },
        issue: {
          id: "issue-1",
          identifier: "PAP-461",
          title: "Empty base checkout path",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Cannot rebuild the git worktree: the base project checkout path is empty.",
    );
  });

  it("preserves a whitespace-only base checkout path and reports it as missing", async () => {
    // The reopen must use the persisted base path exactly. A trim would change
    // a whitespace-only path into an empty path and hide the real cause.
    // A directory name can consist of spaces, so keep the path unchanged and
    // let the directory-exists check report the missing checkout.
    let error: unknown = null;
    try {
      await ensurePersistedExecutionWorkspaceAvailable({
        base: {
          baseCwd: "   ",
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        workspace: {
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: "/does-not-exist/worktree",
          providerRef: "/does-not-exist/worktree",
          projectId: "project-1",
          projectWorkspaceId: "workspace-1",
          repoUrl: null,
          baseRef: "HEAD",
          branchName: "feature-branch",
        },
        issue: {
          id: "issue-1",
          identifier: "PAP-461",
          title: "Whitespace base checkout path",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Cannot rebuild the git worktree: the base project checkout directory does not exist.",
    );
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

    expect(workspace.branchCreatedByRuntime).toBe(true);

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
          createdByRuntime: workspace.branchCreatedByRuntime,
          gitBranchOwnershipVersion: 1,
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

  it("deletes a runtime-created branch at its verified tip after a reuse realization", async () => {
    const repoRoot = await createTempRepo();
    const realizationInput = {
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
        id: "issue-reused-cleanup",
        identifier: "PAP-17633",
        title: "Preserve branch ownership across reuse",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    } satisfies Parameters<typeof realizeExecutionWorkspace>[0];

    const initial = await realizeExecutionWorkspace(realizationInput);
    expect(initial.branchCreatedByRuntime).toBe(true);
    const verifiedBranchTip = await readGit(initial.cwd, ["rev-parse", "HEAD"]);

    const reused = await realizeExecutionWorkspace({
      ...realizationInput,
      recordedBranchOwnership: {
        branchName: initial.branchName!,
        createdByRuntime: initial.branchCreatedByRuntime,
      },
    });
    expect(reused.created).toBe(false);
    expect(reused.branchCreatedByRuntime).toBe(true);

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-reused-cleanup",
        cwd: reused.cwd,
        providerType: "git_worktree",
        providerRef: reused.worktreePath,
        branchName: reused.branchName,
        repoUrl: reused.repoUrl,
        baseRef: reused.repoRef,
        projectId: reused.projectId,
        projectWorkspaceId: reused.workspaceId,
        sourceIssueId: "issue-reused-cleanup",
        metadata: {
          createdByRuntime: reused.branchCreatedByRuntime,
          gitBranchOwnershipVersion: 1,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: null,
      },
      expectedBranchHeadSha: verifiedBranchTip,
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toEqual([]);
    await expect(fs.stat(reused.cwd)).rejects.toThrow();
    await expect(
      execFileAsync("git", ["rev-parse", "--verify", `refs/heads/${reused.branchName}`], {
        cwd: repoRoot,
      }),
    ).rejects.toThrow();
  });

  it("keeps a runtime-created branch when its tip changes after guarded worktree removal", async () => {
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
        identifier: "PAP-450",
        title: "Race branch cleanup",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });
    const expectedHeadSha = await readGit(workspace.cwd, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(repoRoot, "raced.txt"), "new work\n", "utf8");
    await runGit(repoRoot, ["add", "raced.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Raced branch update"]);
    const racedHeadSha = await readGit(repoRoot, ["rev-parse", "HEAD"]);

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
        metadata: RUNTIME_OWNED_GIT_BRANCH_METADATA,
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: null,
      },
      expectedBranchHeadSha: expectedHeadSha,
      beforeBranchDelete: async () => {
        await runGit(repoRoot, ["update-ref", `refs/heads/${workspace.branchName}`, racedHeadSha]);
      },
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toHaveLength(1);
    expect(cleanup.warnings[0]).toContain(`Skipped deleting branch "${workspace.branchName}"`);
    expect(await readGit(repoRoot, ["rev-parse", `refs/heads/${workspace.branchName}`])).toBe(racedHeadSha);
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
          ...RUNTIME_OWNED_GIT_BRANCH_METADATA,
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

    const worktreesDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-instances-"));
    const instanceId = deriveWorktreeInstanceId(workspace.cwd);
    const instanceRoot = path.join(worktreesDir, "instances", instanceId);
    await fs.mkdir(path.join(instanceRoot, "db"), { recursive: true });
    await fs.mkdir(path.join(workspace.cwd, ".paperclip"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.cwd, ".paperclip", ".env"),
      `PAPERCLIP_HOME=${JSON.stringify(worktreesDir)}\nPAPERCLIP_INSTANCE_ID=${JSON.stringify(instanceId)}\n`,
      "utf8",
    );
    process.env.PAPERCLIP_WORKTREES_DIR = worktreesDir;

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
          ...RUNTIME_OWNED_GIT_BRANCH_METADATA,
          worktreeInstanceRoot: instanceRoot,
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
      "workspace_teardown",
      "worktree_cleanup",
      "worktree_cleanup",
    ]);
    expect(operations[0]?.command).toBe("printf 'cleanup ok\\n'");
    expect(operations[1]?.metadata).toMatchObject({
      cleanupAction: "remove_worktree_instance",
      instanceRoot,
    });
    expect(operations[2]?.metadata).toMatchObject({
      cleanupAction: "worktree_remove",
    });
    expect(operations[3]?.metadata).toMatchObject({
      cleanupAction: "branch_delete",
    });
    await expect(fs.stat(instanceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(worktreesDir, { recursive: true, force: true });
  });
});

describe("ensureRuntimeServicesForRun", () => {
  function configureRuntimeProvisionTestHome(workspaceRoot: string, suffix: string) {
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = workspaceRoot;
    process.env.PAPERCLIP_INSTANCE_ID = `${suffix}-${randomUUID()}`;
    return () => {
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
    };
  }

  function runtimeProvisionTestConfig(input: {
    provisionCommand?: string;
    serviceCommand?: string;
  }) {
    return {
      ...(input.provisionCommand
        ? { runtimeProvisionCommand: input.provisionCommand }
        : {}),
      workspaceRuntime: {
        services: [
          {
            name: "web",
            command:
              input.serviceCommand
              ?? `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
            lifecycle: "shared",
            reuseScope: "execution_workspace",
            stopPolicy: { type: "manual" },
          },
        ],
      },
    };
  }

  function runtimeProvisionStartInput(input: {
    workspace: RealizedExecutionWorkspace;
    config: Record<string, unknown>;
    recorder?: WorkspaceOperationRecorder;
    onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  }) {
    return {
      invocationId: randomUUID(),
      actor: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-16073",
        title: "Lazy runtime provision",
      },
      workspace: input.workspace,
      executionWorkspaceId: "execution-workspace-1",
      config: input.config,
      adapterEnv: {},
      recorder: input.recorder,
      onLog: input.onLog,
    };
  }

  it("runs runtime provisioning once when service starts race for the same workspace", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-provision-race-"));
    const restorePaperclipEnv = configureRuntimeProvisionTestHome(workspaceRoot, "runtime-provision-race");
    const counterPath = path.join(workspaceRoot, "runtime-provision-count.txt");
    const provisionScript = [
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(counterPath)}, 'run\\n');`,
      "setTimeout(() => {}, 250);",
    ].join(" ");
    const config = runtimeProvisionTestConfig({
      provisionCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(provisionScript)}`,
    });
    const workspace = buildWorkspace(workspaceRoot);
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    try {
      const [first, second] = await Promise.all([
        startRuntimeServicesForWorkspaceControl(runtimeProvisionStartInput({ workspace, config, recorder })),
        startRuntimeServicesForWorkspaceControl(runtimeProvisionStartInput({ workspace, config, recorder })),
      ]);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect((await fs.readFile(counterPath, "utf8")).trim().split("\n")).toEqual(["run"]);
      expect(operations.filter((operation) => operation.phase === "workspace_runtime_provision")).toHaveLength(1);

      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-1",
        workspaceCwd: workspaceRoot,
      });
      await startRuntimeServicesForWorkspaceControl(
        runtimeProvisionStartInput({ workspace, config, recorder }),
      );
      expect((await fs.readFile(counterPath, "utf8")).trim().split("\n")).toEqual(["run", "run"]);
      expect(operations.filter((operation) => operation.phase === "workspace_runtime_provision")).toHaveLength(2);
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-1",
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      restorePaperclipEnv();
    }
  });

  it("logs runtime provisioning failure and retries it on the next service start", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-provision-retry-"));
    const restorePaperclipEnv = configureRuntimeProvisionTestHome(workspaceRoot, "runtime-provision-retry");
    const attemptPath = path.join(workspaceRoot, "runtime-provision-attempt.txt");
    const provisionScript = [
      "const fs = require('node:fs');",
      `const attemptPath = ${JSON.stringify(attemptPath)};`,
      "const attempt = fs.existsSync(attemptPath) ? Number(fs.readFileSync(attemptPath, 'utf8')) : 0;",
      "fs.writeFileSync(attemptPath, String(attempt + 1));",
      "if (attempt === 0) { console.error('runtime seed exploded'); process.exit(7); }",
    ].join(" ");
    const config = runtimeProvisionTestConfig({
      provisionCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(provisionScript)}`,
    });
    const workspace = buildWorkspace(workspaceRoot);
    const logs: Array<{ stream: string; chunk: string }> = [];
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();
    const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    };

    try {
      await expect(
        startRuntimeServicesForWorkspaceControl(
          runtimeProvisionStartInput({ workspace, config, recorder, onLog }),
        ),
      ).rejects.toThrow(/runtime seed exploded/);

      const services = await startRuntimeServicesForWorkspaceControl(
        runtimeProvisionStartInput({ workspace, config, recorder, onLog }),
      );
      expect(services).toHaveLength(1);
      expect(await fs.readFile(attemptPath, "utf8")).toBe("2");
      expect(logs).toContainEqual(expect.objectContaining({
        stream: "stderr",
        chunk: expect.stringContaining("runtime seed exploded"),
      }));
      expect(
        operations
          .filter((operation) => operation.phase === "workspace_runtime_provision")
          .map((operation) => operation.result.status),
      ).toEqual(["failed", "succeeded"]);
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-1",
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      restorePaperclipEnv();
    }
  });

  it("records the built-in deferred seed as failed when its manifest is not verified", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-seed-operation-"));
    const restorePaperclipEnv = configureRuntimeProvisionTestHome(workspaceRoot, "workspace-seed-operation");
    const scriptsDir = path.join(workspaceRoot, "scripts");
    const markerDir = path.join(workspaceRoot, ".paperclip");
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.mkdir(markerDir, { recursive: true });
    await fs.writeFile(path.join(markerDir, "seed-pending"), "{}\n", "utf8");
    await fs.writeFile(
      path.join(scriptsDir, "provision-worktree-runtime.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `printf '%s\\n' '${JSON.stringify({ version: 2, state: "failed", phase: "source_validation" })}' > .paperclip/seed-manifest.json`,
      ].join("\n"),
      "utf8",
    );
    const config = runtimeProvisionTestConfig({});
    const workspace = {
      ...buildWorkspace(workspaceRoot),
      source: "task_session" as const,
      strategy: "git_worktree" as const,
      worktreePath: workspaceRoot,
    };
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    try {
      await expect(
        startRuntimeServicesForWorkspaceControl(
          runtimeProvisionStartInput({ workspace, config, recorder }),
        ),
      ).rejects.toThrow(/without a verified manifest.*source_validation/);

      expect(operations).toEqual([
        expect.objectContaining({
          phase: "workspace_seed",
          result: expect.objectContaining({
            status: "failed",
            exitCode: 1,
            metadata: expect.objectContaining({
              provisionKind: "workspace_seed",
              seedState: "failed",
              seedPhase: "source_validation",
              seedFailurePhase: "source_validation",
            }),
          }),
        }),
      ]);
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-1",
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      restorePaperclipEnv();
    }
  });

  it("keeps an explicit command matching the built-in seed command as runtime provisioning", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-explicit-runtime-provision-"));
    const restorePaperclipEnv = configureRuntimeProvisionTestHome(workspaceRoot, "explicit-runtime-provision");
    const scriptsDir = path.join(workspaceRoot, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(
      path.join(scriptsDir, "provision-worktree-runtime.sh"),
      "#!/usr/bin/env bash\nset -euo pipefail\n",
      "utf8",
    );
    const config = runtimeProvisionTestConfig({
      provisionCommand: "bash ./scripts/provision-worktree-runtime.sh",
    });
    const workspace = buildWorkspace(workspaceRoot);
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    try {
      const services = await startRuntimeServicesForWorkspaceControl(
        runtimeProvisionStartInput({ workspace, config, recorder }),
      );

      expect(services).toHaveLength(1);
      expect(operations).toEqual([
        expect.objectContaining({
          phase: "workspace_runtime_provision",
          metadata: expect.objectContaining({
            provisionKind: "runtime_dependencies",
          }),
          result: expect.objectContaining({
            status: "succeeded",
          }),
        }),
      ]);
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-1",
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      restorePaperclipEnv();
    }
  });

  it("does not create a runtime provision operation when the command is absent", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-provision-noop-"));
    const restorePaperclipEnv = configureRuntimeProvisionTestHome(workspaceRoot, "runtime-provision-noop");
    const workspace = buildWorkspace(workspaceRoot);
    const config = runtimeProvisionTestConfig({});
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    try {
      const services = await startRuntimeServicesForWorkspaceControl(
        runtimeProvisionStartInput({ workspace, config, recorder }),
      );
      expect(services).toHaveLength(1);
      expect(operations).toEqual([]);
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-1",
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      restorePaperclipEnv();
    }
  });

  it("preserves the selected persisted runtime id when starting one configured service", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-selected-id-"));
    const workspace = buildWorkspace(workspaceRoot);
    const restorePaperclipEnv = configureRuntimeProvisionTestHome(workspaceRoot, "runtime-selected-id");
    const runtimeServiceId = randomUUID();
    const config = runtimeProvisionTestConfig({});

    try {
      const services = await startRuntimeServicesForWorkspaceControl({
        ...runtimeProvisionStartInput({ workspace, config }),
        runtimeServiceId,
        serviceIndex: 0,
      });

      expect(services).toHaveLength(1);
      expect(services[0]?.id).toBe(runtimeServiceId);
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-1",
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      restorePaperclipEnv();
    }
  });

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

  it("injects isolated browser callback origins into separate worktree runtimes", async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-origin-first-"));
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-origin-second-"));
    const firstWorkspace: RealizedExecutionWorkspace = {
      ...buildWorkspace(firstRoot),
      source: "task_session",
      strategy: "git_worktree",
      branchName: "pap-17121-first",
      worktreePath: firstRoot,
    };
    const secondWorkspace: RealizedExecutionWorkspace = {
      ...buildWorkspace(secondRoot),
      source: "task_session",
      strategy: "git_worktree",
      branchName: "pap-17121-second",
      worktreePath: secondRoot,
    };
    const serviceScript =
      "const http=require('node:http');"
      + "http.createServer((req,res)=>{"
      + "if(req.url==='/api/health'){res.setHeader('content-type','application/json');"
      + "res.end(JSON.stringify({status:'ok'}));return;}"
      + `res.end(process.env.${MANAGED_RUNTIME_PUBLIC_URL_ENV}||'missing');`
      + "}).listen(Number(process.env.PORT),'127.0.0.1');";
    const config = {
      workspaceRuntime: {
        services: [
          {
            name: "paperclip-dev",
            command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(serviceScript)}`,
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            expose: {
              type: "url",
              urlTemplate: "https://{{workspace.branchName}}.tail29c1aa.ts.net",
            },
            lifecycle: "shared",
            reuseScope: "execution_workspace",
            stopPolicy: { type: "manual" },
          },
        ],
      },
    };
    const actor = { id: "agent-1", name: "Codex Coder", companyId: "company-1" };

    try {
      const [first] = await startRuntimeServicesForWorkspaceControl({
        actor,
        issue: null,
        workspace: firstWorkspace,
        executionWorkspaceId: "execution-workspace-first",
        config,
        adapterEnv: {},
      });
      const [second] = await startRuntimeServicesForWorkspaceControl({
        actor,
        issue: null,
        workspace: secondWorkspace,
        executionWorkspaceId: "execution-workspace-second",
        config,
        adapterEnv: {},
      });

      expect(first?.id).not.toBe(second?.id);
      await expect(fetch(`http://127.0.0.1:${first!.port}/origin`).then((response) => response.text()))
        .resolves.toBe("https://pap-17121-first.tail29c1aa.ts.net");
      await expect(fetch(`http://127.0.0.1:${second!.port}/origin`).then((response) => response.text()))
        .resolves.toBe("https://pap-17121-second.tail29c1aa.ts.net");
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-first",
        workspaceCwd: firstRoot,
      });
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-second",
        workspaceCwd: secondRoot,
      });
      await fs.rm(firstRoot, { recursive: true, force: true });
      await fs.rm(secondRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("requires Paperclip dev runtime services to pass /api/health readiness", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-health-"));
    const workspace = buildWorkspace(workspaceRoot);
    const runId = "run-paperclip-health";
    const serviceCommand =
      "node -e \"const http=require('node:http'); http.createServer((req,res)=>{ if (req.url==='/api/health') { res.statusCode=503; res.end('database_unreachable'); return; } res.end('ok'); }).listen(Number(process.env.PORT), '127.0.0.1')\"";

    try {
      await expect(
        ensureRuntimeServicesForRun({
          runId,
          agent: {
            id: "agent-1",
            name: "Codex Coder",
            companyId: "company-1",
          },
          issue: null,
          workspace,
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
                    timeoutSec: 3,
                    intervalMs: 100,
                  },
                  expose: {
                    type: "url",
                    urlTemplate: "http://127.0.0.1:{{port}}",
                  },
                  lifecycle: "shared",
                  stopPolicy: {
                    type: "manual",
                  },
                },
              ],
            },
          },
          adapterEnv: {},
        }),
        // The 503 health server must never pass readiness. Assert only that the
        // readiness check fails for the health URL. Do not assert the exact reason
        // string: under load the last probe near the deadline can get a small
        // budget and abort with a timeout before it reads the HTTP 503 response.
      ).rejects.toThrow(/Readiness check failed for http:\/\/127\.0\.0\.1:\d+\/api\/health/);
    } finally {
      await releaseRuntimeServicesForRun(runId);
    }
  });

  it("replaces a reused Paperclip dev runtime whose 2xx health payload is unhealthy", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-misreported-health-"));
    const workspace = buildWorkspace(workspaceRoot);
    const serviceCommand =
      "node -e \"let healthy=true;const http=require('node:http');http.createServer((req,res)=>{if(req.url==='/misreport'){healthy=false;res.end('failed');return;}if(req.url==='/api/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify(healthy?{status:'ok'}:{status:'unhealthy',error:'database_unreachable'}));return;}res.end('ok')}).listen(Number(process.env.PORT),'127.0.0.1')\"";
    const input = {
      actor: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-health",
      config: { workspaceRuntime: { services: [{
        name: "paperclip-dev",
        command: serviceCommand,
        cwd: ".",
        port: { type: "auto" as const },
        readiness: { type: "http" as const, urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 3, intervalMs: 100 },
        expose: { type: "url" as const, urlTemplate: "http://127.0.0.1:{{port}}" },
        lifecycle: "shared" as const,
        stopPolicy: { type: "manual" as const },
      }] } },
      adapterEnv: {},
    };
    try {
      const [first] = await startRuntimeServicesForWorkspaceControl(input);
      await expect(fetch(`${first!.url}/misreport`)).resolves.toMatchObject({ ok: true });
      await expect(fetch(`${first!.url}/api/health`)).resolves.toMatchObject({ ok: true });
      const [[replacement], [concurrentReuse]] = await Promise.all([
        startRuntimeServicesForWorkspaceControl(input),
        startRuntimeServicesForWorkspaceControl(input),
      ]);
      expect(replacement?.id).not.toBe(first?.id);
      expect(replacement?.reused).toBe(false);
      expect(concurrentReuse?.id).toBe(replacement?.id);
      expect(concurrentReuse?.reused).toBe(true);
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-health",
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("reuses a shared Paperclip dev runtime after one transient unhealthy response", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-transient-health-"));
    const workspace = buildWorkspace(workspaceRoot);
    const serviceCommand =
      "node -e \"let failNext=false;const http=require('node:http');http.createServer((req,res)=>{if(req.url==='/fail-next'){failNext=true;res.end('armed');return;}if(req.url==='/api/health'){res.setHeader('content-type','application/json');const healthy=!failNext;failNext=false;res.end(JSON.stringify({status:healthy?'ok':'unhealthy'}));return;}res.end('ok')}).listen(Number(process.env.PORT),'127.0.0.1')\"";
    const input = {
      actor: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-transient-health",
      config: { workspaceRuntime: { services: [{
        name: "paperclip-dev",
        command: serviceCommand,
        cwd: ".",
        port: { type: "auto" as const },
        readiness: { type: "http" as const, urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 3, intervalMs: 100 },
        expose: { type: "url" as const, urlTemplate: "http://127.0.0.1:{{port}}" },
        lifecycle: "shared" as const,
        stopPolicy: { type: "manual" as const },
      }] } },
      adapterEnv: {},
    };
    try {
      const [first] = await startRuntimeServicesForWorkspaceControl(input);
      await expect(fetch(`${first!.url}/fail-next`)).resolves.toMatchObject({ ok: true });
      const [reused] = await startRuntimeServicesForWorkspaceControl(input);
      expect(reused?.id).toBe(first?.id);
      expect(reused?.reused).toBe(true);
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-transient-health",
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects an unreachable exposed origin even when readiness uses a local probe", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-explicit-readiness-"));
    const workspace = buildWorkspace(workspaceRoot);
    const runId = "run-paperclip-explicit-readiness";
    const serviceCommand =
      "node -e \"const http=require('node:http'); http.createServer((req,res)=>{ if (req.url==='/api/health') { res.end('ok'); return; } res.statusCode=404; res.end('not found'); }).listen(Number(process.env.PORT), '127.0.0.1')\"";

    try {
      await expect(ensureRuntimeServicesForRun({
        runId,
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
        issue: null,
        workspace,
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
                  urlTemplate: "http://127.0.0.1:{{port}}/api/health",
                  timeoutSec: 3,
                  intervalMs: 100,
                },
                expose: {
                  type: "url",
                  urlTemplate: "http://not-a-real-paperclip-host.invalid:{{port}}",
                },
                lifecycle: "shared",
                stopPolicy: {
                  type: "manual",
                },
              },
            ],
          },
        },
        adapterEnv: {},
      })).rejects.toThrow(/internal-only or non-resolvable.*Configure PAPERCLIP_PUBLIC_URL or BETTER_AUTH_URL/);
    } finally {
      await releaseRuntimeServicesForRun(runId);
    }
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
    // A Paperclip dev runtime must answer `/api/health` semantically before it may
    // be published, so the fake serves the same shape a real one does.
    const serviceCommand =
      "node -e \"require('node:http').createServer((req,res)=>{if(req.url==='/api/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok'}));return;}res.end(process.env.PAPERCLIP_HOME)}).listen(Number(process.env.PORT), '127.0.0.1')\"";
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
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

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

  it("attributes a Windows listener to a descendant of the launched process", async () => {
    const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-windows-tools-"));
    const previousPath = process.env.PATH;
    const port = 43_123;
    const listenerPid = 43_210;
    const launchedPid = 32_000;
    await fs.writeFile(
      path.join(fakeBin, "netstat"),
      `#!/bin/sh\nprintf '  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    ${listenerPid}\\n'\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      path.join(fakeBin, "powershell.exe"),
      `#!/bin/sh\nprintf '${launchedPid}\\n'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      await expect(readLocalServicePortOwner(port)).resolves.toBe(listenerPid);
      await expect(isLocalServiceProcessOwnedBy(listenerPid, launchedPid)).resolves.toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(fakeBin, { recursive: true, force: true });
    }
  });

  it("accepts service cwd nested within the requested workspace", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-workspace-"));
    const serviceCwd = path.join(workspace, "server");
    await fs.mkdir(serviceCwd);

    await expect(isLocalServiceProcessInWorkspace(serviceCwd, workspace)).resolves.toBe(true);
  });

  it("preserves newlines and trailing whitespace from Darwin lsof cwd output", async () => {
    const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-lsof-tools-"));
    const previousPath = process.env.PATH;
    const reportedCwd = path.join(os.tmpdir(), "paperclip-runtime-line\nbreak ");
    const output = `p${process.pid}\0fcwd\0n${reportedCwd}\0\n`;
    await fs.writeFile(
      path.join(fakeBin, "lsof"),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`,
      { mode: 0o755 },
    );
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.PATH = fakeBin;

    try {
      await expect(readLocalServiceProcessCwd(process.pid)).resolves.toBe(reportedCwd);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(fakeBin, { recursive: true, force: true });
    }
  });

  it("returns null for invalid PIDs and a missing Darwin lsof binary", async () => {
    await expect(readLocalServiceProcessCwd(-1)).resolves.toBeNull();

    const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-missing-lsof-"));
    const previousPath = process.env.PATH;
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.PATH = fakeBin;

    try {
      await expect(readLocalServiceProcessCwd(process.pid)).resolves.toBeNull();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(fakeBin, { recursive: true, force: true });
    }
  });

  it("keeps a live registry record adoptable when Darwin cwd inspection confirms it", async () => {
    try {
      await execFileAsync("lsof", ["-v"]);
    } catch {
      return;
    }

    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    const serviceKey = `unsupported-cwd-${randomUUID()}`;
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `unsupported-cwd-${randomUUID()}`;
    expect(port).toBeTypeOf("number");

    try {
      await writeLocalServiceRegistryRecord({
        version: 1,
        serviceKey,
        profileKind: "workspace-runtime",
        serviceName: "node",
        command: "node",
        cwd: process.cwd(),
        envFingerprint: "",
        port,
        url: null,
        pid: process.pid,
        processGroupId: null,
        provider: "local_process",
        runtimeServiceId: null,
        reuseKey: null,
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        metadata: null,
      });
      Object.defineProperty(process, "platform", { value: "darwin" });

      await expect(findAdoptableLocalService({
        serviceKey,
        cwd: process.cwd(),
        port,
      })).resolves.toMatchObject({ pid: expect.any(Number), port });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });

  it("trusts unavailable cwd for registry records only on unsupported platforms", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    await expect(isLocalServiceRegistryCwdCompatible(null, process.cwd())).resolves.toBe(false);

    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(isLocalServiceRegistryCwdCompatible(null, process.cwd())).resolves.toBe(false);

    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(isLocalServiceRegistryCwdCompatible(null, process.cwd())).resolves.toBe(true);
  });

  it("refuses to adopt a listener whose real cwd belongs to another workspace", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    try {
      await execFileAsync("lsof", ["-v"]);
    } catch {
      return;
    }

    const targetWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-target-"));
    const ownerWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-owner-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `cross-workspace-${randomUUID()}`;
    const serviceKey = `cross-workspace-${randomUUID()}`;
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const server=require('node:http').createServer((req,res)=>res.end('ok')); server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
      ],
      { cwd: ownerWorkspace, stdio: ["ignore", "pipe", "inherit"] },
    );
    const port = await new Promise<number>((resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        const value = Number.parseInt(output.trim(), 10);
        if (Number.isInteger(value) && value > 0) resolve(value);
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Port owner exited before listening: ${code ?? "unknown"}`)));
    });

    try {
      await expect(findAdoptableLocalService({
        serviceKey,
        serviceName: "node",
        command: "node",
        cwd: targetWorkspace,
        port,
      })).resolves.toBeNull();

      await writeLocalServiceRegistryRecord({
        version: 1,
        serviceKey,
        profileKind: "workspace-runtime",
        serviceName: "node",
        command: "node",
        cwd: targetWorkspace,
        envFingerprint: "",
        port,
        url: null,
        pid: child.pid!,
        processGroupId: null,
        provider: "local_process",
        runtimeServiceId: null,
        reuseKey: null,
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        metadata: null,
      });
      await expect(findAdoptableLocalService({
        serviceKey,
        serviceName: "node",
        command: "node",
        cwd: targetWorkspace,
        port,
      })).resolves.toBeNull();

      await expect(startRuntimeServicesForWorkspaceControl({
        actor: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
        issue: null,
        workspace: buildWorkspace(targetWorkspace),
        config: {
          workspaceRuntime: {
            services: [{
              name: "web",
              command: "node",
              cwd: ".",
              port,
              lifecycle: "shared",
            }],
          },
        },
        adapterEnv: {},
      })).rejects.toThrow(new RegExp(`cross-workspace port conflict.*pid ${child.pid}.*${ownerWorkspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  });

  it("adopts a port owner running inside the workspace when the registry record is gone", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    try {
      await execFileAsync("lsof", ["-v"]);
    } catch {
      return;
    }

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-adopt-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `adopt-port-owner-${randomUUID()}`;
    const serviceKey = `adopt-port-owner-${randomUUID()}`;
    // Detach, because managed runtime services also start detached
    // (`detached: process.platform !== "win32"`). An attached child shares the
    // runner's process group, so adoption would record the group leader — pnpm
    // or a shell — and the command check would read that leader instead.
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const server=require('node:http').createServer((req,res)=>res.end('ok')); server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
      ],
      { cwd: workspace, stdio: ["ignore", "pipe", "inherit"], detached: true },
    );
    const port = await new Promise<number>((resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        const value = Number.parseInt(output.trim(), 10);
        if (Number.isInteger(value) && value > 0) resolve(value);
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Port owner exited before listening: ${code ?? "unknown"}`)));
    });

    try {
      // No registry record is written: this is the "registry lost, service still
      // running" path that falls through to adoptLocalServiceFromPortOwner.
      await expect(findAdoptableLocalService({
        serviceKey,
        serviceName: "node",
        command: "node",
        cwd: workspace,
        port,
      })).resolves.toMatchObject({ pid: expect.any(Number), port });
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("refuses to adopt a listener whose cwd differs only by trailing whitespace", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    try {
      await execFileAsync("lsof", ["-v"]);
    } catch {
      return;
    }

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-ws-"));
    // A sibling directory whose name is the workspace name plus one space.
    // These are different directories, so a listener in one must not be
    // adopted into the other.
    const lookalike = `${workspace} `;
    await fs.mkdir(lookalike, { recursive: true });
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `adopt-whitespace-${randomUUID()}`;
    const serviceKey = `adopt-whitespace-${randomUUID()}`;
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const server=require('node:http').createServer((req,res)=>res.end('ok')); server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
      ],
      { cwd: lookalike, stdio: ["ignore", "pipe", "inherit"], detached: true },
    );
    const port = await new Promise<number>((resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        const value = Number.parseInt(output.trim(), 10);
        if (Number.isInteger(value) && value > 0) resolve(value);
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Port owner exited before listening: ${code ?? "unknown"}`)));
    });

    try {
      await expect(findAdoptableLocalService({
        serviceKey,
        serviceName: "node",
        command: "node",
        cwd: workspace,
        port,
      })).resolves.toBeNull();
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(lookalike, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describeEmbeddedPostgres("workspace dirty quarantine branch repair", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-dirty-quarantine-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(workspaceRuntimeServices);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function createDirtyMismatchRepo(input: {
    expectedBranch: string;
    actualBranch: string;
  }) {
    const repoRoot = await createTempRepo();
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", input.expectedBranch);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", input.expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", input.actualBranch, worktreePath, input.expectedBranch]);
    const actualBranchHead = await readGit(worktreePath, ["rev-parse", input.actualBranch]);
    await fs.appendFile(path.join(worktreePath, "README.md"), "dirty tracked work\n", "utf8");
    await fs.writeFile(path.join(worktreePath, "untracked.txt"), "dirty untracked work\n", "utf8");
    return { repoRoot, worktreePath, actualBranchHead };
  }

  async function seedDirtyQuarantineRecords(input: {
    repoRoot: string;
    worktreePath: string;
    expectedBranch: string;
    actualBranch: string;
    sourceIdentifier?: string;
    claimant?: "idle" | "active" | "none";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const sourceIssueId = randomUUID();
    const sourceWorkspaceId = randomUUID();
    const runId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: input.repoRoot,
      isPrimary: true,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: now,
      updatedAt: now,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Repair dirty branch mismatch",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      identifier: input.sourceIdentifier ?? "PAP-455",
    });
    await db.insert(executionWorkspaces).values({
      id: sourceWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: input.expectedBranch,
      status: "active",
      cwd: input.worktreePath,
      providerRef: input.worktreePath,
      baseRef: "HEAD",
      branchName: input.expectedBranch,
      providerType: "git_worktree",
      lastUsedAt: now,
      updatedAt: now,
    });
    await db
      .update(issues)
      .set({ executionWorkspaceId: sourceWorkspaceId, executionRunId: runId, updatedAt: now })
      .where(eq(issues.id, sourceIssueId));

    let claimant:
      | {
        issueId: string;
        workspaceId: string;
        runId: string | null;
        identifier: string;
      }
      | null = null;
    if (input.claimant && input.claimant !== "none") {
      const claimantIssueId = randomUUID();
      const claimantWorkspaceId = randomUUID();
      const claimantRunId = input.claimant === "active" ? randomUUID() : null;
      const claimantIdentifier = "PAP-999";
      await db.insert(issues).values({
        id: claimantIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Live branch claimant",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        identifier: claimantIdentifier,
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
      await db.insert(executionWorkspaces).values({
        id: claimantWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        sourceIssueId: claimantIssueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: input.actualBranch,
        status: "active",
        cwd: path.join(input.repoRoot, ".paperclip", "claimants", claimantWorkspaceId),
        providerRef: path.join(input.repoRoot, ".paperclip", "claimants", claimantWorkspaceId),
        baseRef: "HEAD",
        branchName: input.actualBranch,
        providerType: "git_worktree",
        lastUsedAt: new Date(now.getTime() + 1_000),
        updatedAt: new Date(now.getTime() + 1_000),
      });
      await db
        .update(issues)
        .set({
          executionWorkspaceId: claimantWorkspaceId,
          executionRunId: claimantRunId,
          updatedAt: now,
        })
        .where(eq(issues.id, claimantIssueId));
      claimant = {
        issueId: claimantIssueId,
        workspaceId: claimantWorkspaceId,
        runId: claimantRunId,
        identifier: claimantIdentifier,
      };
    }

    return {
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
      sourceIssueId,
      sourceWorkspaceId,
      runId,
      claimant,
      sourceIdentifier: input.sourceIdentifier ?? "PAP-455",
    };
  }

  async function restoreDirtyQuarantine(input: {
    repoRoot: string;
    worktreePath: string;
    expectedBranch: string;
    actualBranch: string;
    ids: Awaited<ReturnType<typeof seedDirtyQuarantineRecords>>;
    recorder?: WorkspaceOperationRecorder | null;
  }) {
    return ensurePersistedExecutionWorkspaceAvailable({
      db,
      base: {
        baseCwd: input.repoRoot,
        source: "project_primary",
        projectId: input.ids.projectId,
        workspaceId: input.ids.projectWorkspaceId,
        repoUrl: null,
        repoRef: "HEAD",
      },
      workspace: {
        id: input.ids.sourceWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: input.worktreePath,
        providerRef: input.worktreePath,
        projectId: input.ids.projectId,
        projectWorkspaceId: input.ids.projectWorkspaceId,
        repoUrl: null,
        baseRef: "HEAD",
        branchName: input.expectedBranch,
        metadata: RUNTIME_OWNED_GIT_BRANCH_METADATA,
      },
      issue: {
        id: input.ids.sourceIssueId,
        identifier: input.ids.sourceIdentifier,
        title: "Repair dirty branch mismatch",
      },
      agent: {
        id: input.ids.agentId,
        name: "Codex Coder",
        companyId: input.ids.companyId,
      },
      heartbeatRunId: input.ids.runId,
      enableWorkspaceBranchReconcileForward: true,
      enableWorkspaceDirtyQuarantineRepair: true,
      recorder: input.recorder ?? null,
    });
  }

  it("quarantines dirty foreign-branch work into a rescue branch before restoring the recorded branch", async () => {
    const expectedBranch = "PAP-455-recorded";
    const actualBranch = "PAP-455-live";
    const { repoRoot, worktreePath, actualBranchHead } = await createDirtyMismatchRepo({
      expectedBranch,
      actualBranch,
    });
    const ids = await seedDirtyQuarantineRecords({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-455",
      claimant: "none",
    });
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const restored = await restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      ids,
      recorder,
    });

    expect(restored?.branchName).toBe(expectedBranch);
    const warning = restored?.warnings.find((entry) => entry.includes("dirty worktree state was quarantined"));
    expect(warning).toBeTruthy();
    const rescueBranch = warning?.match(/"([^"]+)"/)?.[1] ?? "";
    expect(rescueBranch).toMatch(/^paperclip\/rescue\/PAP-455\/\d{8}T\d{6}Z$/);
    const rescueCommitSha = await readGit(repoRoot, ["rev-parse", rescueBranch]);
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.toBe("");
    await expect(readGit(repoRoot, ["rev-parse", actualBranch])).resolves.toBe(actualBranchHead);
    await expect(readGit(repoRoot, ["show", `${rescueBranch}:untracked.txt`])).resolves.toBe("dirty untracked work");

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.companyId, ids.companyId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.issueId).toBe(ids.sourceIssueId);
    expect(comments[0]?.body).toContain(`Rescue branch: \`${rescueBranch}\``);
    expect(comments[0]?.body).toContain(`Rescue commit: \`${rescueCommitSha}\``);
    expect(comments[0]?.body).toContain("Dirty file count: `2`");
    expect(comments[0]?.body).toContain("`untracked.txt`");
    expect(comments[0]?.body).toContain("- Claimant: none");

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, ids.companyId));
    expect(activityRows).toEqual([
      expect.objectContaining({
        action: "execution_workspace.dirty_worktree_quarantined",
        entityType: "execution_workspace",
        entityId: ids.sourceWorkspaceId,
        details: expect.objectContaining({
          rescueBranch,
          rescueCommitSha,
          fileCount: 2,
          dirtyPathSample: expect.arrayContaining(["README.md", "untracked.txt"]),
        }),
      }),
    ]);
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: `git checkout -b ${rescueBranch}`,
        metadata: expect.objectContaining({
          branchIncoherenceDirtyQuarantineRepair: true,
          rescueBranch,
          fileCount: 2,
        }),
      }),
      expect.objectContaining({
        command: null,
        metadata: expect.objectContaining({
          branchIncoherenceDirtyQuarantineRepair: true,
          rescueBranch,
          rescueCommitSha,
        }),
      }),
    ]));
  }, 20_000);

  it("quarantines a worktree wedged mid-rebase and clears the interrupted rebase state", async () => {
    const expectedBranch = "PAP-456-recorded";
    const repoRoot = await createTempRepo("master");
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, expectedBranch]);
    await fs.writeFile(path.join(worktreePath, "README.md"), "feature change\n", "utf8");
    await runGit(worktreePath, ["commit", "-am", "Feature change"]);
    const expectedBranchHead = await readGit(worktreePath, ["rev-parse", expectedBranch]);
    await fs.writeFile(path.join(repoRoot, "README.md"), "master change\n", "utf8");
    await runGit(repoRoot, ["commit", "-am", "Master change"]);
    await expect(runGit(worktreePath, ["rebase", "master"])).rejects.toThrow();
    const rebaseStatePath = await readGit(worktreePath, ["rev-parse", "--git-path", "rebase-merge"]);
    expect(existsSync(path.resolve(worktreePath, rebaseStatePath))).toBe(true);
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe("");

    const ids = await seedDirtyQuarantineRecords({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch: "PAP-456-live",
      sourceIdentifier: "PAP-456",
      claimant: "none",
    });
    const { recorder } = createWorkspaceOperationRecorderDouble();

    const restored = await restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch: "PAP-456-live",
      ids,
      recorder,
    });

    expect(restored?.branchName).toBe(expectedBranch);
    const warning = restored?.warnings.find((entry) => entry.includes("dirty worktree state was quarantined"));
    expect(warning).toContain("An interrupted git rebase was also cleared");
    const rescueBranch = warning?.match(/"([^"]+)"/)?.[1] ?? "";
    expect(rescueBranch).toMatch(/^paperclip\/rescue\/PAP-456\/\d{8}T\d{6}Z$/);

    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.toBe("");
    expect(existsSync(path.resolve(worktreePath, rebaseStatePath))).toBe(false);
    await expect(readGit(repoRoot, ["rev-parse", expectedBranch])).resolves.toBe(expectedBranchHead);
    await expect(readGit(repoRoot, ["show", `${rescueBranch}:README.md`])).resolves.toContain("<<<<<<<");

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.companyId, ids.companyId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("Interrupted operation: `git rebase`");
  }, 20_000);

  it("refuses dirty quarantine repair when the live branch has an active claimant", async () => {
    const expectedBranch = "PAP-456-recorded";
    const actualBranch = "PAP-456-live";
    const { repoRoot, worktreePath } = await createDirtyMismatchRepo({ expectedBranch, actualBranch });
    const ids = await seedDirtyQuarantineRecords({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-456",
      claimant: "active",
    });

    await expect(restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      ids,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          cleanliness: "dirty",
          dirtyPathSample: expect.arrayContaining(["README.md", "untracked.txt"]),
          contention: expect.objectContaining({
            claimedByWorkspaceId: ids.claimant!.workspaceId,
            claimedByIssueIdentifier: ids.claimant!.identifier,
            activeRun: expect.objectContaining({
              id: ids.claimant!.runId,
              status: "running",
              issueIdentifier: ids.claimant!.identifier,
            }),
          }),
          safeRepair: expect.objectContaining({
            eligible: false,
            succeeded: false,
            reason: expect.stringContaining("active run"),
          }),
        }),
      },
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.not.toBe("");
  }, 20_000);

  it("refuses dirty quarantine repair when the live branch has an idle claimant", async () => {
    const expectedBranch = "PAP-457-recorded";
    const actualBranch = "PAP-457-live";
    const { repoRoot, worktreePath } = await createDirtyMismatchRepo({ expectedBranch, actualBranch });
    const ids = await seedDirtyQuarantineRecords({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-457",
      claimant: "idle",
    });

    await expect(restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      ids,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          cleanliness: "dirty",
          dirtyPathSample: expect.arrayContaining(["README.md", "untracked.txt"]),
          contention: expect.objectContaining({
            claimedByWorkspaceId: ids.claimant!.workspaceId,
            claimedByIssueIdentifier: ids.claimant!.identifier,
            activeRun: null,
          }),
          safeRepair: expect.objectContaining({
            eligible: false,
            succeeded: false,
            reason: expect.stringContaining("no active run"),
          }),
        }),
      },
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.not.toBe("");
  }, 20_000);

  it("refuses dirty quarantine repair while the execution workspace has an active runtime service", async () => {
    const expectedBranch = "PAP-458-recorded";
    const actualBranch = "PAP-458-live";
    const { repoRoot, worktreePath } = await createDirtyMismatchRepo({ expectedBranch, actualBranch });
    const ids = await seedDirtyQuarantineRecords({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-458",
      claimant: "none",
    });
    const runtimeServiceId = randomUUID();
    await db.insert(workspaceRuntimeServices).values({
      id: runtimeServiceId,
      companyId: ids.companyId,
      projectId: ids.projectId,
      projectWorkspaceId: ids.projectWorkspaceId,
      executionWorkspaceId: ids.sourceWorkspaceId,
      issueId: ids.sourceIssueId,
      scopeType: "execution_workspace",
      scopeId: ids.sourceWorkspaceId,
      serviceName: "paperclip-dev",
      status: "running",
      lifecycle: "shared",
      reuseKey: `execution_workspace:${ids.sourceWorkspaceId}:paperclip-dev`,
      command: "pnpm dev",
      cwd: worktreePath,
      port: 49195,
      url: "http://127.0.0.1:49195",
      provider: "local_process",
      providerRef: "999999",
      ownerAgentId: ids.agentId,
      startedByRunId: ids.runId,
      lastUsedAt: new Date(),
      startedAt: new Date(),
      stoppedAt: null,
      stopPolicy: { type: "manual" },
      healthStatus: "healthy",
    });

    await expect(restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      ids,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          cleanliness: "dirty",
          safeRepair: expect.objectContaining({
            eligible: false,
            attempted: false,
            succeeded: false,
            reason: expect.stringContaining("runtime service"),
          }),
        }),
      },
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.not.toBe("");
    await expect(readGit(repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/paperclip/rescue",
    ])).resolves.toBe("");
  }, 20_000);

  it("falls back to validation failure when git reports index-lock contention during quarantine", async () => {
    const expectedBranch = "PAP-459-recorded";
    const actualBranch = "PAP-459-live";
    const { repoRoot, worktreePath } = await createDirtyMismatchRepo({ expectedBranch, actualBranch });
    const ids = await seedDirtyQuarantineRecords({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-459",
      claimant: "none",
    });
    const lockPath = await readGit(worktreePath, ["rev-parse", "--git-path", "index.lock"]);
    await fs.writeFile(lockPath, "locked\n", "utf8");
    try {
      await expect(restoreDirtyQuarantine({
        repoRoot,
        worktreePath,
        expectedBranch,
        actualBranch,
        ids,
      })).rejects.toMatchObject({
        code: "workspace_validation_failed",
        resultJson: {
          workspaceValidation: expect.objectContaining({
            cleanliness: "dirty",
            safeRepair: expect.objectContaining({
              attempted: true,
              succeeded: false,
              reason: expect.stringContaining("index contention"),
            }),
          }),
        },
      });
    } finally {
      await fs.rm(lockPath, { force: true });
    }
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(actualBranch);
  }, 20_000);

  it("best-effort restores the recorded branch when the rescue commit fails", async () => {
    const expectedBranch = "PAP-460-recorded";
    const actualBranch = "PAP-460-live";
    const { repoRoot, worktreePath } = await createDirtyMismatchRepo({ expectedBranch, actualBranch });
    const ids = await seedDirtyQuarantineRecords({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      sourceIdentifier: "PAP-460",
      claimant: "none",
    });
    const commonDirRaw = await readGit(worktreePath, ["rev-parse", "--git-common-dir"]);
    const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(worktreePath, commonDirRaw);
    const hookPath = path.join(commonDir, "hooks", "commit-msg");
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(hookPath, "#!/bin/sh\necho rescue commit blocked >&2\nexit 1\n", { mode: 0o755 });

    await expect(restoreDirtyQuarantine({
      repoRoot,
      worktreePath,
      expectedBranch,
      actualBranch,
      ids,
    })).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          safeRepair: expect.objectContaining({
            attempted: true,
            succeeded: false,
            reason: expect.stringContaining("rescue commit blocked"),
          }),
        }),
      },
    });
    await expect(readGit(worktreePath, ["branch", "--show-current"])).resolves.toBe(expectedBranch);
    await expect(readGit(worktreePath, ["status", "--porcelain", "--untracked-files=all"])).resolves.not.toBe("");
  }, 20_000);
});

describeEmbeddedPostgres("workspace runtime service control persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-runtime-control-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    // Terminate the real child processes this block starts and persist their
    // stopped rows before the row deletes below. A left-over child exits later
    // and its detached exit handler then writes a workspace_runtime_services row
    // that references the deleted project, which raises an unhandled foreign-key
    // error in the next test.
    await resetRuntimeServicesForTests({ terminateProcesses: true });
    // Service control writes activity_log rows. Delete them before the company
    // delete so a lingering foreign-key row cannot block the company delete and
    // leak rows into the next test.
    await db.delete(activityLog);
    await db.delete(workspaceRuntimeServices);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  it("persists provisioning before starting and excludes provision time from readiness timeout", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-slow-control-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-control-home-"));
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `runtime-control-${randomUUID()}`;

    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const provisionMarkerPath = path.join(workspaceRoot, "runtime-provisioning.marker");
    const markerPath = path.join(workspaceRoot, "runtime-spawned.marker");
    const provisionScript = [
      `require("node:fs").writeFileSync(${JSON.stringify(provisionMarkerPath)}, "provisioning");`,
      "setTimeout(() => {}, 1200);",
    ].join(" ");
    const runtimeProvisionCommand =
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(provisionScript)}`;
    const serverScript = [
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "spawned");`,
      "setTimeout(() => {",
      "  require(\"node:http\")",
      "    .createServer((_req, res) => { res.end(\"ok\"); })",
      "    .listen(Number(process.env.PORT), \"127.0.0.1\");",
      "}, 100);",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(serverScript)}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Runtime control",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: workspaceRoot,
      isPrimary: true,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Source task",
      status: "in_progress",
      priority: "high",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Runtime control workspace",
      status: "active",
      providerType: "git_worktree",
      cwd: workspaceRoot,
      providerRef: workspaceRoot,
      branchName: "feature/runtime-control",
      baseRef: "main",
    });

    const waitForMarker = async (filePath: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (existsSync(filePath)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("Timed out waiting for runtime service process marker");
    };
    const waitForPersistedStatus = async (status: string) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const row = await db
          .select()
          .from(workspaceRuntimeServices)
          .where(eq(workspaceRuntimeServices.executionWorkspaceId, executionWorkspaceId))
          .then((rows) => rows[0] ?? null);
        if (row?.status === status) return row;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out waiting for persisted runtime service status ${status}`);
    };

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
        baseCwd: workspaceRoot,
        source: "task_session",
        projectId,
        workspaceId: projectWorkspaceId,
        repoUrl: null,
        repoRef: "main",
        strategy: "git_worktree",
        cwd: workspaceRoot,
        branchName: "feature/runtime-control",
        worktreePath: workspaceRoot,
        warnings: [],
        created: false,
      },
      executionWorkspaceId,
      config: {
        runtimeProvisionCommand,
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command,
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              port: { type: "auto", envKey: "PORT" },
              expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
              readiness: { type: "http", intervalMs: 50, timeoutSec: 1 },
              stopPolicy: { type: "manual" },
            },
          ],
        },
      },
      adapterEnv: {},
    });
    startPromise.catch(() => undefined);

    try {
      await waitForMarker(provisionMarkerPath);
      const provisioningRow = await waitForPersistedStatus("provisioning");
      expect(provisioningRow).toMatchObject({
        executionWorkspaceId,
        serviceName: "web",
        status: "provisioning",
        providerRef: null,
      });
      expect(existsSync(markerPath)).toBe(false);

      await waitForMarker(markerPath);
      const startingRow = await waitForPersistedStatus("starting");
      expect(startingRow).toMatchObject({
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId,
        issueId,
        serviceName: "web",
        status: "starting",
        healthStatus: "unknown",
      });
      expect(startingRow.providerRef).toMatch(/^\d+$/);
      expect(startingRow.port).toEqual(expect.any(Number));

      const services = await startPromise;
      expect(services).toHaveLength(1);
      expect(services[0]).toMatchObject({
        id: startingRow.id,
        status: "running",
        healthStatus: "healthy",
      });

      const runningRow = await waitForPersistedStatus("running");
      expect(runningRow.id).toBe(startingRow.id);
      await expect(fetch(services[0]!.url!)).resolves.toMatchObject({ ok: true });
      const runtimeProvisionOperations = await db
        .select()
        .from(workspaceOperations)
        .where(eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId));
      expect(runtimeProvisionOperations).toEqual([
        expect.objectContaining({
          phase: "workspace_runtime_provision",
          status: "succeeded",
          command: runtimeProvisionCommand,
        }),
      ]);
    } finally {
      await startPromise.catch(() => undefined);
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId,
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(paperclipHome, { recursive: true, force: true });
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
    }
  }, 15_000);

  async function createRuntimeFixture(input?: {
    companyId?: string;
    workspaceModes?: Array<"isolated_workspace" | "shared_workspace">;
  }) {
    const companyId = input?.companyId ?? randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const baseRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-port-fixture-"));
    const workspaceModes = input?.workspaceModes ?? ["isolated_workspace"];
    const workspaceRows = await Promise.all(workspaceModes.map(async (mode, index) => {
      const cwd = await fs.mkdtemp(path.join(baseRoot, `workspace-${index}-`));
      return {
        id: randomUUID(),
        cwd,
        mode,
      };
    }));

    await db.insert(companies).values({
      id: companyId,
      name: `Runtime ports ${companyId.slice(0, 8)}`,
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runtime Port Agent",
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
      name: "Runtime port allocation",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: baseRoot,
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values(workspaceRows.map((workspace, index) => ({
      id: workspace.id,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: workspace.mode,
      strategyType: workspace.mode === "isolated_workspace" ? "git_worktree" : "project_primary",
      name: `Runtime workspace ${index + 1}`,
      status: "active",
      providerType: "local_fs",
      cwd: workspace.cwd,
      providerRef: workspace.cwd,
    })));

    const realizedWorkspace = (workspace: typeof workspaceRows[number]): RealizedExecutionWorkspace => ({
      baseCwd: baseRoot,
      source: "task_session",
      projectId,
      workspaceId: projectWorkspaceId,
      repoUrl: null,
      repoRef: "HEAD",
      strategy: workspace.mode === "isolated_workspace" ? "git_worktree" : "project_primary",
      cwd: workspace.cwd,
      branchName: null,
      worktreePath: workspace.mode === "isolated_workspace" ? workspace.cwd : null,
      warnings: [],
      created: false,
    });

    return {
      companyId,
      agentId,
      projectId,
      projectWorkspaceId,
      workspaces: workspaceRows,
      actor: { id: agentId, name: "Runtime Port Agent", companyId },
      realizedWorkspace,
      cleanup: async () => await fs.rm(baseRoot, { recursive: true, force: true }),
    };
  }

  function fixedPortRuntimeConfig(port: number, command?: string) {
    const serverCommand = command ?? [
      JSON.stringify(process.execPath),
      "-e",
      JSON.stringify(
        "require('node:http').createServer((_req,res)=>res.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')",
      ),
    ].join(" ");
    return {
      workspaceRuntime: {
        services: [{
          name: "web",
          command: serverCommand,
          port: { type: "fixed", value: port, envKey: "PORT" },
          readiness: {
            type: "http",
            urlTemplate: "http://127.0.0.1:{{port}}",
            timeoutSec: 5,
            intervalMs: 25,
          },
          expose: { type: "url", urlTemplate: "http://127.0.0.1:{{port}}" },
          lifecycle: "shared",
          reuseScope: "execution_workspace",
          stopPolicy: { type: "manual" },
        }],
      },
    };
  }

  async function createRuntimeHome() {
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-port-home-"));
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `runtime-ports-${randomUUID()}`;
    return async () => {
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      await fs.rm(paperclipHome, { recursive: true, force: true });
    };
  }

  async function isLoopbackPortFree(port: number) {
    const probe = net.createServer();
    return await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => {
        probe.close(() => resolve(true));
      });
    });
  }

  function httpsRuntimeConfig(command: string) {
    return {
      workspaceRuntime: {
        services: [{
          name: "paperclip-dev",
          command,
          env: { PAPERCLIP_PUBLIC_URL: "http://127.0.0.1:3100" },
          port: { type: "fixed", value: 45_439, envKey: "PORT" },
          readiness: {
            type: "http",
            urlTemplate: "http://127.0.0.1:{{port}}",
            timeoutSec: 5,
            intervalMs: 25,
          },
          expose: {
            type: "tailscale_https",
            hostname: "auto",
            publicPort: "same",
            includePaperclipViteHmr: true,
            failurePolicy: "fail_closed",
          },
          lifecycle: "shared",
          reuseScope: "execution_workspace",
          stopPolicy: { type: "manual" },
        }],
      },
    };
  }

  it("waits for every managed process-tree listener before requesting HTTPS exposure", async () => {
    const fixture = await createRuntimeFixture();
    const cleanupRuntimeHome = await createRuntimeHome();
    const workspace = fixture.workspaces[0]!;
    const delayedHmrScript = [
      "const http=require('node:http');",
      "const port=Number(process.env.PORT);",
      "http.createServer((req,res)=>{if(req.url==='/api/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok'}));return;}res.end('ok')}).listen(port,'127.0.0.1');",
      "setTimeout(()=>http.createServer((_req,res)=>res.end('hmr')).listen(port+10000,'127.0.0.1'),750);",
      "setInterval(()=>{},1000);",
    ].join("");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(delayedHmrScript)}`;
    let reservedListeners: Array<{ purpose: "app" | "vite_hmr"; port: number }> = [];
    let exposeCalls = 0;
    const broker = {
      async reserve(_runtimeId: string, listeners: Array<{ purpose: "app" | "vite_hmr"; port: number }>) {
        reservedListeners = listeners.map((listener) => ({ ...listener }));
        return {
          handle: "managed-listener-handle-1234",
          reservedPorts: listeners.map((listener) => listener.port),
        };
      },
      async expose(_runtimeId: string, handle: string) {
        exposeCalls += 1;
        const owners = await Promise.all(
          reservedListeners.map((listener) => readLocalServicePortOwner(listener.port)),
        );
        if (owners.some((owner) => owner === null)) {
          throw new Error("listener_ownership_mismatch");
        }
        return {
          handle,
          publicPorts: reservedListeners.map((listener) => listener.port),
        };
      },
      async remove() {
        return { removedPorts: reservedListeners.map((listener) => listener.port) };
      },
      async list() {
        return [];
      },
    };
    setWorkspaceRuntimeExposureDepsForTests({
      broker,
      isPortAvailable: isLoopbackPortFree,
      isBrokerAvailable: async () => true,
      resolveHostname: async () => "runner.tail123.ts.net",
      probeHealth: async () => true,
      now: () => new Date().toISOString(),
    });

    try {
      const started = (await startRuntimeServicesForWorkspaceControl({
        db,
        actor: fixture.actor,
        issue: null,
        workspace: fixture.realizedWorkspace(workspace),
        executionWorkspaceId: workspace.id,
        config: httpsRuntimeConfig(command),
        adapterEnv: {},
      }))[0]!;

      expect(exposeCalls).toBe(1);
      expect(reservedListeners.map((listener) => listener.port)).toEqual([
        started.port,
        deriveViteHmrPort(started.port!),
      ]);
      expect(started).toMatchObject({
        status: "running",
        healthStatus: "healthy",
        url: `https://runner.tail123.ts.net:${started.port}`,
        exposure: { state: "ready" },
      });
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId: workspace.id,
        workspaceCwd: workspace.cwd,
      }).catch(() => undefined);
      await resetRuntimeServicesForTests({ terminateProcesses: true });
      await cleanupRuntimeHome();
      await fixture.cleanup();
    }
  }, 15_000);

  it("rejects a foreign listener that races onto a reserved HTTPS companion port", async () => {
    const fixture = await createRuntimeFixture();
    const cleanupRuntimeHome = await createRuntimeHome();
    const workspace = fixture.workspaces[0]!;
    const appOnlyScript = [
      "const http=require('node:http');",
      "http.createServer((_req,res)=>res.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');",
      "setInterval(()=>{},1000);",
    ].join("");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(appOnlyScript)}`;
    let foreignHmr: net.Server | null = null;
    let exposeCalls = 0;
    let reservedPorts: number[] = [];
    const broker = {
      async reserve(_runtimeId: string, listeners: Array<{ purpose: "app" | "vite_hmr"; port: number }>) {
        reservedPorts = listeners.map((listener) => listener.port);
        const hmrPort = listeners.find((listener) => listener.purpose === "vite_hmr")!.port;
        foreignHmr = net.createServer((socket) => socket.destroy());
        await new Promise<void>((resolve, reject) => {
          foreignHmr!.once("error", reject);
          foreignHmr!.listen(hmrPort, "127.0.0.1", resolve);
        });
        return { handle: "foreign-listener-handle-1234", reservedPorts };
      },
      async expose(_runtimeId: string, handle: string) {
        exposeCalls += 1;
        return { handle, publicPorts: reservedPorts };
      },
      async remove() {
        return { removedPorts: reservedPorts };
      },
      async list() {
        return [];
      },
    };
    setWorkspaceRuntimeExposureDepsForTests({
      broker,
      isPortAvailable: isLoopbackPortFree,
      isBrokerAvailable: async () => true,
      resolveHostname: async () => "runner.tail123.ts.net",
      probeHealth: async () => true,
      now: () => new Date().toISOString(),
    });

    try {
      await expect(startRuntimeServicesForWorkspaceControl({
        db,
        actor: fixture.actor,
        issue: null,
        workspace: fixture.realizedWorkspace(workspace),
        executionWorkspaceId: workspace.id,
        config: httpsRuntimeConfig(command),
        adapterEnv: {},
      })).rejects.toThrow(/could not bind allocated port/);
      expect(exposeCalls).toBe(0);
    } finally {
      if (foreignHmr) {
        await new Promise<void>((resolve) => foreignHmr!.close(() => resolve()));
      }
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId: workspace.id,
        workspaceCwd: workspace.cwd,
      }).catch(() => undefined);
      await resetRuntimeServicesForTests({ terminateProcesses: true });
      await cleanupRuntimeHome();
      await fixture.cleanup();
    }
  }, 15_000);

  it("allocates distinct persisted ports for concurrent isolated siblings without stopping either service", async () => {
    const fixture = await createRuntimeFixture({
      workspaceModes: ["isolated_workspace", "isolated_workspace"],
    });
    const cleanupRuntimeHome = await createRuntimeHome();
    const basePort = await findFreePort();
    const config = fixedPortRuntimeConfig(basePort);
    const startedWorkspaceIds: string[] = [];

    try {
      const [first, second] = await Promise.all(fixture.workspaces.map(async (workspace) => {
        const result = await startRuntimeServicesForWorkspaceControl({
          db,
          actor: fixture.actor,
          issue: null,
          workspace: fixture.realizedWorkspace(workspace),
          executionWorkspaceId: workspace.id,
          config,
          adapterEnv: {},
        });
        startedWorkspaceIds.push(workspace.id);
        return result[0]!;
      }));

      // The two lanes claim ports concurrently in-process. The allocator guarantees
      // distinct ports, but not which lane wins the base port. It depends on the
      // scheduling order. So assert order-independent invariants, not array index.
      const lowerPort = Math.min(first.port!, second.port!);
      const upperPort = Math.max(first.port!, second.port!);
      const maxAllocatablePort = basePort + WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS - 1;
      expect(first.port).not.toBe(second.port);
      expect(lowerPort).toBe(basePort);
      expect(upperPort).toBeGreaterThan(basePort);
      expect(upperPort).toBeLessThanOrEqual(maxAllocatablePort);
      expect(first.url).toBe(`http://127.0.0.1:${first.port}`);
      expect(second.url).toBe(`http://127.0.0.1:${second.port}`);
      await expect(fetch(first.url!)).resolves.toMatchObject({ ok: true });
      await expect(fetch(second.url!)).resolves.toMatchObject({ ok: true });

      const persisted = await db
        .select()
        .from(workspaceRuntimeServices)
        .where(eq(workspaceRuntimeServices.companyId, fixture.companyId));
      expect(persisted).toEqual(expect.arrayContaining([
        expect.objectContaining({
          executionWorkspaceId: fixture.workspaces[0]!.id,
          port: first.port,
          url: first.url,
          status: "running",
        }),
        expect.objectContaining({
          executionWorkspaceId: fixture.workspaces[1]!.id,
          port: second.port,
          url: second.url,
          status: "running",
        }),
      ]));
    } finally {
      await Promise.all(startedWorkspaceIds.map(async (executionWorkspaceId) => {
        const workspace = fixture.workspaces.find((entry) => entry.id === executionWorkspaceId)!;
        await stopRuntimeServicesForExecutionWorkspace({
          db,
          executionWorkspaceId,
          workspaceCwd: workspace.cwd,
        }).catch(() => undefined);
      }));
      await cleanupRuntimeHome();
      await fixture.cleanup();
    }
  }, 20_000);

  it("commits fixed-port reservations before readiness windows longer than 60 seconds", async () => {
    const fixture = await createRuntimeFixture();
    const cleanupRuntimeHome = await createRuntimeHome();
    const workspace = fixture.workspaces[0]!;
    const basePort = await findFreePort();
    const spawnedMarkerPath = path.join(workspace.cwd, "slow-readiness-spawned.marker");
    const releaseMarkerPath = path.join(workspace.cwd, "slow-readiness-release.marker");
    const serverScript = [
      "const fs=require('node:fs');",
      "const http=require('node:http');",
      `const spawned=${JSON.stringify(spawnedMarkerPath)};`,
      `const release=${JSON.stringify(releaseMarkerPath)};`,
      "fs.writeFileSync(spawned,'spawned');",
      "const timer=setInterval(()=>{",
      "if(!fs.existsSync(release))return;",
      "clearInterval(timer);",
      "http.createServer((_req,res)=>res.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');",
      "},25);",
      "setInterval(()=>{},1000);",
    ].join("");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(serverScript)}`;
    const config = fixedPortRuntimeConfig(basePort, command);
    config.workspaceRuntime.services[0]!.readiness.timeoutSec = 70;
    let startPromise: ReturnType<typeof startRuntimeServicesForWorkspaceControl> | null = null;

    try {
      startPromise = startRuntimeServicesForWorkspaceControl({
        db,
        actor: fixture.actor,
        issue: null,
        workspace: fixture.realizedWorkspace(workspace),
        executionWorkspaceId: workspace.id,
        config,
        adapterEnv: {},
      });
      startPromise.catch(() => undefined);

      const markerDeadline = Date.now() + 5_000;
      while (!existsSync(spawnedMarkerPath) && Date.now() < markerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(spawnedMarkerPath)).toBe(true);

      const parentWrite = (async () => await db
        .update(executionWorkspaces)
        .set({ updatedAt: new Date() })
        .where(eq(executionWorkspaces.id, workspace.id)))();
      const parentWriteOutcome = await Promise.race([
        parentWrite.then(() => "committed" as const),
        new Promise<"locked">((resolve) => setTimeout(() => resolve("locked"), 2_000)),
      ]);

      const readinessWaitStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 60_250));
      expect(Date.now() - readinessWaitStartedAt).toBeGreaterThanOrEqual(60_000);

      await fs.writeFile(releaseMarkerPath, "release");
      const started = (await startPromise)[0]!;
      await parentWrite;

      expect(parentWriteOutcome).toBe("committed");
      expect(started).toMatchObject({
        port: basePort,
        url: `http://127.0.0.1:${basePort}`,
        status: "running",
        healthStatus: "healthy",
      });
      const persisted = await db
        .select()
        .from(workspaceRuntimeServices)
        .where(eq(workspaceRuntimeServices.executionWorkspaceId, workspace.id))
        .then((rows) => rows[0] ?? null);
      expect(persisted).toMatchObject({
        port: basePort,
        url: `http://127.0.0.1:${basePort}`,
        status: "running",
      });
    } finally {
      await fs.writeFile(releaseMarkerPath, "release").catch(() => undefined);
      await startPromise?.catch(() => undefined);
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId: workspace.id,
        workspaceCwd: workspace.cwd,
      }).catch(() => undefined);
      await cleanupRuntimeHome();
      await fixture.cleanup();
    }
  }, 80_000);

  it("reuses a stopped isolated workspace's actual port when it is free", async () => {
    const fixture = await createRuntimeFixture();
    const cleanupRuntimeHome = await createRuntimeHome();
    const workspace = fixture.workspaces[0]!;
    const config = fixedPortRuntimeConfig(await findFreePort());

    try {
      const first = (await startRuntimeServicesForWorkspaceControl({
        db,
        actor: fixture.actor,
        issue: null,
        workspace: fixture.realizedWorkspace(workspace),
        executionWorkspaceId: workspace.id,
        config,
        adapterEnv: {},
      }))[0]!;
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId: workspace.id,
        workspaceCwd: workspace.cwd,
      });

      const restarted = (await startRuntimeServicesForWorkspaceControl({
        db,
        actor: fixture.actor,
        issue: null,
        workspace: fixture.realizedWorkspace(workspace),
        executionWorkspaceId: workspace.id,
        config,
        adapterEnv: {},
      }))[0]!;

      expect(restarted.id).toBe(first.id);
      expect(restarted.port).toBe(first.port);
      expect(restarted.url).toBe(first.url);
      await expect(fetch(restarted.url!)).resolves.toMatchObject({ ok: true });
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId: workspace.id,
        workspaceCwd: workspace.cwd,
      }).catch(() => undefined);
      await cleanupRuntimeHome();
      await fixture.cleanup();
    }
  }, 20_000);

  it("retries a bind race on the next bounded port and persists the selected URL", async () => {
    const fixture = await createRuntimeFixture();
    const cleanupRuntimeHome = await createRuntimeHome();
    const workspace = fixture.workspaces[0]!;
    const basePort = await findFreePort();
    const markerPath = path.join(workspace.cwd, "bind-race.marker");
    const blockerPidPath = path.join(workspace.cwd, "bind-race.pid");
    const blockerScript = [
      "const net=require('node:net');",
      "const port=Number(process.argv[1]);",
      "net.createServer((socket)=>socket.destroy()).listen(port,'127.0.0.1');",
    ].join("");
    const raceScript = [
      "const fs=require('node:fs');",
      "const http=require('node:http');",
      "const {spawn}=require('node:child_process');",
      `const marker=${JSON.stringify(markerPath)};`,
      `const pidFile=${JSON.stringify(blockerPidPath)};`,
      `const blockerScript=${JSON.stringify(blockerScript)};`,
      "const port=Number(process.env.PORT);",
      "const start=()=>http.createServer((_req,res)=>res.end('ok')).listen(port,'127.0.0.1');",
      "if(!fs.existsSync(marker)){",
      "fs.writeFileSync(marker,String(port));",
      "const blocker=spawn(process.execPath,['-e',blockerScript,String(port)],{detached:true,stdio:'ignore'});",
      "fs.writeFileSync(pidFile,String(blocker.pid));blocker.unref();setTimeout(start,200);",
      "}else{start();}",
      "setInterval(()=>{},1000);",
    ].join("");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(raceScript)}`;

    try {
      const started = (await startRuntimeServicesForWorkspaceControl({
        db,
        actor: fixture.actor,
        issue: null,
        workspace: fixture.realizedWorkspace(workspace),
        executionWorkspaceId: workspace.id,
        config: fixedPortRuntimeConfig(basePort, command),
        adapterEnv: {},
      }))[0]!;

      expect(await fs.readFile(markerPath, "utf8")).toBe(String(basePort));
      expect(started.port).toBeGreaterThan(basePort);
      expect(started.url).toBe(`http://127.0.0.1:${started.port}`);
      await expect(fetch(started.url!)).resolves.toMatchObject({ ok: true });
      const persisted = await db
        .select()
        .from(workspaceRuntimeServices)
        .where(eq(workspaceRuntimeServices.executionWorkspaceId, workspace.id))
        .then((rows) => rows[0] ?? null);
      expect(persisted).toMatchObject({ port: started.port, url: started.url, status: "running" });
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId: workspace.id,
        workspaceCwd: workspace.cwd,
      }).catch(() => undefined);
      const blockerPid = Number.parseInt(await fs.readFile(blockerPidPath, "utf8").catch(() => ""), 10);
      if (Number.isInteger(blockerPid) && blockerPid > 0) {
        try {
          process.kill(blockerPid, "SIGTERM");
        } catch {
          // The bind-race process already exited.
        }
      }
      await cleanupRuntimeHome();
      await fixture.cleanup();
    }
  }, 20_000);

  it("does not accept an occupied allocated port when listener ownership is unavailable", async () => {
    const fixture = await createRuntimeFixture();
    const cleanupRuntimeHome = await createRuntimeHome();
    const workspace = fixture.workspaces[0]!;
    const basePort = await findFreePort();
    const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-no-lsof-"));
    const fakeLsof = path.join(fakeBin, "lsof");
    const previousPath = process.env.PATH;
    await fs.writeFile(fakeLsof, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;

    try {
      await expect(startRuntimeServicesForWorkspaceControl({
        db,
        actor: fixture.actor,
        issue: null,
        workspace: fixture.realizedWorkspace(workspace),
        executionWorkspaceId: workspace.id,
        config: fixedPortRuntimeConfig(basePort),
        adapterEnv: {},
      })).rejects.toMatchObject({
        status: 409,
        details: {
          code: "workspace_runtime_port_allocation_exhausted",
          port: basePort,
          attemptedPortCount: WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS,
        },
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId: workspace.id,
        workspaceCwd: workspace.cwd,
      }).catch(() => undefined);
      await fs.rm(fakeBin, { recursive: true, force: true });
      await cleanupRuntimeHome();
      await fixture.cleanup();
    }
  }, 20_000);

  it("returns a bounded structured conflict and exposes only same-company workspace references", async () => {
    const fixture = await createRuntimeFixture({
      workspaceModes: ["isolated_workspace", "isolated_workspace"],
    });
    const otherCompanyFixture = await createRuntimeFixture();
    const cleanupRuntimeHome = await createRuntimeHome();
    const reservation = await reserveContiguousPorts(WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS);
    const [baseReservation, ...otherReservations] = reservation.servers;
    await closeNetServer(baseReservation!);
    const firstWorkspace = fixture.workspaces[0]!;
    const secondWorkspace = fixture.workspaces[1]!;
    const otherCompanyWorkspace = otherCompanyFixture.workspaces[0]!;
    const config = fixedPortRuntimeConfig(reservation.basePort);

    try {
      const first = (await startRuntimeServicesForWorkspaceControl({
        db,
        actor: fixture.actor,
        issue: null,
        workspace: fixture.realizedWorkspace(firstWorkspace),
        executionWorkspaceId: firstWorkspace.id,
        config,
        adapterEnv: {},
      }))[0]!;
      expect(first.port).toBe(reservation.basePort);

      let sameCompanyError: unknown;
      try {
        await startRuntimeServicesForWorkspaceControl({
          db,
          actor: fixture.actor,
          issue: null,
          workspace: fixture.realizedWorkspace(secondWorkspace),
          executionWorkspaceId: secondWorkspace.id,
          config,
          adapterEnv: {},
        });
      } catch (error) {
        sameCompanyError = error;
      }
      expect(sameCompanyError).toMatchObject({
        status: 409,
        details: {
          code: "workspace_runtime_port_allocation_exhausted",
          port: reservation.basePort,
          attemptedPortCount: WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS,
          conflictingExecutionWorkspaceId: firstWorkspace.id,
          remediation: expect.any(String),
        },
      });
      expect(JSON.stringify(sameCompanyError)).not.toMatch(/(?:pid|cwd)/i);

      let otherCompanyError: unknown;
      try {
        await startRuntimeServicesForWorkspaceControl({
          db,
          actor: otherCompanyFixture.actor,
          issue: null,
          workspace: otherCompanyFixture.realizedWorkspace(otherCompanyWorkspace),
          executionWorkspaceId: otherCompanyWorkspace.id,
          config,
          adapterEnv: {},
        });
      } catch (error) {
        otherCompanyError = error;
      }
      expect(otherCompanyError).toMatchObject({
        status: 409,
        details: {
          code: "workspace_runtime_port_allocation_exhausted",
          port: reservation.basePort,
          attemptedPortCount: WORKSPACE_RUNTIME_PORT_ALLOCATION_ATTEMPTS,
        },
      });
      expect(otherCompanyError).not.toMatchObject({
        details: {
          conflictingExecutionWorkspaceId: firstWorkspace.id,
        },
      });
      expect(JSON.stringify(otherCompanyError)).not.toContain(firstWorkspace.id);
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId: firstWorkspace.id,
        workspaceCwd: firstWorkspace.cwd,
      }).catch(() => undefined);
      await Promise.all(otherReservations.map((server) => closeNetServer(server).catch(() => undefined)));
      await cleanupRuntimeHome();
      await fixture.cleanup();
      await otherCompanyFixture.cleanup();
    }
  }, 30_000);

  it("keeps fixed ports strict for shared persisted workspaces and identity-less starts", async () => {
    const fixture = await createRuntimeFixture({ workspaceModes: ["shared_workspace"] });
    const cleanupRuntimeHome = await createRuntimeHome();
    const workspace = fixture.workspaces[0]!;
    const occupiedPort = await findFreePort();
    const occupant = await listenOnPort(occupiedPort);
    const config = fixedPortRuntimeConfig(occupiedPort);

    try {
      let sharedWorkspaceError: unknown;
      try {
        await startRuntimeServicesForWorkspaceControl({
          db,
          actor: fixture.actor,
          issue: null,
          workspace: fixture.realizedWorkspace(workspace),
          executionWorkspaceId: workspace.id,
          config,
          adapterEnv: {},
        });
      } catch (error) {
        sharedWorkspaceError = error;
      }
      expect(sharedWorkspaceError).toBeInstanceOf(Error);
      expect(sharedWorkspaceError).not.toMatchObject({ status: 409 });

      const identitylessCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-identityless-"));
      try {
        await expect(startRuntimeServicesForWorkspaceControl({
          actor: { id: null, name: "Board", companyId: fixture.companyId },
          issue: null,
          workspace: buildWorkspace(identitylessCwd),
          config,
          adapterEnv: {},
        })).rejects.toBeInstanceOf(Error);
      } finally {
        await fs.rm(identitylessCwd, { recursive: true, force: true });
      }

      const rows = await db
        .select()
        .from(workspaceRuntimeServices)
        .where(eq(workspaceRuntimeServices.executionWorkspaceId, workspace.id));
      expect(rows.every((row) => row.port === occupiedPort)).toBe(true);
    } finally {
      await closeNetServer(occupant);
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId: workspace.id,
        workspaceCwd: workspace.cwd,
      }).catch(() => undefined);
      await cleanupRuntimeHome();
      await fixture.cleanup();
    }
  }, 20_000);
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
    // Startup reconciliation starts real child processes and registers them.
    // Terminate them and persist their stopped rows before the row deletes
    // below. A left-over child exits later and its detached exit handler then
    // writes a workspace_runtime_services row that references the deleted
    // project, which raises an unhandled foreign-key error in the next test.
    await resetRuntimeServicesForTests({ terminateProcesses: true });
    // Startup reconciliation writes activity_log rows (for example, exposure
    // reservation drift). Delete those rows before the company delete. A stale
    // activity_log row holds a foreign key to the company and makes the company
    // delete fail, which leaks rows into the next test.
    await db.delete(activityLog);
    await db.delete(workspaceRuntimeServices);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    // The runtime service control path writes activity_log rows through
    // logActivity. Those rows reference the company. Delete them before the
    // company to respect the activity_log.company_id foreign key.
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  it("restores desired services when one row is stopped and a live registered service has no row", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-desired-reconcile-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `runtime-desired-reconcile-${randomUUID()}`;

    const reservePort = async () => {
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      await new Promise<void>((resolve, reject) => {
        probe.close((error) => error ? reject(error) : resolve());
      });
      if (!port) throw new Error("Failed to reserve runtime reconciliation test port");
      return port;
    };
    const isLoopbackPortFree = async (port: number) => {
      const probe = net.createServer();
      return await new Promise<boolean>((resolve) => {
        probe.once("error", () => resolve(false));
        probe.listen(port, "127.0.0.1", () => {
          probe.close(() => resolve(true));
        });
      });
    };
    // The stopped service must fully release its port before reconciliation.
    // A lingering process on the port lets `reconcilePersistedRuntimeServicesOnStartup`
    // adopt it (reconciled/adopted) instead of the desired-state restart (restarted).
    const waitForLoopbackPortFree = async (port: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await isLoopbackPortFree(port)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Port ${port} did not become free in time`);
    };
    const stoppedPort = await reservePort();
    const livePort = await reservePort();
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const command =
      "node -e \"require('node:http').createServer((req,res)=>res.end(process.env.PORT)).listen(Number(process.env.PORT), '127.0.0.1')\"";
    const workspaceRuntime = {
      services: [
        {
          name: "persisted-service",
          command,
          port: stoppedPort,
          expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
          readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 50 },
          lifecycle: "shared",
          reuseScope: "execution_workspace",
          stopPolicy: { type: "manual" },
        },
        {
          name: "registry-only-service",
          command,
          port: livePort,
          expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
          readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 50 },
          lifecycle: "shared",
          reuseScope: "execution_workspace",
          stopPolicy: { type: "manual" },
        },
      ],
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Runtime desired reconciliation",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: workspaceRoot,
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Runtime desired reconciliation workspace",
      status: "active",
      cwd: workspaceRoot,
      providerType: "local_fs",
      providerRef: workspaceRoot,
      metadata: {
        config: {
          workspaceRuntime,
          desiredState: "running",
          serviceStates: { "0": "running", "1": "running" },
        },
      },
    });

    const actor = { id: null, name: "Paperclip", companyId };
    const workspace = {
      ...buildWorkspace(workspaceRoot),
      projectId,
      workspaceId: projectWorkspaceId,
    };
    let stoppedServiceId: string | null = null;
    let registryOnlyServiceId: string | null = null;

    try {
      const persisted = await startRuntimeServicesForWorkspaceControl({
        db,
        actor,
        issue: null,
        workspace,
        executionWorkspaceId,
        config: { workspaceRuntime },
        adapterEnv: {},
        serviceIndex: 0,
      });
      stoppedServiceId = persisted[0]?.id ?? null;
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId,
        workspaceCwd: workspaceRoot,
        runtimeServiceId: stoppedServiceId,
      });
      // Wait for the stopped subprocess to release its port. Otherwise the
      // reconcile below can adopt the lingering process instead of restarting it.
      await waitForLoopbackPortFree(stoppedPort);

      const registryOnly = await startRuntimeServicesForWorkspaceControl({
        actor,
        issue: null,
        workspace,
        executionWorkspaceId,
        config: { workspaceRuntime },
        adapterEnv: {},
        serviceIndex: 1,
      });
      registryOnlyServiceId = registryOnly[0]?.id ?? null;
      expect(registryOnlyServiceId).toBeTruthy();
      expect(await db.select().from(workspaceRuntimeServices)).toHaveLength(1);

      await resetRuntimeServicesForTests();
      const result = await reconcilePersistedRuntimeServicesOnStartup(db);

      expect(result).toMatchObject({ reconciled: 0, adopted: 0, stopped: 0, restarted: 1, restartFailed: 0 });
      const rows = await db.select().from(workspaceRuntimeServices);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: stoppedServiceId, port: stoppedPort, status: "running" }),
        expect.objectContaining({ id: registryOnlyServiceId, port: livePort, status: "running" }),
      ]));
      await expect(fetch(`http://127.0.0.1:${stoppedPort}`)).resolves.toMatchObject({ ok: true });
      await expect(fetch(`http://127.0.0.1:${livePort}`)).resolves.toMatchObject({ ok: true });
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId,
        workspaceCwd: workspaceRoot,
      });
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
  }, 20_000);

  it("backfills a pre-existing HTTP-only managed worktree runtime to verified HTTPS in place", async () => {
    // PAP-17158: an eligible workspace created before the feature must come
    // forward on the *same* workspace/runtime-service row — not by recreating it
    // — and must never keep its HTTP URL as a healthy fallback.
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-https-backfill-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const previousHttpsMode = process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `runtime-https-backfill-${randomUUID()}`;

    const reservePort = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const probe = net.createServer();
        await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
        const address = probe.address();
        const port = typeof address === "object" && address ? address.port : null;
        await new Promise<void>((resolve, reject) => {
          probe.close((error) => error ? reject(error) : resolve());
        });
        if (port && port <= 55_535 && (port < 42_000 || port > 42_999)) return port;
      }
      throw new Error("Failed to reserve an HTTPS backfill test port outside the broker range");
    };
    const isLoopbackPortFree = async (port: number) => {
      const probe = net.createServer();
      return await new Promise<boolean>((resolve) => {
        probe.once("error", () => resolve(false));
        probe.listen(port, "127.0.0.1", () => {
          probe.close(() => resolve(true));
        });
      });
    };

    // Stands in for the persisted template's hard-coded 45439: a pinned port
    // outside the broker's dedicated allowlist, so the backfill has to relocate.
    const legacyPort = await reservePort();
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    // Binds the app port and its HMR companion, both loopback-only.
    const command =
      "node -e \"const http=require('node:http');const p=Number(process.env.PORT);for(const q of [p,p+10000])http.createServer((req,res)=>{if(req.url==='/api/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok'}));return;}res.end('ok')}).listen(q,'127.0.0.1');setInterval(()=>{},1000)\"";
    const workspaceRuntime = {
      services: [
        {
          name: "paperclip-dev",
          command,
          env: { PAPERCLIP_PUBLIC_URL: "http://127.0.0.1:3100" },
          port: legacyPort,
          // The pre-feature block: backend URL only, no exposure declaration.
          expose: { type: "url", urlTemplate: "http://127.0.0.1:{{port}}" },
          readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 50 },
          lifecycle: "shared",
          reuseScope: "project_workspace",
          stopPolicy: { type: "manual" },
        },
      ],
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Runtime HTTPS backfill",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: workspaceRoot,
      isPrimary: true,
      metadata: {
        runtimeConfig: {
          workspaceRuntime,
          desiredState: "running",
          serviceStates: { "0": "running" },
        },
      },
    });

    const actor = { id: null, name: "Paperclip", companyId };
    const workspace = {
      ...buildWorkspace(workspaceRoot),
      projectId,
      workspaceId: projectWorkspaceId,
    };

    // A broker fake that remembers what it published, so a second reconciliation
    // can recognize its own live listeners instead of tearing them down.
    const exposedByRuntimeId = new Map<string, { port: number; purpose: "app" | "vite_hmr" }[]>();
    const pendingByHandle = new Map<string, { runtimeId: string; listeners: { port: number; purpose: "app" | "vite_hmr" }[] }>();
    let handleCounter = 0;
    const brokerCalls: string[] = [];
    const broker = {
      async reserve(runtimeId: string, listeners: { port: number; purpose: "app" | "vite_hmr" }[]) {
        brokerCalls.push("reserve");
        handleCounter += 1;
        const handle = `backfill-handle-${handleCounter}`;
        pendingByHandle.set(handle, { runtimeId, listeners: listeners.map((l) => ({ ...l })) });
        return { handle, reservedPorts: listeners.map((listener) => listener.port) };
      },
      async expose(runtimeId: string, handle: string) {
        brokerCalls.push("expose");
        const pending = pendingByHandle.get(handle);
        if (!pending || pending.runtimeId !== runtimeId) throw new Error("listener_ownership_mismatch");
        exposedByRuntimeId.set(runtimeId, pending.listeners);
        return { handle, publicPorts: pending.listeners.map((listener) => listener.port) };
      },
      async remove(runtimeId: string, handle: string) {
        brokerCalls.push("remove");
        const listeners = exposedByRuntimeId.get(runtimeId) ?? pendingByHandle.get(handle)?.listeners ?? [];
        exposedByRuntimeId.delete(runtimeId);
        pendingByHandle.delete(handle);
        return { removedPorts: listeners.map((listener) => listener.port) };
      },
      async list() {
        return [...exposedByRuntimeId.entries()].flatMap(([runtimeId, listeners]) =>
          listeners.map((listener) => ({ runtimeId, port: listener.port, purpose: listener.purpose })),
        );
      },
    };
    const installExposureDeps = () => setWorkspaceRuntimeExposureDepsForTests({
      broker,
      isPortAvailable: isLoopbackPortFree,
      isBrokerAvailable: async () => true,
      resolveHostname: async () => "runner.tail123.ts.net",
      probeHealth: async () => true,
      now: () => new Date().toISOString(),
    });

    try {
      // ---- Before: the workspace as it exists today, on plain HTTP. ----
      process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = "off";
      const before = await startRuntimeServicesForWorkspaceControl({
        db,
        actor,
        issue: null,
        workspace,
        config: { workspaceRuntime, desiredState: "running", serviceStates: { "0": "running" } },
        adapterEnv: {},
      });
      const runtimeServiceId = before[0]?.id;
      expect(runtimeServiceId).toBeTruthy();
      expect(before[0]?.port).toBe(legacyPort);
      expect(before[0]?.url).toBe(`http://127.0.0.1:${legacyPort}`);
      const [httpRow] = await db.select().from(workspaceRuntimeServices);
      expect(httpRow.exposure).toBeNull();
      expect(httpRow.url).toBe(`http://127.0.0.1:${legacyPort}`);
      await expect(fetch(`http://127.0.0.1:${legacyPort}`)).resolves.toMatchObject({ ok: true });
      expect(brokerCalls).toEqual([]);

      // ---- Deploy: the feature turns on and Paperclip restarts. ----
      await resetRuntimeServicesForTests();
      delete process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;
      installExposureDeps();

      const result = await reconcilePersistedRuntimeServicesOnStartup(db);
      expect(result).toMatchObject({ backfilled: 1, restarted: 1, restartFailed: 0 });
      expect(brokerCalls).toEqual(["reserve", "expose"]);

      // ---- After: same row, verified HTTPS URL, no HTTP anywhere. ----
      const afterRows = await db.select().from(workspaceRuntimeServices);
      expect(afterRows).toHaveLength(1);
      const httpsRow = afterRows[0]!;
      expect(httpsRow.id).toBe(runtimeServiceId);
      expect(httpsRow.status).toBe("running");
      expect(httpsRow.port).not.toBe(legacyPort);
      expect(httpsRow.port).toBeGreaterThanOrEqual(42_000);
      expect(httpsRow.port).toBeLessThanOrEqual(42_999);
      expect(httpsRow.url).toBe(`https://runner.tail123.ts.net:${httpsRow.port}`);
      expect(httpsRow.exposure).toMatchObject({
        provider: "tailscale_https",
        state: "ready",
        publicUrl: `https://runner.tail123.ts.net:${httpsRow.port}`,
        hostname: "runner.tail123.ts.net",
      });
      expect(httpsRow.exposureHandle).toBeTruthy();
      // The old HTTP backend is gone, not merely shadowed.
      await expect(fetch(`http://127.0.0.1:${legacyPort}`)).rejects.toThrow();

      // ---- Repeat deploy: converges, no listener churn, same port. ----
      await resetRuntimeServicesForTests();
      installExposureDeps();
      brokerCalls.length = 0;
      const second = await reconcilePersistedRuntimeServicesOnStartup(db);
      expect(second).toMatchObject({ backfilled: 0 });
      expect(brokerCalls).toEqual([]);
      const [repeatRow] = await db.select().from(workspaceRuntimeServices);
      expect(repeatRow.port).toBe(httpsRow.port);
      expect(repeatRow.url).toBe(httpsRow.url);
      expect(repeatRow.status).toBe("running");
    } finally {
      await stopRuntimeServicesForProjectWorkspace({
        db,
        projectWorkspaceId,
        workspaceCwd: workspaceRoot,
      }).catch(() => undefined);
      await resetRuntimeServicesForTests();
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      if (previousHttpsMode === undefined) delete process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;
      else process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = previousHttpsMode;
    }
  }, 40_000);

  it("re-adopts a request-logging service on the same auto port after supervisor stdio closes", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-reconcile-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `runtime-reconcile-${randomUUID()}`;

    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

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
    await fs.writeFile(
      path.join(workspaceRoot, "request-logger.cjs"),
      [
        "const http = require('node:http');",
        "http.createServer((req, res) => {",
        "  process.stdout.write(`request ${req.url}\\n`, (error) => { if (!error) res.end('ok'); });",
        "}).listen(Number(process.env.PORT), '127.0.0.1');",
      ].join("\n"),
      "utf8",
    );
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
              command: "node request-logger.cjs",
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
    const originalPort = service!.port;
    const originalProviderRef = service!.providerRef;

    // Closing the parent's pipe endpoints reproduces a real control-plane exit.
    // A service whose per-request logger still targets those pipes wedges (or
    // exits) on the reconciliation health probe instead of answering it.
    await resetRuntimeServicesForTests({ simulateSupervisorExit: true });

    const result = await reconcilePersistedRuntimeServicesOnStartup(db);
    expect(result).toMatchObject({ reconciled: 1, adopted: 1, stopped: 0 });

    const persisted = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(eq(workspaceRuntimeServices.id, service!.id))
      .then((rows) => rows[0] ?? null);
    expect(persisted?.status).toBe("running");
    expect(persisted?.port).toBe(originalPort);
    expect(persisted?.providerRef).toBe(originalProviderRef);
    await expect(fetch(service!.url!)).resolves.toMatchObject({ ok: true });

    await resetRuntimeServicesForTests({ terminateProcesses: true });
    leasedRunIds.delete(runId);
    await fs.rm(paperclipHome, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });

    await expect(fetch(service!.url!)).rejects.toThrow();
  });

  it("re-adopts a live service whose shell command differs from the surviving process argv", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-pnpm-reconcile-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-home-"));
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `runtime-pnpm-reconcile-${randomUUID()}`;

    // Reserve a port outside the runtime exposure app-port range (42000-42999).
    // The reconciler stores this port on the row. A port inside that range makes
    // the reconciler treat the row as an exposure reservation and report drift,
    // so the live service never reaches the adoption path this test verifies.
    const reservePort = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const probe = net.createServer();
        await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
        const address = probe.address();
        const candidate = typeof address === "object" && address ? address.port : null;
        await new Promise<void>((resolve, reject) => {
          probe.close((error) => error ? reject(error) : resolve());
        });
        if (candidate && candidate <= 55_535 && (candidate < 42_000 || candidate > 42_999)) {
          return candidate;
        }
      }
      throw new Error("Failed to reserve pnpm reconciliation test port outside the broker range");
    };
    const port = await reservePort();

    const companyId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const runtimeServiceId = randomUUID();
    const command = "env | sort > /tmp/guest-$$.env; exec pnpm dev --bind loopback";
    const service = {
      name: "web",
      command,
      port,
      readiness: {
        type: "http",
        urlTemplate: "http://127.0.0.1:{{port}}",
        timeoutSec: 10,
        intervalMs: 50,
      },
      expose: null,
      lifecycle: "shared",
      reuseScope: "execution_workspace",
      stopPolicy: { type: "manual" },
    };
    const reuseKey = createHash("sha256")
      .update(stableStringifyForTest({
        scopeType: "execution_workspace",
        scopeId: executionWorkspaceId,
        serviceName: service.name,
        command,
        cwd: workspaceRoot,
        port,
        env: {},
        expose: null,
      }))
      .digest("hex");
    const wrapperPath = path.join(workspaceRoot, "pnpm.cjs");
    await fs.writeFile(
      wrapperPath,
      [
        "const http = require('node:http');",
        "const port = Number(process.argv[3]);",
        "http.createServer((_req, res) => res.end('ok')).listen(port, '127.0.0.1');",
      ].join("\n"),
      "utf8",
    );
    const child = spawn(process.execPath, [wrapperPath, "dev", String(port)], {
      cwd: workspaceRoot,
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    child.unref();

    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}`)).ok) break;
        } catch {
          // Wait for the simulated package-manager launcher to bind.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await expect(fetch(`http://127.0.0.1:${port}`)).resolves.toMatchObject({ ok: true });

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Runtime pnpm reconciliation",
        status: "in_progress",
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: null,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Runtime pnpm reconciliation workspace",
        status: "active",
        cwd: workspaceRoot,
        providerType: "local_fs",
        providerRef: workspaceRoot,
        metadata: {
          config: {
            workspaceRuntime: { services: [service] },
            desiredState: "running",
            serviceStates: { "0": "running" },
          },
        },
      });
      await db.insert(workspaceRuntimeServices).values({
        id: runtimeServiceId,
        companyId,
        projectId,
        projectWorkspaceId: null,
        executionWorkspaceId,
        issueId: null,
        scopeType: "execution_workspace",
        scopeId: executionWorkspaceId,
        serviceName: service.name,
        status: "running",
        lifecycle: "shared",
        reuseKey,
        command,
        cwd: workspaceRoot,
        port,
        url: `http://127.0.0.1:${port}`,
        provider: "local_process",
        providerRef: String(child.pid),
        ownerAgentId: null,
        startedByRunId: null,
        lastUsedAt: new Date(),
        startedAt: new Date(),
        stoppedAt: null,
        stopPolicy: { type: "manual" },
        healthStatus: "healthy",
      });
      await writeLocalServiceRegistryRecord({
        version: 1,
        serviceKey: `workspace-runtime-web-${randomUUID()}`,
        profileKind: "workspace-runtime",
        serviceName: service.name,
        command,
        cwd: workspaceRoot,
        envFingerprint: reuseKey,
        port,
        url: `http://127.0.0.1:${port}`,
        pid: child.pid!,
        processGroupId: child.pid ?? null,
        provider: "local_process",
        runtimeServiceId,
        reuseKey,
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        metadata: { executionWorkspaceId },
      });

      const result = await reconcilePersistedRuntimeServicesOnStartup(db);

      expect(result).toMatchObject({
        reconciled: 1,
        adopted: 1,
        stopped: 0,
        restarted: 0,
        restartFailed: 0,
      });
      const rows = await db
        .select()
        .from(workspaceRuntimeServices)
        .where(eq(workspaceRuntimeServices.executionWorkspaceId, executionWorkspaceId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: runtimeServiceId,
        status: "running",
        healthStatus: "healthy",
        port,
        providerRef: String(child.pid),
      });
      expect(await readLocalServicePortOwner(port)).toBe(child.pid);
      await expect(fetch(`http://127.0.0.1:${port}`)).resolves.toMatchObject({ ok: true });
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        db,
        executionWorkspaceId,
        workspaceCwd: workspaceRoot,
      }).catch(() => undefined);
      if (child.pid) {
        try {
          if (process.platform === "win32") process.kill(child.pid, "SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          // The adopted runtime was already stopped through the managed path.
        }
      }
      await resetRuntimeServicesForTests();
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);

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
      "node -e \"const http=require('node:http'); const stale=process.env.STALE_HEALTH==='1'; http.createServer((req,res)=>{ if (req.url==='/api/health') { if (stale) { res.statusCode=503; res.end('database_unreachable'); return; } res.setHeader('content-type','application/json'); res.end(JSON.stringify({status:'ok'})); return; } res.end('ok'); }).listen(Number(process.env.PORT), '127.0.0.1')\"";
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
      const stalePortOwnerPid = await readLocalServicePortOwner(stalePort!);
      expect(stalePortOwnerPid).not.toBeNull();
      expect(staleProcess.pid).toBeTypeOf("number");
      await expect(
        isLocalServiceProcessOwnedBy(stalePortOwnerPid!, staleProcess.pid!),
      ).resolves.toBe(true);
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

  it("does not adopt a live registry process from another workspace with the same runtime service ID", async () => {
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
      cwd: process.cwd(),
      envFingerprint: "fingerprint",
      port: 49195,
      url: "http://127.0.0.1:49195",
      pid: process.pid,
      processGroupId: process.pid,
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

  it("adopts stopped persisted local services when a matching registry process is alive", async () => {
    const companyId = randomUUID();
    const runtimeServiceId = randomUUID();
    const startedAt = new Date("2026-04-04T17:00:00.000Z");
    const stoppedAt = new Date("2026-04-04T17:10:00.000Z");
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const cwd = process.cwd();
    const reuseKey = `project_workspace:${projectWorkspaceId}:paperclip-dev`;

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
      cwd,
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Execution workspace",
      status: "active",
      cwd,
      providerType: "local_fs",
      providerRef: cwd,
    });
    await db.insert(workspaceRuntimeServices).values({
      id: runtimeServiceId,
      companyId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      issueId: null,
      scopeType: "project_workspace",
      scopeId: projectWorkspaceId,
      serviceName: "paperclip-dev",
      status: "stopped",
      lifecycle: "shared",
      reuseKey,
      command: "node",
      cwd,
      port: null,
      url: null,
      provider: "local_process",
      providerRef: "stale",
      ownerAgentId: null,
      startedByRunId: null,
      lastUsedAt: stoppedAt,
      startedAt,
      stoppedAt,
      stopPolicy: { type: "manual" },
      healthStatus: "unknown",
      createdAt: startedAt,
      updatedAt: stoppedAt,
    });
    await writeLocalServiceRegistryRecord({
      version: 1,
      serviceKey: "workspace-runtime-paperclip-dev-live-stopped",
      profileKind: "workspace-runtime",
      serviceName: "paperclip-dev",
      command: "node",
      cwd,
      envFingerprint: reuseKey,
      port: null,
      url: null,
      pid: process.pid,
      processGroupId: process.pid,
      provider: "local_process",
      runtimeServiceId,
      reuseKey,
      startedAt: startedAt.toISOString(),
      lastSeenAt: stoppedAt.toISOString(),
      metadata: null,
    });

    const result = await reconcilePersistedRuntimeServicesOnStartup(db);

    expect(result).toMatchObject({ reconciled: 1, adopted: 1, stopped: 0 });
    const persisted = await db
      .select()
      .from(workspaceRuntimeServices)
      .where(eq(workspaceRuntimeServices.id, runtimeServiceId))
      .then((rows) => rows[0] ?? null);
    expect(persisted?.status).toBe("running");
    expect(persisted?.healthStatus).toBe("healthy");
    expect(persisted?.stoppedAt).toBeNull();
    expect(persisted?.providerRef).toBe(String(process.pid));
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

  it("restarts a stopped auto-port service on the same port when rendered env changes", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-port-reuse-env-"));
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
      name: "Runtime port reuse env test",
      status: "active",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Execution workspace port reuse env test",
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
    const serviceCommand =
      "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"";
    const makeConfig = (flag: string) => ({
      workspaceRuntime: {
        services: [
          {
            name: "web",
            command: serviceCommand,
            env: { PAPERCLIP_TEST_RUNTIME_FLAG: flag },
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
    });

    const first = await startRuntimeServicesForWorkspaceControl({
      db,
      actor,
      issue: null,
      workspace,
      executionWorkspaceId,
      config: makeConfig("before"),
      adapterEnv: {},
    });
    expect(first).toHaveLength(1);
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
      config: makeConfig("after"),
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

describe("workspace realization request additionalSources", () => {
  function buildRealizedWorkspace(
    overrides: Partial<RealizedExecutionWorkspace> = {},
  ): RealizedExecutionWorkspace {
    return {
      baseCwd: "/anchor",
      source: "project_primary",
      projectId: "project-anchor",
      workspaceId: "workspace-anchor",
      repoUrl: "https://example.test/anchor.git",
      repoRef: "main",
      strategy: "project_primary",
      cwd: "/anchor",
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
      ...overrides,
    };
  }

  it("round-trips additionalSources and runtime provisioning through build/read realization request", () => {
    const workspace = buildRealizedWorkspace({
      additionalWorkspaces: [
        {
          cwd: "/managed/project-b",
          projectId: "project-b",
          workspaceId: "workspace-b",
          repoUrl: "https://example.test/b.git",
          repoRef: "release",
        },
      ],
    });

    const request = buildWorkspaceRealizationRequest({
      adapterType: "codex",
      companyId: "company-1",
      environmentId: "environment-1",
      executionWorkspaceId: "execution-workspace-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      requestedMode: "shared_workspace",
      workspace,
      workspaceConfig: {
        provisionCommand: null,
        runtimeProvisionCommand: "bash ./scripts/provision-runtime.sh",
        teardownCommand: null,
        cleanupCommand: null,
        workspaceRuntime: null,
        desiredState: null,
        serviceStates: null,
      },
    });

    expect(request.additionalSources).toEqual([
      {
        localPath: "/managed/project-b",
        projectId: "project-b",
        projectWorkspaceId: "workspace-b",
        repoUrl: "https://example.test/b.git",
        repoRef: "release",
      },
    ]);
    // The anchor source stays scalar and unchanged alongside the new plural field.
    expect(request.source.localPath).toBe("/anchor");

    // A serialize/deserialize round-trip preserves additionalSources.
    const roundTripped = readWorkspaceRealizationRequest(
      JSON.parse(JSON.stringify(request)),
    );
    expect(roundTripped?.additionalSources).toEqual(request.additionalSources);
    expect(roundTripped?.runtimeOverlay.runtimeProvisionCommand).toBe(
      "bash ./scripts/provision-runtime.sh",
    );
  });

  it("exposes additionalSources on the realization record so targets receive the paths", () => {
    const workspace = buildRealizedWorkspace({
      additionalWorkspaces: [
        {
          cwd: "/managed/project-b",
          projectId: "project-b",
          workspaceId: "workspace-b",
          repoUrl: "https://example.test/b.git",
          repoRef: "release",
        },
      ],
    });

    const request = buildWorkspaceRealizationRequest({
      adapterType: "codex",
      companyId: "company-1",
      environmentId: "environment-1",
      executionWorkspaceId: "execution-workspace-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      requestedMode: "shared_workspace",
      workspace,
      workspaceConfig: null,
    });

    const now = new Date(0);
    const environment: Environment = {
      id: "environment-1",
      name: "local",
      description: null,
      driver: "local",
      status: "active",
      config: {},
      envVars: {},
      metadata: null,
      createdAt: now,
      updatedAt: now,
    };
    const lease: EnvironmentLease = {
      id: "lease-1",
      companyId: "company-1",
      environmentId: "environment-1",
      executionWorkspaceId: "execution-workspace-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      status: "active",
      leasePolicy: "ephemeral",
      provider: "local",
      providerLeaseId: null,
      acquiredAt: now,
      lastUsedAt: now,
      expiresAt: null,
      releasedAt: null,
      failureReason: null,
      cleanupStatus: null,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    };

    const record = buildWorkspaceRealizationRecord({ environment, lease, request });

    // The record carries the resolved referenced-project path so the execution target can expose it.
    expect(record.additional).toEqual([
      {
        path: "/managed/project-b",
        projectId: "project-b",
        projectWorkspaceId: "workspace-b",
        repoUrl: "https://example.test/b.git",
        repoRef: "release",
      },
    ]);
    // The anchor stays scalar and unchanged alongside the new plural field.
    expect(record.local.path).toBe("/anchor");
  });

  // Characterization test: this test must pass on the code before and after a
  // pure refactor of the driver-trait lookup. It pins today's behavior so the
  // refactor changes no field the record writes.
  it("selects the provider and summary from the driver's traits", () => {
    const now = new Date(0);
    const workspace = buildRealizedWorkspace();
    const request = buildWorkspaceRealizationRequest({
      adapterType: "codex",
      companyId: "company-1",
      environmentId: "environment-1",
      executionWorkspaceId: "execution-workspace-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      requestedMode: "shared_workspace",
      workspace,
      workspaceConfig: null,
    });
    const lease: EnvironmentLease = {
      id: "lease-1",
      companyId: "company-1",
      environmentId: "environment-1",
      executionWorkspaceId: "execution-workspace-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      status: "active",
      leasePolicy: "ephemeral",
      provider: null,
      providerLeaseId: null,
      acquiredAt: now,
      lastUsedAt: now,
      expiresAt: null,
      releasedAt: null,
      failureReason: null,
      cleanupStatus: null,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    };
    function buildEnvironment(driver: string): Environment {
      return {
        id: "environment-1",
        name: "env",
        description: null,
        driver: driver as Environment["driver"],
        status: "active",
        config: {},
        envVars: {},
        metadata: null,
        createdAt: now,
        updatedAt: now,
      };
    }

    const cases: Array<{
      driver: string;
      provider: string | null;
      summary: string;
    }> = [
      {
        driver: "local",
        provider: "local",
        summary: "Local workspace realized at /anchor.",
      },
      {
        driver: "ssh",
        provider: "ssh",
        summary: "SSH workspace realized at user@host:22:/anchor.",
      },
      {
        driver: "sandbox",
        provider: null,
        summary: "Sandbox workspace realized at /.",
      },
      {
        driver: "plugin",
        provider: null,
        summary: "Plugin workspace realized at /anchor.",
      },
      // An unknown driver string falls back to the "local" trait row: provider "local".
      {
        driver: "unknown-driver",
        provider: "local",
        summary: "Local workspace realized at /anchor.",
      },
    ];

    for (const testCase of cases) {
      const record = buildWorkspaceRealizationRecord({
        environment: buildEnvironment(testCase.driver),
        lease,
        request,
      });
      expect(record.provider).toBe(testCase.provider);
      expect(record.summary).toBe(testCase.summary);
    }
  });

  it("reads the in_place mode from the lease metadata", () => {
    const now = new Date(0);
    const workspace = buildRealizedWorkspace();
    const request = buildWorkspaceRealizationRequest({
      adapterType: "codex",
      companyId: "company-1",
      environmentId: "environment-1",
      executionWorkspaceId: "execution-workspace-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      requestedMode: "shared_workspace",
      workspace,
      workspaceConfig: null,
    });
    const lease: EnvironmentLease = {
      id: "lease-1",
      companyId: "company-1",
      environmentId: "environment-1",
      executionWorkspaceId: "execution-workspace-1",
      issueId: "issue-1",
      heartbeatRunId: "run-1",
      status: "active",
      leasePolicy: "ephemeral",
      provider: null,
      providerLeaseId: null,
      acquiredAt: now,
      lastUsedAt: now,
      expiresAt: null,
      releasedAt: null,
      failureReason: null,
      cleanupStatus: null,
      metadata: { workspaceRealization: { mode: "in_place" } },
      createdAt: now,
      updatedAt: now,
    };
    const environment: Environment = {
      id: "environment-1",
      name: "env",
      description: null,
      driver: "sandbox",
      status: "active",
      config: {},
      envVars: {},
      metadata: null,
      createdAt: now,
      updatedAt: now,
    };

    const record = buildWorkspaceRealizationRecord({ environment, lease, request });

    expect(record.mode).toBe("in_place");
  });

  it("reads a legacy request without additionalSources as an empty array", () => {
    const legacyRequest = {
      version: 1,
      adapterType: "codex",
      companyId: "company-1",
      environmentId: "environment-1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "run-1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/anchor",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: null,
        teardownCommand: null,
        cleanupCommand: null,
        workspaceRuntime: null,
      },
    };

    const parsed = readWorkspaceRealizationRequest(legacyRequest);

    expect(parsed).not.toBeNull();
    expect(parsed?.additionalSources).toEqual([]);
    expect(parsed?.runtimeOverlay.runtimeProvisionCommand).toBeNull();
  });
});

describe("realizeExecutionWorkspace with an exact existing branch", () => {
  function realizeExistingBranch(
    repoRoot: string,
    existingBranch: string,
    strategyOverrides: Record<string, unknown> = {},
    recordedBranchOwnership: Parameters<typeof realizeExecutionWorkspace>[0]["recordedBranchOwnership"] = null,
  ) {
    return realizeExecutionWorkspace({
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
          existingBranch,
          ...strategyOverrides,
        },
      },
      issue: {
        id: "issue-pr-prep",
        identifier: "PAP-9001",
        title: "Prepare pull request for an existing branch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recordedBranchOwnership,
    });
  }

  function restoreExistingBranch(
    repoRoot: string,
    workspace: RealizedExecutionWorkspace,
    metadata: Record<string, unknown>,
  ) {
    return ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: workspace.repoRef,
      },
      workspace: {
        id: "execution-workspace-existing-branch",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: workspace.cwd,
        providerRef: workspace.worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: workspace.repoRef,
        branchName: workspace.branchName,
        metadata,
      },
      issue: {
        id: "issue-pr-prep",
        identifier: "PAP-9001",
        title: "Restore an existing-branch pull request workspace",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });
  }

  async function createBranchWithCommit(repoRoot: string, branchName: string, fileName: string) {
    const baseBranch = await readGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    await runGit(repoRoot, ["checkout", "-b", branchName]);
    await fs.writeFile(path.join(repoRoot, fileName), `${fileName}\n`, "utf8");
    await runGit(repoRoot, ["add", fileName]);
    await runGit(repoRoot, ["commit", "-m", `Add ${fileName}`]);
    await runGit(repoRoot, ["checkout", baseBranch]);
    return readGit(repoRoot, ["rev-parse", branchName]);
  }

  it("attaches an isolated worktree checked out on exactly the requested branch", async () => {
    const repoRoot = await createTempRepo();
    const branchTip = await createBranchWithCommit(repoRoot, "feature/preexisting-work", "existing.txt");

    const workspace = await realizeExistingBranch(repoRoot, "feature/preexisting-work");

    expect(workspace.strategy).toBe("git_worktree");
    expect(workspace.branchName).toBe("feature/preexisting-work");
    // The worktree is freshly created, but the pinned branch pre-existed and
    // stays operator-owned so terminal cleanup never deletes it.
    expect(workspace.created).toBe(true);
    expect(workspace.branchCreatedByRuntime).toBe(false);
    expect(workspace.cwd).not.toBe(repoRoot);
    expect(workspace.cwd).toContain(path.join(".paperclip", "worktrees"));
    expect(await readGit(workspace.cwd, ["branch", "--show-current"])).toBe("feature/preexisting-work");
    expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(branchTip);
    expect(await readGit(repoRoot, ["rev-parse", "feature/preexisting-work"])).toBe(branchTip);
  });

  it("reuses a registered legacy worktree that already has the branch checked out", async () => {
    const repoRoot = await createTempRepo();
    const branchTip = await createBranchWithCommit(repoRoot, "feature/legacy-checkout", "legacy.txt");
    const legacyPath = path.join(repoRoot, ".worktrees", "legacy-checkout");
    await runGit(repoRoot, ["worktree", "add", legacyPath, "feature/legacy-checkout"]);

    const workspace = await realizeExistingBranch(repoRoot, "feature/legacy-checkout");

    expect(workspace.cwd).toBe(path.resolve(legacyPath));
    expect(workspace.branchName).toBe("feature/legacy-checkout");
    expect(workspace.created).toBe(false);
    expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(branchTip);
    expect(await readGit(repoRoot, ["rev-parse", "feature/legacy-checkout"])).toBe(branchTip);
  });

  it("does not let exact-branch reuse inherit runtime ownership", async () => {
    const repoRoot = await createTempRepo();
    await createBranchWithCommit(repoRoot, "feature/operator-owned-reuse", "operator-reuse.txt");
    const legacyPath = path.join(repoRoot, ".worktrees", "operator-owned-reuse");
    await runGit(repoRoot, ["worktree", "add", legacyPath, "feature/operator-owned-reuse"]);

    const workspace = await realizeExistingBranch(
      repoRoot,
      "feature/operator-owned-reuse",
      {},
      {
        branchName: "feature/operator-owned-reuse",
        createdByRuntime: true,
      },
    );

    expect(workspace.created).toBe(false);
    expect(workspace.branchCreatedByRuntime).toBe(false);
  });

  it("fails closed when the requested branch does not exist and creates nothing", async () => {
    const repoRoot = await createTempRepo();

    await expect(realizeExistingBranch(repoRoot, "feature/never-created")).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "existing_branch_not_found",
          requestedExistingBranch: "feature/never-created",
        }),
      },
    });

    expect(await readGit(repoRoot, ["branch", "--list", "feature/never-created"])).toBe("");
    expect(
      existsSync(path.join(repoRoot, ".paperclip", "worktrees", "feature", "never-created")),
    ).toBe(false);
  });

  it("fails closed instead of reconciling when the managed worktree path holds another branch", async () => {
    const repoRoot = await createTempRepo();
    const branchTip = await createBranchWithCommit(repoRoot, "feature/pinned", "pinned.txt");
    const managedPath = path.join(repoRoot, ".paperclip", "worktrees", "feature/pinned");
    await runGit(repoRoot, ["worktree", "add", "-b", "stale-occupant", managedPath]);

    await expect(realizeExistingBranch(repoRoot, "feature/pinned")).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "existing_branch_worktree_not_reusable",
          requestedExistingBranch: "feature/pinned",
        }),
      },
    });

    expect(await readGit(repoRoot, ["rev-parse", "feature/pinned"])).toBe(branchTip);
    expect(await readGit(managedPath, ["branch", "--show-current"])).toBe("stale-occupant");
  });

  it("never fast-forwards an unstarted exact branch to a newer base ref", async () => {
    const { sourceRepo, remotePath, repoRoot } = await createClonedRepoWithRemote();
    const oldMaster = await readGit(repoRoot, ["rev-parse", "origin/master"]);
    await runGit(repoRoot, ["branch", "release/frozen", oldMaster]);

    const first = await realizeExistingBranch(repoRoot, "release/frozen", { baseRef: "origin/master" });
    expect(await readGit(first.cwd, ["rev-parse", "HEAD"])).toBe(oldMaster);

    const newMaster = await advanceRemoteMaster(sourceRepo, remotePath, "advance.txt");
    const reused = await restoreExistingBranch(repoRoot, first, {
      createdByRuntime: false,
      gitBranchOwnershipVersion: 1,
    });

    expect(reused?.cwd).toBe(first.cwd);
    expect(await readGit(first.cwd, ["rev-parse", "HEAD"])).toBe(oldMaster);
    expect(await readGit(repoRoot, ["rev-parse", "release/frozen"])).toBe(oldMaster);
    expect(newMaster).not.toBe(oldMaster);
  });

  it.each(["forward branch", "detached commit"] as const)(
    "fails closed when an operator-owned persisted worktree moves to a %s",
    async (mismatchKind) => {
      const repoRoot = await createTempRepo();
      const branchName = `feature/operator-owned-${mismatchKind === "forward branch" ? "forward" : "detached"}`;
      const branchTip = await createBranchWithCommit(repoRoot, branchName, "operator-owned-tip.txt");
      const workspace = await realizeExistingBranch(repoRoot, branchName);

      if (mismatchKind === "forward branch") {
        await runGit(workspace.cwd, ["checkout", "-b", `${branchName}-other`]);
      } else {
        await runGit(workspace.cwd, ["checkout", "--detach"]);
      }
      await fs.writeFile(path.join(workspace.cwd, "unexpected-forward-work.txt"), "do not adopt\n", "utf8");
      await runGit(workspace.cwd, ["add", "unexpected-forward-work.txt"]);
      await runGit(workspace.cwd, ["commit", "-m", "Unexpected forward work"]);
      const mismatchedHead = await readGit(workspace.cwd, ["rev-parse", "HEAD"]);

      await expect(restoreExistingBranch(repoRoot, workspace, {
        createdByRuntime: false,
        gitBranchOwnershipVersion: 1,
      })).rejects.toMatchObject({
        code: "workspace_validation_failed",
        resultJson: {
          workspaceValidation: expect.objectContaining({
            reason: "git_worktree_not_reusable",
            reasonCode: "branch_mismatch",
          }),
        },
      });

      expect(await readGit(repoRoot, ["rev-parse", `refs/heads/${branchName}`])).toBe(branchTip);
      expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(mismatchedHead);
      if (mismatchKind === "detached commit") {
        expect(await readGit(workspace.cwd, ["branch", "--show-current"])).toBe("");
      }
    },
  );

  function cleanupWorkspaceInput(
    workspace: RealizedExecutionWorkspace,
    repoRoot: string,
    expectedBranchHeadSha: string,
  ) {
    return {
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
        sourceIssueId: "issue-pr-prep",
        // Persist ownership the way the heartbeat does: from the branch
        // ownership signal, never from worktree creation.
        metadata: {
          createdByRuntime: workspace.branchCreatedByRuntime,
          gitBranchOwnershipVersion: 1,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: null,
      },
      expectedBranchHeadSha,
    };
  }

  it("terminal cleanup removes the worktree but preserves the attached pre-existing branch at its tip", async () => {
    const repoRoot = await createTempRepo();
    const branchTip = await createBranchWithCommit(repoRoot, "feature/operator-owned", "operator.txt");

    const workspace = await realizeExistingBranch(repoRoot, "feature/operator-owned");
    expect(workspace.created).toBe(true);
    expect(workspace.branchCreatedByRuntime).toBe(false);

    const cleanup = await cleanupExecutionWorkspaceArtifacts(
      cleanupWorkspaceInput(workspace, repoRoot, branchTip),
    );

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toEqual([]);
    await expect(fs.stat(workspace.cwd)).rejects.toThrow();
    expect(await readGit(repoRoot, ["rev-parse", "refs/heads/feature/operator-owned"])).toBe(branchTip);
  });

  it("treats unversioned legacy ownership as operator-owned during cleanup", async () => {
    const repoRoot = await createTempRepo();
    const branchTip = await createBranchWithCommit(repoRoot, "feature/legacy-owned", "legacy-owned.txt");
    const workspace = await realizeExistingBranch(repoRoot, "feature/legacy-owned");
    const cleanupInput = cleanupWorkspaceInput(workspace, repoRoot, branchTip);

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      ...cleanupInput,
      workspace: {
        ...cleanupInput.workspace,
        metadata: { createdByRuntime: true },
      },
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toEqual([]);
    await expect(fs.stat(workspace.cwd)).rejects.toThrow();
    expect(await readGit(repoRoot, ["rev-parse", "refs/heads/feature/legacy-owned"])).toBe(branchTip);
  });

  it("terminal cleanup preserves a pre-existing branch pinned via a literal branchTemplate", async () => {
    const repoRoot = await createTempRepo();
    const branchTip = await createBranchWithCommit(repoRoot, "feature/literal-pin", "literal.txt");

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
          branchTemplate: "feature/literal-pin",
        },
      },
      issue: {
        id: "issue-pr-prep",
        identifier: "PAP-9002",
        title: "Prepare pull request via a literal branch template",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(workspace.branchName).toBe("feature/literal-pin");
    expect(workspace.created).toBe(true);
    expect(workspace.branchCreatedByRuntime).toBe(false);
    expect(await readGit(workspace.cwd, ["rev-parse", "HEAD"])).toBe(branchTip);

    const cleanup = await cleanupExecutionWorkspaceArtifacts(
      cleanupWorkspaceInput(workspace, repoRoot, branchTip),
    );

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toEqual([]);
    await expect(fs.stat(workspace.cwd)).rejects.toThrow();
    expect(await readGit(repoRoot, ["rev-parse", "refs/heads/feature/literal-pin"])).toBe(branchTip);
  });

  it("restoring a persisted workspace keeps the recorded branch ownership", async () => {
    const repoRoot = await createTempRepo();
    await createBranchWithCommit(repoRoot, "feature/persisted-ownership", "persisted-ownership.txt");
    const first = await realizeExistingBranch(repoRoot, "feature/persisted-ownership");

    const operatorOwned = await restoreExistingBranch(repoRoot, first, { createdByRuntime: false });
    expect(operatorOwned?.branchCreatedByRuntime).toBe(false);

    const legacyOwned = await restoreExistingBranch(repoRoot, first, { createdByRuntime: true });
    expect(legacyOwned?.branchCreatedByRuntime).toBe(false);

    const runtimeOwned = await restoreExistingBranch(repoRoot, first, RUNTIME_OWNED_GIT_BRANCH_METADATA);
    expect(runtimeOwned?.branchCreatedByRuntime).toBe(true);
  });

  it("fails closed instead of recreating a missing branch from unversioned legacy ownership", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "feature/missing-operator-owned";
    await createBranchWithCommit(repoRoot, branchName, "operator-owned.txt");
    const first = await realizeExistingBranch(repoRoot, branchName);

    await runGit(repoRoot, ["worktree", "remove", "--force", first.cwd]);
    await runGit(repoRoot, ["branch", "-D", branchName]);

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
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: first.cwd,
        providerRef: first.worktreePath,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "HEAD",
        branchName,
        metadata: { createdByRuntime: true },
      },
      issue: {
        id: "issue-pr-prep",
        identifier: "PAP-9004",
        title: "Restore a missing operator-owned branch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    })).rejects.toThrow(`operator-owned branch "${branchName}" no longer exists`);

    await expect(fs.stat(first.cwd)).rejects.toThrow();
    await expect(readGit(repoRoot, ["rev-parse", "--verify", branchName])).rejects.toThrow();
  });

  it("fails closed when an existing branch is pinned on a non-worktree strategy", async () => {
    const repoRoot = await createTempRepo();
    await createBranchWithCommit(repoRoot, "feature/wrong-mode", "wrong-mode.txt");

    await expect(
      realizeExistingBranch(repoRoot, "feature/wrong-mode", { type: "project_primary" }),
    ).rejects.toMatchObject({
      code: "workspace_validation_failed",
      resultJson: {
        workspaceValidation: expect.objectContaining({
          reason: "existing_branch_requires_git_worktree",
        }),
      },
    });
  });
});
