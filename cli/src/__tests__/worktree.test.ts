import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authAccounts,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  inspectMigrations,
  instanceSettings,
  issueComments,
  issues,
  projectWorkspaces,
  instanceUserRoles,
  projects,
  routines,
  routineTriggers,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  copyGitHooksToWorktreeGitDir,
  copySeededSecretsKey,
  ensureEmbeddedPostgres,
  ensureWorktreeSeeded,
  formatWorktreeSeedFailureDiagnostic,
  inspectLegacyWorktreeDatabase,
  markWorktreeSeedPending,
  pauseSeededScheduledRoutines,
  quarantineSeededWorktreeExecutionState,
  readWorktreeSeedManifest,
  resetSeededWorktreeRunExecutionActivation,
  readSourceAttachmentBody,
  rebindWorkspaceCwd,
  requiresWorktreeSeedCredentialAccount,
  resolveSourceConfigPath,
  resolveWorktreeReseedSource,
  resolveWorktreeReseedTargetPaths,
  resolveGitWorktreeAddArgs,
  resolvePnpmInstallInvocation,
  resolveCurrentWorktreeEndpoint,
  resolveWorktreeSeedMigrationRevision,
  resolveWorktreeSeedBackupEngine,
  resolveWorktreeMakeTargetPath,
  worktreeRepairCommand,
  worktreeInitCommand,
  worktreeMakeCommand,
  worktreeReseedCommand,
} from "../commands/worktree.js";
import {
  buildWorktreeConfig,
  buildWorktreeEnvEntries,
  formatShellExports,
  generateWorktreeColor,
  resolveWorktreeSeedPlan,
  resolveWorktreeLocalPaths,
  rewriteLocalUrlPort,
  sanitizeWorktreeInstanceId,
} from "../commands/worktree-lib.js";
import type { PaperclipConfig } from "../config/schema.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const itEmbeddedPostgres = embeddedPostgresSupport.supported ? it : it.skip;
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function mockVerifiedSeedResult() {
  return {
    backupSummary: "snapshot.sql",
    snapshotAt: "2026-08-18T00:00:00.000Z",
    migrationRevision: "0142_test.sql",
    pausedScheduledRoutines: 0,
    executionQuarantine: {
      cancelledHeartbeatRuns: 0,
      deletedPendingWakeups: 0,
      clearedIssueMonitors: 0,
      disabledTimerHeartbeats: 0,
      resetRunningAgents: 0,
      quarantinedInProgressIssues: 0,
      unassignedTodoIssues: 0,
      unassignedReviewIssues: 0,
      stoppedProjectWorkspaceRuntimes: 0,
      stoppedExecutionWorkspaceRuntimes: 0,
      stoppedRuntimeServices: 0,
    },
    reboundWorkspaces: [],
    validation: {
      authUserCount: 1,
      credentialAccountCount: 1,
      instanceAdminCount: 1,
      activeMembershipCount: 1,
      companyCount: 1,
      issueCount: 1,
      representativeCompanyId: "00000000-0000-4000-8000-000000000001",
      representativeIssueId: "00000000-0000-4000-8000-000000000002",
      migrationRevision: "0142_test.sql",
    },
  };
}

async function seedValidWorktreeSource(
  connectionString: string,
  options: { includeCredentialAccount?: boolean; userId?: string } = {},
) {
  const db = createDb(connectionString);
  const companyId = randomUUID();
  const issueId = randomUUID();
  const userId = options.userId ?? "user-existing";
  const now = new Date();
  await db.insert(authUsers).values({
    id: userId,
    email: userId === "local-board" ? "local@paperclip.local" : "existing@paperclip.ing",
    name: userId === "local-board" ? "Board" : "Existing User",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  if (options.includeCredentialAccount !== false) {
    await db.insert(authAccounts).values({
      id: "credential-existing",
      accountId: "existing@paperclip.ing",
      providerId: "credential",
      userId,
      password: "fixture-password-hash",
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.insert(instanceUserRoles).values({
    userId,
    role: "instance_admin",
  });
  await db.insert(companies).values({
    id: companyId,
    name: "Seed Source",
    issuePrefix: "SEED",
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Representative seed issue",
    status: "backlog",
    priority: "medium",
    issueNumber: 1,
    identifier: "SEED-1",
  });
  await db.$client.end({ timeout: 5 });
  return { companyId, issueId };
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres worktree CLI tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function reserveTestPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer();
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve test port");
  }
  let released = false;
  return {
    port: address.port,
    release: () => new Promise<void>((resolve, reject) => {
      if (released) {
        resolve();
        return;
      }
      released = true;
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function buildSourceConfig(): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-03-09T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/main/db",
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "/tmp/main/backups",
      },
    },
    logging: {
      mode: "file",
      logDir: "/tmp/main/logs",
    },
    server: {
      deploymentMode: "authenticated",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: ["localhost"],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "explicit",
      publicBaseUrl: "http://127.0.0.1:3100",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: "/tmp/main/storage",
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
        keyFilePath: "/tmp/main/secrets/master.key",
      },
    },
  };
}

describe("worktree helpers", () => {
  it("uses the repo-local config for the current worktree", () => {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-current-worktree-"));
    try {
      const localConfig = path.join(targetRoot, ".paperclip", "config.json");
      fs.mkdirSync(path.dirname(localConfig), { recursive: true });
      fs.writeFileSync(localConfig, "{}\n");
      process.env.PAPERCLIP_CONFIG = "/tmp/ambient-paperclip/config.json";
      process.chdir(targetRoot);

      expect(resolveCurrentWorktreeEndpoint()).toMatchObject({
        rootPath: targetRoot,
        configPath: localConfig,
        isCurrent: true,
      });
    } finally {
      process.chdir(ORIGINAL_CWD);
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it("uses the repository config from a nested working directory", () => {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-current-worktree-nested-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: targetRoot });
      const nestedDirectory = path.join(targetRoot, "packages", "example", "src");
      const localConfig = path.join(targetRoot, ".paperclip", "config.json");
      fs.mkdirSync(nestedDirectory, { recursive: true });
      fs.mkdirSync(path.dirname(localConfig), { recursive: true });
      fs.writeFileSync(localConfig, "{}\n");
      process.env.PAPERCLIP_CONFIG = "/tmp/ambient-paperclip/config.json";
      process.chdir(nestedDirectory);

      expect(resolveCurrentWorktreeEndpoint()).toMatchObject({
        rootPath: targetRoot,
        configPath: localConfig,
        isCurrent: true,
      });
    } finally {
      process.chdir(ORIGINAL_CWD);
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it("sanitizes instance ids", () => {
    expect(sanitizeWorktreeInstanceId("feature/worktree-support")).toBe("feature-worktree-support");
    expect(sanitizeWorktreeInstanceId("  ")).toBe("worktree");
  });

  it("resolves worktree:make target paths under the user home directory", () => {
    expect(resolveWorktreeMakeTargetPath("paperclip-pr-432")).toBe(
      path.resolve(os.homedir(), "paperclip-pr-432"),
    );
  });

  it("rejects worktree:make names that are not safe directory/branch names", () => {
    expect(() => resolveWorktreeMakeTargetPath("paperclip/pr-432")).toThrow(
      "Worktree name must contain only letters, numbers, dots, underscores, or dashes.",
    );
  });

  it("reuses the current pnpm executable for worktree dependency installation", () => {
    expect(
      resolvePnpmInstallInvocation(
        { npm_execpath: "/Users/test/.pnpm/pnpm/9.15.4/bin/pnpm.cjs" },
        "/usr/local/bin/node",
      ),
    ).toEqual({
      command: "/usr/local/bin/node",
      argsPrefix: ["/Users/test/.pnpm/pnpm/9.15.4/bin/pnpm.cjs"],
    });
    expect(
      resolvePnpmInstallInvocation(
        { npm_execpath: "/Users/test/.pnpm/pnpm/9.15.4/bin/pnpm" },
        "/usr/local/bin/node",
      ),
    ).toEqual({
      command: "/Users/test/.pnpm/pnpm/9.15.4/bin/pnpm",
      argsPrefix: [],
    });
    expect(
      resolvePnpmInstallInvocation(
        { npm_execpath: "/Users/test/.npm/npm-cli.js" },
        "/usr/local/bin/node",
      ),
    ).toEqual({
      command: "pnpm",
      argsPrefix: [],
    });
  });

  it("builds git worktree add args for new and existing branches", () => {
    expect(
      resolveGitWorktreeAddArgs({
        branchName: "feature-branch",
        targetPath: "/tmp/feature-branch",
        branchExists: false,
      }),
    ).toEqual(["worktree", "add", "-b", "feature-branch", "/tmp/feature-branch", "HEAD"]);

    expect(
      resolveGitWorktreeAddArgs({
        branchName: "feature-branch",
        targetPath: "/tmp/feature-branch",
        branchExists: true,
      }),
    ).toEqual(["worktree", "add", "/tmp/feature-branch", "feature-branch"]);
  });

  it("builds git worktree add args with a start point", () => {
    expect(
      resolveGitWorktreeAddArgs({
        branchName: "my-worktree",
        targetPath: "/tmp/my-worktree",
        branchExists: false,
        startPoint: "public-gh/master",
      }),
    ).toEqual(["worktree", "add", "-b", "my-worktree", "/tmp/my-worktree", "public-gh/master"]);
  });

  it("uses start point even when a local branch with the same name exists", () => {
    expect(
      resolveGitWorktreeAddArgs({
        branchName: "my-worktree",
        targetPath: "/tmp/my-worktree",
        branchExists: true,
        startPoint: "origin/main",
      }),
    ).toEqual(["worktree", "add", "-b", "my-worktree", "/tmp/my-worktree", "origin/main"]);
  });

  it("rewrites auth URLs only when they already include a port", () => {
    expect(rewriteLocalUrlPort("http://127.0.0.1:3100", 3110)).toBe("http://127.0.0.1:3110/");
    expect(rewriteLocalUrlPort("http://my-host.ts.net:3100", 3110)).toBe("http://my-host.ts.net:3110/");
    expect(rewriteLocalUrlPort("https://paperclip.example", 3110)).toBe("https://paperclip.example");
  });

  it("builds isolated config and env paths for a worktree", () => {
    const paths = resolveWorktreeLocalPaths({
      cwd: "/tmp/paperclip-feature",
      homeDir: "/tmp/paperclip-worktrees",
      instanceId: "feature-worktree-support",
    });
    const config = buildWorktreeConfig({
      sourceConfig: buildSourceConfig(),
      paths,
      serverPort: 3110,
      databasePort: 54339,
      now: new Date("2026-03-09T12:00:00.000Z"),
    });

    expect(config.database.embeddedPostgresDataDir).toBe(
      path.resolve("/tmp/paperclip-worktrees", "instances", "feature-worktree-support", "db"),
    );
    expect(config.database.embeddedPostgresPort).toBe(54339);
    expect(config.database.backup.enabled).toBe(false);
    expect(config.server.port).toBe(3110);
    expect(config.auth.publicBaseUrl).toBe("http://127.0.0.1:3110/");
    expect(config.storage.localDisk.baseDir).toBe(
      path.resolve("/tmp/paperclip-worktrees", "instances", "feature-worktree-support", "data", "storage"),
    );

    const env = buildWorktreeEnvEntries(paths, {
      name: "feature-worktree-support",
      color: "#3abf7a",
    });
    expect(env.PAPERCLIP_HOME).toBe(path.resolve("/tmp/paperclip-worktrees"));
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("feature-worktree-support");
    expect(env.PAPERCLIP_IN_WORKTREE).toBe("true");
    expect(env.PAPERCLIP_DB_BACKUP_ENABLED).toBe("false");
    expect(env.PAPERCLIP_WORKTREE_NAME).toBe("feature-worktree-support");
    expect(env.PAPERCLIP_WORKTREE_COLOR).toBe("#3abf7a");
    expect(formatShellExports(env)).toContain("export PAPERCLIP_INSTANCE_ID='feature-worktree-support'");
  });

  it("falls back across storage roots before skipping a missing attachment object", async () => {
    const missingErr = Object.assign(new Error("missing"), { code: "ENOENT" });
    const expected = Buffer.from("image-bytes");
    await expect(
      readSourceAttachmentBody(
        [
          {
            getObject: vi.fn().mockRejectedValue(missingErr),
          },
          {
            getObject: vi.fn().mockResolvedValue(expected),
          },
        ],
        "company-1",
        "company-1/issues/issue-1/missing.png",
      ),
    ).resolves.toEqual(expected);
  });

  it("returns null when an attachment object is missing from every lookup storage", async () => {
    const missingErr = Object.assign(new Error("missing"), { code: "ENOENT" });
    await expect(
      readSourceAttachmentBody(
        [
          {
            getObject: vi.fn().mockRejectedValue(missingErr),
          },
          {
            getObject: vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { status: 404 })),
          },
        ],
        "company-1",
        "company-1/issues/issue-1/missing.png",
      ),
    ).resolves.toBeNull();
  });

  it("generates vivid worktree colors as hex", () => {
    expect(generateWorktreeColor()).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("uses minimal seed mode to keep app state but drop heavy runtime history", () => {
    const minimal = resolveWorktreeSeedPlan("minimal");
    const full = resolveWorktreeSeedPlan("full");

    expect(minimal.excludedTables).toContain("heartbeat_runs");
    expect(minimal.excludedTables).toContain("heartbeat_run_events");
    expect(minimal.excludedTables).toContain("workspace_runtime_services");
    expect(minimal.excludedTables).toContain("agent_task_sessions");
    expect(minimal.nullifyColumns.issues).toEqual(["checkout_run_id", "execution_run_id"]);

    expect(full.excludedTables).toEqual([]);
    expect(full.nullifyColumns).toEqual({});
  });

  it("requires the seed process to own the target embedded Postgres lifecycle", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-live-target-"));
    try {
      fs.writeFileSync(
        path.join(tempRoot, "postmaster.pid"),
        `${process.pid}\n${tempRoot}\n0\n55432\n`,
      );

      await expect(ensureEmbeddedPostgres(tempRoot, 55432, { allowExisting: false }))
        .rejects.toThrow("while it is already running");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("surfaces a credential-safe diagnostic when the target shuts down during restore", () => {
    expect(formatWorktreeSeedFailureDiagnostic(
      "restore",
      new Error(
        "Failed to restore seed.sql.gz: FATAL: the database system is shutting down; psql error: write EPIPE",
      ),
    )).toBe(
      "Target embedded PostgreSQL shut down during restore. Stop any competing worktree service and retry the seed.",
    );
    expect(formatWorktreeSeedFailureDiagnostic("migrations", new Error("secret connection failure")))
      .toBe("Seed failed during migrations.");
  });

  it("surfaces the missing credential artifact for authenticated seed validation", () => {
    expect(formatWorktreeSeedFailureDiagnostic(
      "source_validation",
      new Error(
        "No auth user has a non-empty credential account, instance-admin role, and active company membership. Authenticated worktree seeding requires a credential-backed instance administrator.",
      ),
    )).toBe(
      "Seed validation could not find a credential-backed instance administrator with an active company membership. Authenticated instances must create or sign in an administrator before seeding.",
    );
  });

  it("requires credential accounts only for authenticated worktree seeds", () => {
    expect(requiresWorktreeSeedCredentialAccount("local_trusted")).toBe(false);
    expect(requiresWorktreeSeedCredentialAccount("authenticated")).toBe(true);
  });

  it("rejects a source migration journal that diverges from the code journal", () => {
    expect(() => resolveWorktreeSeedMigrationRevision({
      status: "upToDate",
      tableCount: 1,
      availableMigrations: ["0001_initial.sql", "0002_current.sql"],
      appliedMigrations: ["0001_initial.sql", "0003_unknown.sql"],
      journalEntryCount: 3,
    }, "sourcePrefix")).toThrow("Migration journal is not a prefix of this Paperclip checkout");
  });

  it("accepts a current source whose migration application order differs from filename order", () => {
    expect(resolveWorktreeSeedMigrationRevision({
      status: "upToDate",
      tableCount: 1,
      availableMigrations: [
        "0001_initial.sql",
        "0002_renumbered.sql",
        "0003_applied_earlier.sql",
        "0004_current.sql",
      ],
      appliedMigrations: [
        "0001_initial.sql",
        "0003_applied_earlier.sql",
        "0002_renumbered.sql",
        "0004_current.sql",
      ],
      journalEntryCount: 6,
    }, "upToDate")).toBe("0004_current.sql");
  });

  it("accepts a source migration journal that is multiple revisions behind", () => {
    expect(resolveWorktreeSeedMigrationRevision({
      status: "needsMigrations",
      tableCount: 1,
      availableMigrations: [
        "0001_initial.sql",
        "0002_applied.sql",
        "0003_pending.sql",
        "0004_pending.sql",
      ],
      appliedMigrations: ["0002_applied.sql", "0001_initial.sql"],
      pendingMigrations: ["0003_pending.sql", "0004_pending.sql"],
      journalEntryCount: 3,
      reason: "pending-migrations",
    }, "sourcePrefix")).toBe("0002_applied.sql");
  });

  itEmbeddedPostgres("recognizes positive legacy database schema evidence", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-legacy-evidence-");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-legacy-config-"));
    try {
      const configPath = path.join(tempRoot, "config.json");
      const sourceConfig = buildSourceConfig();
      const config: PaperclipConfig = {
        ...sourceConfig,
        database: {
          ...sourceConfig.database,
          mode: "postgres",
          connectionString: tempDb.connectionString,
          backup: {
            ...sourceConfig.database.backup,
            enabled: false,
            intervalMinutes: 60,
            retentionDays: 30,
            dir: path.join(tempRoot, "backups"),
          },
        },
      };
      fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      fs.writeFileSync(
        path.join(tempRoot, ".env"),
        `PAPERCLIP_INSTANCE_ID=legacy-target\nDATABASE_URL=${JSON.stringify(tempDb.connectionString)}\n`,
      );

      await expect(inspectLegacyWorktreeDatabase(configPath)).resolves.toEqual({
        migrationRevision: expect.stringMatching(/\.sql$/),
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      await tempDb.cleanup();
    }
  }, 30000);

  it("ensure-seeded seeds once and fast-exits on the verified manifest", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-ensure-seeded-"));
    try {
      const sourceConfigPath = path.join(tempRoot, "source", "config.json");
      const targetRoot = path.join(tempRoot, "worktree");
      const targetConfigPath = path.join(targetRoot, ".paperclip", "config.json");
      const targetPaths = resolveWorktreeLocalPaths({
        cwd: targetRoot,
        homeDir: path.join(tempRoot, "worktree-home"),
        instanceId: "ensure-seeded-test",
      });
      const sourceConfig = buildSourceConfig();
      const targetConfig = buildWorktreeConfig({
        sourceConfig,
        paths: targetPaths,
        serverPort: 3199,
        databasePort: 54999,
      });
      fs.mkdirSync(path.dirname(sourceConfigPath), { recursive: true });
      fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
      fs.writeFileSync(sourceConfigPath, `${JSON.stringify(sourceConfig)}\n`);
      fs.writeFileSync(path.join(path.dirname(sourceConfigPath), ".env"), "PAPERCLIP_INSTANCE_ID=source\n");
      fs.writeFileSync(targetConfigPath, `${JSON.stringify(targetConfig)}\n`);
      fs.writeFileSync(
        path.join(targetRoot, ".paperclip", ".env"),
        `PAPERCLIP_HOME=${targetPaths.homeDir}\nPAPERCLIP_INSTANCE_ID=${targetPaths.instanceId}\n`,
      );
      markWorktreeSeedPending({ configPath: targetConfigPath, sourceConfigPath });

      const seedDatabase = vi.fn().mockResolvedValue({
        ...mockVerifiedSeedResult(),
        pausedScheduledRoutines: 2,
        executionQuarantine: {
          cancelledHeartbeatRuns: 1,
          deletedPendingWakeups: 1,
          clearedIssueMonitors: 1,
          disabledTimerHeartbeats: 1,
          resetRunningAgents: 1,
          quarantinedInProgressIssues: 1,
          unassignedTodoIssues: 1,
          unassignedReviewIssues: 1,
          stoppedProjectWorkspaceRuntimes: 0,
          stoppedExecutionWorkspaceRuntimes: 0,
          stoppedRuntimeServices: 0,
        },
      });

      await expect(
        ensureWorktreeSeeded({ config: targetConfigPath, fromConfig: sourceConfigPath }, { seedDatabase }),
      ).resolves.toMatchObject({ seeded: true, reason: "seeded" });
      await expect(
        ensureWorktreeSeeded({ config: targetConfigPath }, { seedDatabase }),
      ).resolves.toEqual({ seeded: false, reason: "verified_manifest" });

      expect(seedDatabase).toHaveBeenCalledTimes(1);
      expect(seedDatabase).toHaveBeenCalledWith(expect.objectContaining({
        sourceConfigPath,
        seedMode: "minimal",
        instanceId: "ensure-seeded-test",
      }));
      expect(fs.existsSync(path.join(targetRoot, ".paperclip", "seed-pending"))).toBe(false);
      expect(fs.existsSync(path.join(targetRoot, ".paperclip", "seed-complete"))).toBe(false);
      expect(readWorktreeSeedManifest(targetConfigPath)).toMatchObject({
        version: 2,
        state: "verified",
        phase: "complete",
        migrationRevision: "0142_test.sql",
        targetInstanceId: "ensure-seeded-test",
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats an unregistered markerless config as a normal non-worktree boot", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-unregistered-markerless-"));
    try {
      const configPath = path.join(tempRoot, "config.json");
      fs.writeFileSync(configPath, `${JSON.stringify(buildSourceConfig())}\n`);
      delete process.env.PAPERCLIP_WORKSPACE_BASE_CWD;
      delete process.env.PAPERCLIP_PROJECT_WORKSPACE_ID;
      delete process.env.PAPERCLIP_SEED_EXPECTED_COMPANY_ID;

      const inspectLegacyDatabase = vi.fn();
      const seedDatabase = vi.fn();

      await expect(ensureWorktreeSeeded(
        { config: configPath },
        { inspectLegacyDatabase, seedDatabase },
      )).resolves.toEqual({ seeded: false, reason: "legacy_unmarked" });

      expect(inspectLegacyDatabase).not.toHaveBeenCalled();
      expect(seedDatabase).not.toHaveBeenCalled();
      expect(readWorktreeSeedManifest(configPath)).toBeNull();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("honors a legacy complete marker without resolving a seed source", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-complete-marker-"));
    try {
      const configPath = path.join(tempRoot, "config.json");
      fs.writeFileSync(configPath, `${JSON.stringify(buildSourceConfig())}\n`);
      fs.writeFileSync(path.join(tempRoot, "seed-complete"), "complete\n");
      delete process.env.PAPERCLIP_WORKSPACE_BASE_CWD;

      const inspectLegacyDatabase = vi.fn();
      const seedDatabase = vi.fn();

      await expect(ensureWorktreeSeeded(
        { config: configPath },
        { inspectLegacyDatabase, seedDatabase },
      )).resolves.toEqual({ seeded: false, reason: "complete_marker" });

      expect(inspectLegacyDatabase).not.toHaveBeenCalled();
      expect(seedDatabase).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("seeds a configured worktree with no seed markers when no legacy database is present", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-unmarked-empty-"));
    try {
      const sourceConfigPath = path.join(tempRoot, "source", "config.json");
      const targetRoot = path.join(tempRoot, "worktree");
      const targetConfigPath = path.join(targetRoot, ".paperclip", "config.json");
      const targetPaths = resolveWorktreeLocalPaths({
        cwd: targetRoot,
        homeDir: path.join(tempRoot, "worktree-home"),
        instanceId: "unmarked-empty-target",
      });
      const sourceConfig = buildSourceConfig();
      const targetConfig = buildWorktreeConfig({
        sourceConfig,
        paths: targetPaths,
        serverPort: 3194,
        databasePort: 54994,
      });
      fs.mkdirSync(path.dirname(sourceConfigPath), { recursive: true });
      fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
      fs.writeFileSync(sourceConfigPath, `${JSON.stringify(sourceConfig)}\n`);
      fs.writeFileSync(path.join(path.dirname(sourceConfigPath), ".env"), "PAPERCLIP_INSTANCE_ID=source\n");
      fs.writeFileSync(targetConfigPath, `${JSON.stringify(targetConfig)}\n`);
      fs.writeFileSync(
        path.join(targetRoot, ".paperclip", ".env"),
        `PAPERCLIP_HOME=${targetPaths.homeDir}\nPAPERCLIP_INSTANCE_ID=${targetPaths.instanceId}\n`,
      );
      const inspectLegacyDatabase = vi.fn().mockResolvedValue(null);
      const seedDatabase = vi.fn().mockResolvedValue(mockVerifiedSeedResult());

      await expect(ensureWorktreeSeeded(
        { config: targetConfigPath, fromConfig: sourceConfigPath },
        { inspectLegacyDatabase, seedDatabase },
      )).resolves.toMatchObject({ seeded: true, reason: "seeded" });

      expect(inspectLegacyDatabase).toHaveBeenCalledWith(targetConfigPath);
      expect(seedDatabase).toHaveBeenCalledTimes(1);
      expect(readWorktreeSeedManifest(targetConfigPath)).toMatchObject({
        state: "verified",
        phase: "complete",
        migrationRevision: "0142_test.sql",
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("adopts a markerless legacy worktree only after validating its database schema", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-unmarked-legacy-"));
    try {
      const sourceConfigPath = path.join(tempRoot, "source", "config.json");
      const targetRoot = path.join(tempRoot, "worktree");
      const targetConfigPath = path.join(targetRoot, ".paperclip", "config.json");
      const targetPaths = resolveWorktreeLocalPaths({
        cwd: targetRoot,
        homeDir: path.join(tempRoot, "worktree-home"),
        instanceId: "unmarked-legacy-target",
      });
      const sourceConfig = buildSourceConfig();
      const targetConfig = buildWorktreeConfig({
        sourceConfig,
        paths: targetPaths,
        serverPort: 3193,
        databasePort: 54993,
      });
      fs.mkdirSync(path.dirname(sourceConfigPath), { recursive: true });
      fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
      fs.writeFileSync(sourceConfigPath, `${JSON.stringify(sourceConfig)}\n`);
      fs.writeFileSync(path.join(path.dirname(sourceConfigPath), ".env"), "PAPERCLIP_INSTANCE_ID=source\n");
      fs.writeFileSync(targetConfigPath, `${JSON.stringify(targetConfig)}\n`);
      fs.writeFileSync(
        path.join(targetRoot, ".paperclip", ".env"),
        `PAPERCLIP_HOME=${targetPaths.homeDir}\nPAPERCLIP_INSTANCE_ID=${targetPaths.instanceId}\n`,
      );
      const seedDatabase = vi.fn();

      await expect(ensureWorktreeSeeded(
        { config: targetConfigPath, fromConfig: sourceConfigPath },
        {
          inspectLegacyDatabase: vi.fn().mockResolvedValue({ migrationRevision: "0141_legacy.sql" }),
          seedDatabase,
        },
      )).resolves.toEqual({ seeded: false, reason: "legacy_database" });

      expect(seedDatabase).not.toHaveBeenCalled();
      expect(readWorktreeSeedManifest(targetConfigPath)).toMatchObject({
        state: "verified",
        phase: "complete",
        migrationRevision: "0141_legacy.sql",
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("managed ensure-seeded derives a valid source from the registered base workspace", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-managed-seed-"));
    try {
      const baseRoot = path.join(tempRoot, "base");
      const sourceConfigPath = path.join(baseRoot, ".paperclip", "config.json");
      const targetRoot = path.join(tempRoot, "worktree");
      const targetConfigPath = path.join(targetRoot, ".paperclip", "config.json");
      const targetPaths = resolveWorktreeLocalPaths({
        cwd: targetRoot,
        homeDir: path.join(tempRoot, "worktree-home"),
        instanceId: "managed-target",
      });
      const sourceConfig = buildSourceConfig();
      const targetConfig = buildWorktreeConfig({
        sourceConfig,
        paths: targetPaths,
        serverPort: 3195,
        databasePort: 54995,
      });
      fs.mkdirSync(path.dirname(sourceConfigPath), { recursive: true });
      fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
      fs.writeFileSync(sourceConfigPath, `${JSON.stringify(sourceConfig)}\n`);
      fs.writeFileSync(path.join(path.dirname(sourceConfigPath), ".env"), "PAPERCLIP_INSTANCE_ID=managed-source\n");
      fs.writeFileSync(targetConfigPath, `${JSON.stringify(targetConfig)}\n`);
      fs.writeFileSync(
        path.join(path.dirname(targetConfigPath), ".env"),
        `PAPERCLIP_HOME=${targetPaths.homeDir}\nPAPERCLIP_INSTANCE_ID=managed-target\n`,
      );
      markWorktreeSeedPending({ configPath: targetConfigPath, sourceConfigPath });
      const seedDatabase = vi.fn().mockResolvedValue(mockVerifiedSeedResult());

      await expect(ensureWorktreeSeeded({
        config: targetConfigPath,
        registeredBaseWorkspaceCwd: baseRoot,
        registeredProjectWorkspaceId: "project-workspace-1",
        expectedCompanyId: "company-1",
      }, { seedDatabase })).resolves.toMatchObject({ seeded: true, reason: "seeded" });

      expect(seedDatabase).toHaveBeenCalledWith(expect.objectContaining({
        sourceConfigPath,
        expectedCompanyId: "company-1",
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(["sibling", "foreign_instance", "symlink", "instance_mismatch"] as const)(
    "managed ensure-seeded re-derives a stale %s manifest source from registration",
    async (variant) => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `paperclip-worktree-managed-${variant}-`));
      try {
        const baseRoot = path.join(tempRoot, "base");
        const canonicalSource = path.join(baseRoot, ".paperclip", "config.json");
        const targetRoot = path.join(tempRoot, "worktree");
        const targetConfigPath = path.join(targetRoot, ".paperclip", "config.json");
        const attackerRoot = path.join(tempRoot, variant);
        const attackerConfig = path.join(attackerRoot, "config.json");
        fs.mkdirSync(path.dirname(canonicalSource), { recursive: true });
        fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
        fs.mkdirSync(attackerRoot, { recursive: true });
        fs.writeFileSync(canonicalSource, `${JSON.stringify(buildSourceConfig())}\n`);
        fs.writeFileSync(path.join(path.dirname(canonicalSource), ".env"), "PAPERCLIP_INSTANCE_ID=registered-source\n");
        fs.writeFileSync(targetConfigPath, `${JSON.stringify(buildSourceConfig())}\n`);
        fs.writeFileSync(
          path.join(path.dirname(targetConfigPath), ".env"),
          `PAPERCLIP_HOME=${path.join(tempRoot, "worktree-home")}\nPAPERCLIP_INSTANCE_ID=managed-target\n`,
        );
        fs.writeFileSync(attackerConfig, `${JSON.stringify(buildSourceConfig())}\n`);
        fs.writeFileSync(
          path.join(attackerRoot, ".env"),
          `PAPERCLIP_INSTANCE_ID=${variant === "foreign_instance" ? "foreign" : "registered-source"}\n`,
        );
        const diagnosticPath = variant === "instance_mismatch"
          ? canonicalSource
          : variant === "symlink"
          ? path.join(attackerRoot, "source-link.json")
          : attackerConfig;
        if (variant === "symlink") fs.symlinkSync(canonicalSource, diagnosticPath);
        markWorktreeSeedPending({
          configPath: targetConfigPath,
          sourceConfigPath: diagnosticPath,
          targetInstanceId: "managed-target",
        });
        if (variant === "instance_mismatch") {
          const manifest = readWorktreeSeedManifest(targetConfigPath)!;
          fs.writeFileSync(
            path.join(path.dirname(targetConfigPath), "seed-manifest.json"),
            JSON.stringify({ ...manifest, source: { ...manifest.source, instanceId: "foreign" } }),
          );
        }
        const seedDatabase = vi.fn().mockResolvedValue(mockVerifiedSeedResult());

        await expect(ensureWorktreeSeeded({
          config: targetConfigPath,
          registeredBaseWorkspaceCwd: baseRoot,
          registeredProjectWorkspaceId: "project-workspace-1",
          expectedCompanyId: "company-1",
        }, { seedDatabase })).resolves.toMatchObject({ seeded: true, reason: "seeded" });

        expect(seedDatabase).toHaveBeenCalledWith(expect.objectContaining({
          sourceConfigPath: canonicalSource,
          expectedCompanyId: "company-1",
        }));
        expect(readWorktreeSeedManifest(targetConfigPath)).toMatchObject({
          source: {
            configPath: canonicalSource,
            instanceId: "registered-source",
          },
          state: "verified",
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              message: "Re-derived seed source diagnostics from the registered canonical source.",
            }),
          ]),
        });
        expect(fs.existsSync(path.join(targetRoot, ".paperclip", "seed.lock"))).toBe(false);
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("ensure-seeded records a target shutdown diagnostic when restore fails", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-ensure-seeded-failure-"));
    try {
      const sourceConfigPath = path.join(tempRoot, "source", "config.json");
      const targetRoot = path.join(tempRoot, "worktree");
      const targetConfigPath = path.join(targetRoot, ".paperclip", "config.json");
      const targetPaths = resolveWorktreeLocalPaths({
        cwd: targetRoot,
        homeDir: path.join(tempRoot, "worktree-home"),
        instanceId: "ensure-seeded-failure",
      });
      const sourceConfig = buildSourceConfig();
      const targetConfig = buildWorktreeConfig({
        sourceConfig,
        paths: targetPaths,
        serverPort: 3198,
        databasePort: 54998,
      });
      fs.mkdirSync(path.dirname(sourceConfigPath), { recursive: true });
      fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
      fs.writeFileSync(sourceConfigPath, `${JSON.stringify(sourceConfig)}\n`);
      fs.writeFileSync(path.join(path.dirname(sourceConfigPath), ".env"), "PAPERCLIP_INSTANCE_ID=source\n");
      fs.writeFileSync(targetConfigPath, `${JSON.stringify(targetConfig)}\n`);
      fs.writeFileSync(
        path.join(targetRoot, ".paperclip", ".env"),
        `PAPERCLIP_HOME=${targetPaths.homeDir}\nPAPERCLIP_INSTANCE_ID=${targetPaths.instanceId}\n`,
      );
      markWorktreeSeedPending({ configPath: targetConfigPath, sourceConfigPath });

      await expect(
        ensureWorktreeSeeded(
          { config: targetConfigPath, fromConfig: sourceConfigPath },
          {
            seedDatabase: vi.fn(async (input) => {
              input.onPhase?.("restore", "started");
              throw new Error(
                "Failed to restore seed.sql.gz: FATAL: the database system is shutting down; psql error: write EPIPE",
              );
            }),
          },
        ),
      ).rejects.toThrow("database system is shutting down");

      expect(readWorktreeSeedManifest(targetConfigPath)).toMatchObject({
        state: "failed",
        phase: "restore",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            phase: "restore",
            status: "failed",
            message:
              "Target embedded PostgreSQL shut down during restore. Stop any competing worktree service and retry the seed.",
          }),
        ]),
      });
      expect(fs.existsSync(path.join(targetRoot, ".paperclip", "seed-pending"))).toBe(false);
      expect(fs.existsSync(path.join(targetRoot, ".paperclip", "seed-complete"))).toBe(false);
      expect(fs.existsSync(path.join(targetRoot, ".paperclip", "seed.lock"))).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("serializes concurrent ensure-seeded calls across the seed marker lock", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-ensure-seeded-lock-"));
    try {
      const sourceConfigPath = path.join(tempRoot, "source", "config.json");
      const targetRoot = path.join(tempRoot, "worktree");
      const targetConfigPath = path.join(targetRoot, ".paperclip", "config.json");
      const targetPaths = resolveWorktreeLocalPaths({
        cwd: targetRoot,
        homeDir: path.join(tempRoot, "worktree-home"),
        instanceId: "ensure-seeded-lock",
      });
      const sourceConfig = buildSourceConfig();
      const targetConfig = buildWorktreeConfig({
        sourceConfig,
        paths: targetPaths,
        serverPort: 3197,
        databasePort: 54997,
      });
      fs.mkdirSync(path.dirname(sourceConfigPath), { recursive: true });
      fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
      fs.writeFileSync(sourceConfigPath, `${JSON.stringify(sourceConfig)}\n`);
      fs.writeFileSync(path.join(path.dirname(sourceConfigPath), ".env"), "PAPERCLIP_INSTANCE_ID=source\n");
      fs.writeFileSync(targetConfigPath, `${JSON.stringify(targetConfig)}\n`);
      fs.writeFileSync(
        path.join(targetRoot, ".paperclip", ".env"),
        `PAPERCLIP_HOME=${targetPaths.homeDir}\nPAPERCLIP_INSTANCE_ID=${targetPaths.instanceId}\n`,
      );
      markWorktreeSeedPending({ configPath: targetConfigPath, sourceConfigPath });

      const seedDatabase = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return mockVerifiedSeedResult();
      });

      const results = await Promise.all([
        ensureWorktreeSeeded({ config: targetConfigPath, fromConfig: sourceConfigPath }, { seedDatabase }),
        ensureWorktreeSeeded({ config: targetConfigPath, fromConfig: sourceConfigPath }, { seedDatabase }),
      ]);

      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({ seeded: true, reason: "seeded" }),
        { seeded: false, reason: "verified_manifest" },
      ]));
      expect(seedDatabase).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(targetRoot, ".paperclip", "seed.lock"))).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("records an interrupted phase before retrying to a verified terminal state", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-interrupted-seed-"));
    try {
      const sourceConfigPath = path.join(tempRoot, "source", "config.json");
      const targetRoot = path.join(tempRoot, "worktree");
      const targetConfigPath = path.join(targetRoot, ".paperclip", "config.json");
      const targetPaths = resolveWorktreeLocalPaths({
        cwd: targetRoot,
        homeDir: path.join(tempRoot, "worktree-home"),
        instanceId: "interrupted-seed",
      });
      const sourceConfig = buildSourceConfig();
      const targetConfig = buildWorktreeConfig({
        sourceConfig,
        paths: targetPaths,
        serverPort: 3196,
        databasePort: 54996,
      });
      fs.mkdirSync(path.dirname(sourceConfigPath), { recursive: true });
      fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
      fs.writeFileSync(sourceConfigPath, `${JSON.stringify(sourceConfig)}\n`);
      fs.writeFileSync(path.join(path.dirname(sourceConfigPath), ".env"), "PAPERCLIP_INSTANCE_ID=source\n");
      fs.writeFileSync(targetConfigPath, `${JSON.stringify(targetConfig)}\n`);
      fs.writeFileSync(
        path.join(targetRoot, ".paperclip", ".env"),
        `PAPERCLIP_HOME=${targetPaths.homeDir}\nPAPERCLIP_INSTANCE_ID=${targetPaths.instanceId}\n`,
      );
      markWorktreeSeedPending({ configPath: targetConfigPath, sourceConfigPath });
      const interrupted = readWorktreeSeedManifest(targetConfigPath)!;
      fs.writeFileSync(
        path.join(targetRoot, ".paperclip", "seed-manifest.json"),
        `${JSON.stringify({ ...interrupted, state: "running", phase: "restore" }, null, 2)}\n`,
      );

      await expect(ensureWorktreeSeeded(
        { config: targetConfigPath, fromConfig: sourceConfigPath },
        { seedDatabase: vi.fn().mockResolvedValue(mockVerifiedSeedResult()) },
      )).resolves.toMatchObject({ seeded: true, reason: "seeded" });

      const verified = readWorktreeSeedManifest(targetConfigPath)!;
      expect(verified.state).toBe("verified");
      expect(verified.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          phase: "restore",
          status: "failed",
          message: "The previous seed attempt ended without a terminal result.",
        }),
      ]));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed instead of racing to reclaim a stale seed lock", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-ensure-seeded-stale-lock-"));
    try {
      const targetConfigPath = path.join(tempRoot, ".paperclip", "config.json");
      const lockPath = path.join(tempRoot, ".paperclip", "seed.lock");
      fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({
          version: 1,
          pid: 2_147_483_647,
          token: "stale-owner",
          createdAt: new Date(0).toISOString(),
        })}\n`,
      );
      const seedDatabase = vi.fn();

      await expect(
        ensureWorktreeSeeded({ config: targetConfigPath }, { seedDatabase }),
      ).rejects.toThrow("belongs to exited process");

      expect(seedDatabase).not.toHaveBeenCalled();
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  itEmbeddedPostgres("quarantines copied live execution state in seeded worktree databases", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-quarantine-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const idleAgentId = randomUUID();
    const inProgressIssueId = randomUUID();
    const todoIssueId = randomUUID();
    const reviewIssueId = randomUUID();
    const userIssueId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const runtimeServiceId = randomUUID();
    const wakeupId = randomUUID();
    const completedWakeupId = randomUUID();
    const queuedRunId = randomUUID();
    const runningRunId = randomUUID();
    const succeededRunId = randomUUID();

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: "WTQ",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values([
        {
          id: agentId,
          companyId,
          name: "CodexCoder",
          role: "engineer",
          status: "running",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {
            heartbeat: { enabled: true, intervalSec: 60 },
            wakeOnDemand: true,
          },
          permissions: {},
        },
        {
          id: idleAgentId,
          companyId,
          name: "Reviewer",
          role: "reviewer",
          status: "idle",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: { heartbeat: { enabled: false, intervalSec: 300 } },
          permissions: {},
        },
      ]);
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Runtime quarantine",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Primary workspace",
        cwd: "/source/project",
        metadata: {
          keep: "project-metadata",
          runtimeConfig: {
            workspaceRuntime: { services: [{ name: "paperclip-dev" }] },
            desiredState: "running",
            serviceStates: { "0": "running", "1": "manual" },
          },
        },
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Copied runtime workspace",
        cwd: "/source/worktree",
        providerType: "git_worktree",
        metadata: {
          keep: "execution-metadata",
          config: {
            environmentId: "environment-1",
            desiredState: "running",
            serviceStates: { "0": "running" },
          },
        },
      });
      await db.insert(workspaceRuntimeServices).values({
        id: runtimeServiceId,
        companyId,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId,
        scopeType: "project_workspace",
        scopeId: projectWorkspaceId,
        serviceName: "paperclip-dev",
        status: "running",
        lifecycle: "shared",
        provider: "local_process",
        providerRef: "12345",
        ownerAgentId: agentId,
        port: 42013,
        url: "https://paperclip-dev.example.test:42013",
        healthStatus: "healthy",
      });
      await db.insert(issues).values([
        {
          id: inProgressIssueId,
          companyId,
          title: "Copied in-flight issue",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 1,
          identifier: "WTQ-1",
          executionAgentNameKey: "codexcoder",
          executionLockedAt: new Date("2026-04-18T00:00:00.000Z"),
          monitorNextCheckAt: new Date("2026-04-18T00:01:00.000Z"),
          monitorWakeRequestedAt: new Date("2026-04-18T00:00:30.000Z"),
          monitorLastTriggeredAt: new Date("2026-04-18T00:00:00.000Z"),
          monitorAttemptCount: 2,
          monitorNotes: "copied monitor state",
        },
        {
          id: todoIssueId,
          companyId,
          title: "Copied assigned todo issue",
          status: "todo",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 2,
          identifier: "WTQ-2",
        },
        {
          id: reviewIssueId,
          companyId,
          title: "Copied assigned review issue",
          status: "in_review",
          priority: "medium",
          assigneeAgentId: idleAgentId,
          issueNumber: 3,
          identifier: "WTQ-3",
        },
        {
          id: userIssueId,
          companyId,
          title: "Copied user issue",
          status: "todo",
          priority: "medium",
          assigneeUserId: "user-1",
          issueNumber: 4,
          identifier: "WTQ-4",
        },
      ]);
      await db.insert(agentWakeupRequests).values([
        {
          id: wakeupId,
          companyId,
          agentId,
          source: "system",
          status: "queued",
        },
        {
          id: completedWakeupId,
          companyId,
          agentId,
          source: "system",
          status: "completed",
        },
      ]);
      await db.insert(heartbeatRuns).values([
        {
          id: queuedRunId,
          companyId,
          agentId,
          status: "queued",
          wakeupRequestId: wakeupId,
          processPid: 1234,
          processGroupId: 1234,
        },
        {
          id: runningRunId,
          companyId,
          agentId,
          status: "running",
          processPid: 5678,
          processGroupId: 5678,
        },
        {
          id: succeededRunId,
          companyId,
          agentId,
          status: "succeeded",
          wakeupRequestId: completedWakeupId,
        },
      ]);

      await expect(quarantineSeededWorktreeExecutionState(tempDb.connectionString)).resolves.toEqual({
        cancelledHeartbeatRuns: 2,
        deletedPendingWakeups: 1,
        clearedIssueMonitors: 1,
        disabledTimerHeartbeats: 1,
        resetRunningAgents: 1,
        quarantinedInProgressIssues: 1,
        unassignedTodoIssues: 1,
        unassignedReviewIssues: 1,
        stoppedProjectWorkspaceRuntimes: 1,
        stoppedExecutionWorkspaceRuntimes: 1,
        stoppedRuntimeServices: 1,
      });

      const [quarantinedAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(quarantinedAgent?.status).toBe("idle");
      expect(quarantinedAgent?.runtimeConfig).toMatchObject({
        heartbeat: { enabled: false, intervalSec: 60 },
        wakeOnDemand: true,
      });

      const [inProgressIssue] = await db.select().from(issues).where(eq(issues.id, inProgressIssueId));
      expect(inProgressIssue?.status).toBe("blocked");
      expect(inProgressIssue?.assigneeAgentId).toBeNull();
      expect(inProgressIssue?.executionAgentNameKey).toBeNull();
      expect(inProgressIssue?.executionLockedAt).toBeNull();
      expect(inProgressIssue?.monitorNextCheckAt).toBeNull();
      expect(inProgressIssue?.monitorWakeRequestedAt).toBeNull();
      expect(inProgressIssue?.monitorLastTriggeredAt).toBeNull();
      expect(inProgressIssue?.monitorAttemptCount).toBe(0);
      expect(inProgressIssue?.monitorNotes).toBeNull();

      const quarantinedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, [queuedRunId, runningRunId]));
      expect(quarantinedRuns).toHaveLength(2);
      for (const run of quarantinedRuns) {
        expect(run.status).toBe("cancelled");
        expect(run.errorCode).toBe("worktree_seed_quarantine");
        expect(run.seedEpoch).toEqual(expect.any(String));
        expect(run.processPid).toBeNull();
        expect(run.processGroupId).toBeNull();
        expect(run.finishedAt).toBeInstanceOf(Date);
      }

      const [seededSettings] = await db.select().from(instanceSettings);
      const seededExperimental = seededSettings?.experimental as Record<string, unknown>;
      expect(quarantinedRuns.map((run) => run.seedEpoch)).toEqual([
        seededExperimental.worktreeRunExecutionSeedEpoch,
        seededExperimental.worktreeRunExecutionSeedEpoch,
      ]);

      const [succeededRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, succeededRunId));
      expect(succeededRun?.status).toBe("succeeded");
      expect(succeededRun?.wakeupRequestId).toBe(completedWakeupId);

      const wakeups = await db.select().from(agentWakeupRequests);
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]?.id).toBe(completedWakeupId);

      const [todoIssue] = await db.select().from(issues).where(eq(issues.id, todoIssueId));
      expect(todoIssue?.status).toBe("todo");
      expect(todoIssue?.assigneeAgentId).toBeNull();

      const [reviewIssue] = await db.select().from(issues).where(eq(issues.id, reviewIssueId));
      expect(reviewIssue?.status).toBe("in_review");
      expect(reviewIssue?.assigneeAgentId).toBeNull();

      const [userIssue] = await db.select().from(issues).where(eq(issues.id, userIssueId));
      expect(userIssue?.status).toBe("todo");
      expect(userIssue?.assigneeUserId).toBe("user-1");

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, inProgressIssueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("Quarantined during worktree seed");

      const [projectWorkspace] = await db
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, projectWorkspaceId));
      expect(projectWorkspace?.metadata).toEqual({
        keep: "project-metadata",
        runtimeConfig: {
          workspaceRuntime: { services: [{ name: "paperclip-dev" }] },
          desiredState: "stopped",
          serviceStates: { "0": "stopped", "1": "manual" },
        },
      });

      const [executionWorkspace] = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, executionWorkspaceId));
      expect(executionWorkspace?.metadata).toEqual({
        keep: "execution-metadata",
        config: {
          environmentId: "environment-1",
          desiredState: "stopped",
          serviceStates: { "0": "stopped" },
        },
      });

      const [runtimeService] = await db
        .select()
        .from(workspaceRuntimeServices)
        .where(eq(workspaceRuntimeServices.id, runtimeServiceId));
      expect(runtimeService).toMatchObject({
        status: "stopped",
        healthStatus: "unknown",
        providerRef: null,
        ownerAgentId: null,
        startedByRunId: null,
        port: null,
        url: null,
      });
      expect(runtimeService?.stoppedAt).toBeInstanceOf(Date);
    } finally {
      await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
      await tempDb.cleanup();
    }
  }, 20_000);

  itEmbeddedPostgres("always disarms copied worktree run execution settings", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-activation-reset-");
    const db = createDb(tempDb.connectionString);

    try {
      await db
        .update(instanceSettings)
        .set({
          experimental: {
            enableWorktreeRunExecution: true,
            worktreeRunExecutionInstanceNonce: "9ed115ac-9e93-4fe9-a4f1-eb4ea2b0fb24",
            worktreeRunExecutionSeedEpoch: "cb1137c7-5630-44b9-a213-762203cc4a38",
            worktreeRunExecutionActivatedAt: "2026-07-16T12:00:00.000Z",
            worktreeRunExecutionActivationInstanceId: "source-instance",
            enableSmokeLab: true,
          },
        })
        .where(eq(instanceSettings.singletonKey, "default"));

      await expect(resetSeededWorktreeRunExecutionActivation(tempDb.connectionString)).resolves.toBe(1);

      const [settings] = await db.select().from(instanceSettings);
      expect(settings?.experimental).toMatchObject({
        enableWorktreeRunExecution: false,
        worktreeRunExecutionInstanceNonce: null,
        worktreeRunExecutionSeedEpoch: expect.any(String),
        worktreeRunExecutionActivatedAt: null,
        worktreeRunExecutionActivationInstanceId: null,
        enableSmokeLab: true,
      });
    } finally {
      await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
      await tempDb.cleanup();
    }
  }, 20_000);

  it("copies the source local_encrypted secrets key into the seeded worktree instance", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-secrets-"));
    const originalInlineMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    const originalKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    try {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      const sourceConfigPath = path.join(tempRoot, "source", "config.json");
      const sourceKeyPath = path.join(tempRoot, "source", "secrets", "master.key");
      const targetKeyPath = path.join(tempRoot, "target", "secrets", "master.key");
      fs.mkdirSync(path.dirname(sourceKeyPath), { recursive: true });
      fs.writeFileSync(sourceKeyPath, "source-master-key", "utf8");

      const sourceConfig = buildSourceConfig();
      sourceConfig.secrets.localEncrypted.keyFilePath = sourceKeyPath;

      copySeededSecretsKey({
        sourceConfigPath,
        sourceConfig,
        sourceEnvEntries: {},
        targetKeyFilePath: targetKeyPath,
      });

      expect(fs.readFileSync(targetKeyPath, "utf8")).toBe("source-master-key");
    } finally {
      if (originalInlineMasterKey === undefined) {
        delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      } else {
        process.env.PAPERCLIP_SECRETS_MASTER_KEY = originalInlineMasterKey;
      }
      if (originalKeyFile === undefined) {
        delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      } else {
        process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = originalKeyFile;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes the source inline secrets master key into the seeded worktree instance", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-secrets-"));
    try {
      const sourceConfigPath = path.join(tempRoot, "source", "config.json");
      const targetKeyPath = path.join(tempRoot, "target", "secrets", "master.key");

      copySeededSecretsKey({
        sourceConfigPath,
        sourceConfig: buildSourceConfig(),
        sourceEnvEntries: {
          PAPERCLIP_SECRETS_MASTER_KEY: "inline-source-master-key",
        },
        targetKeyFilePath: targetKeyPath,
      });

      expect(fs.readFileSync(targetKeyPath, "utf8")).toBe("inline-source-master-key");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists the current agent jwt secret into the worktree env file", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-jwt-"));
    const repoRoot = path.join(tempRoot, "repo");
    const originalCwd = process.cwd();
    const originalJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      process.env.PAPERCLIP_AGENT_JWT_SECRET = "worktree-shared-secret";
      process.chdir(repoRoot);

      await worktreeInitCommand({
        seed: false,
        fromConfig: path.join(tempRoot, "missing", "config.json"),
        home: path.join(tempRoot, ".paperclip-worktrees"),
      });

      const envPath = path.join(repoRoot, ".paperclip", ".env");
      const envContents = fs.readFileSync(envPath, "utf8");
      expect(envContents).toContain("PAPERCLIP_AGENT_JWT_SECRET=worktree-shared-secret");
      expect(envContents).toContain("PAPERCLIP_WORKTREE_NAME=repo");
      expect(envContents).toMatch(/PAPERCLIP_WORKTREE_COLOR=\"#[0-9a-f]{6}\"/);
    } finally {
      process.chdir(originalCwd);
      if (originalJwtSecret === undefined) {
        delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      } else {
        process.env.PAPERCLIP_AGENT_JWT_SECRET = originalJwtSecret;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves repo-managed worktree checkouts when --force re-runs from the source repo", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-force-preserve-"));
    const repoRoot = path.join(tempRoot, "repo");
    const originalCwd = process.cwd();

    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      const repoConfigDir = path.join(repoRoot, ".paperclip");
      fs.mkdirSync(repoConfigDir, { recursive: true });
      fs.writeFileSync(path.join(repoConfigDir, "config.json"), "stale", "utf8");
      fs.writeFileSync(path.join(repoConfigDir, ".env"), "STALE=1", "utf8");

      // Simulate the repo-managed worktrees subfolder that holds every
      // worktree checkout (the directory PAPA-358 reported as nuked).
      const worktreesDir = path.join(repoConfigDir, "worktrees");
      const checkoutDir = path.join(worktreesDir, "PAP-100-feature");
      fs.mkdirSync(checkoutDir, { recursive: true });
      const sentinelPath = path.join(checkoutDir, "sentinel.txt");
      fs.writeFileSync(sentinelPath, "do-not-delete", "utf8");

      process.chdir(repoRoot);

      await worktreeInitCommand({
        seed: false,
        force: true,
        fromConfig: path.join(tempRoot, "missing", "config.json"),
        home: path.join(tempRoot, ".paperclip-worktrees"),
      });

      expect(fs.existsSync(sentinelPath)).toBe(true);
      expect(fs.readFileSync(sentinelPath, "utf8")).toBe("do-not-delete");
      expect(fs.existsSync(path.join(repoConfigDir, "config.json"))).toBe(true);
      expect(fs.readFileSync(path.join(repoConfigDir, "config.json"), "utf8")).not.toBe("stale");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  itEmbeddedPostgres(
    "seeds a local-trusted implicit board user without a credential account",
    async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-local-board-seed-"));
      const worktreeRoot = path.join(tempRoot, "PAP-17696-local-board-seed");
      const sourceConfigDir = path.join(tempRoot, "source");
      const sourceConfigPath = path.join(sourceConfigDir, "config.json");
      const sourceKeyPath = path.join(sourceConfigDir, "secrets", "master.key");
      const worktreeHome = path.join(tempRoot, ".paperclip-worktrees");
      const originalCwd = process.cwd();
      const sourceDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-local-board-source-");

      try {
        await seedValidWorktreeSource(sourceDb.connectionString, {
          includeCredentialAccount: false,
          userId: "local-board",
        });
        fs.mkdirSync(path.dirname(sourceKeyPath), { recursive: true });
        fs.mkdirSync(worktreeRoot, { recursive: true });

        const sourceConfig = buildSourceConfig();
        sourceConfig.database = {
          ...sourceConfig.database,
          mode: "postgres",
          connectionString: sourceDb.connectionString,
        };
        sourceConfig.server.deploymentMode = "local_trusted";
        sourceConfig.server.exposure = "private";
        sourceConfig.auth.baseUrlMode = "auto";
        delete sourceConfig.auth.publicBaseUrl;
        sourceConfig.secrets.localEncrypted.keyFilePath = sourceKeyPath;

        fs.writeFileSync(sourceConfigPath, `${JSON.stringify(sourceConfig, null, 2)}\n`, "utf8");
        fs.writeFileSync(sourceKeyPath, "source-master-key", "utf8");

        process.chdir(worktreeRoot);
        await worktreeInitCommand({
          name: "PAP-17696-local-board-seed",
          home: worktreeHome,
          fromConfig: sourceConfigPath,
          force: true,
        });

        const targetConfigPath = path.join(worktreeRoot, ".paperclip", "config.json");
        const targetConfig = JSON.parse(fs.readFileSync(targetConfigPath, "utf8")) as PaperclipConfig;
        expect(readWorktreeSeedManifest(targetConfigPath)).toMatchObject({
          state: "verified",
          phase: "complete",
        });

        const { default: EmbeddedPostgres } = await import("embedded-postgres");
        const targetPg = new EmbeddedPostgres({
          databaseDir: targetConfig.database.embeddedPostgresDataDir,
          user: "paperclip",
          password: "paperclip",
          port: targetConfig.database.embeddedPostgresPort,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
          onLog: () => {},
          onError: () => {},
        });

        await targetPg.start();
        try {
          const targetDb = createDb(
            `postgres://paperclip:paperclip@127.0.0.1:${targetConfig.database.embeddedPostgresPort}/paperclip`,
          );
          const [seededLocalBoard] = await targetDb
            .select({ id: authUsers.id })
            .from(authUsers)
            .where(eq(authUsers.id, "local-board"));
          const seededAccounts = await targetDb.select().from(authAccounts);
          expect(seededLocalBoard?.id).toBe("local-board");
          expect(seededAccounts).toHaveLength(0);
          await targetDb.$client.end({ timeout: 5 });
        } finally {
          await targetPg.stop();
        }
      } finally {
        process.chdir(originalCwd);
        await sourceDb.cleanup();
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    // This test starts three separate embedded Postgres lifecycles (the
    // source database, the worktree init's internal target database, and a
    // third instance opened here to verify the seeded rows), so it needs
    // more headroom than the other embedded-Postgres tests in this file.
    // It normally finishes in well under 10s; the 60s budget absorbs CI
    // runner contention without masking a real hang.
    60_000,
  );

  itEmbeddedPostgres(
    "seeds a lagging source whose migration application order differs from filename order",
    async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-auth-seed-"));
      const worktreeRoot = path.join(tempRoot, "PAP-999-auth-seed");
      const sourceHome = path.join(tempRoot, "source-home");
      const sourceConfigDir = path.join(sourceHome, "instances", "source");
      const sourceConfigPath = path.join(sourceConfigDir, "config.json");
      const sourceEnvPath = path.join(sourceConfigDir, ".env");
      const sourceKeyPath = path.join(sourceConfigDir, "secrets", "master.key");
      const worktreeHome = path.join(tempRoot, ".paperclip-worktrees");
      const originalCwd = process.cwd();
      const sourceDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-auth-source-");

      try {
        await seedValidWorktreeSource(sourceDb.connectionString);
        const sourceDbClient = createDb(sourceDb.connectionString);
        await sourceDbClient.$client.unsafe(`
          DELETE FROM "drizzle"."__drizzle_migrations"
          WHERE "id" = (
            SELECT max("id") FROM "drizzle"."__drizzle_migrations"
          );

          WITH pair AS (
            SELECT
              array_agg("id" ORDER BY "id" DESC) AS ids,
              array_agg("hash" ORDER BY "id" DESC) AS hashes
            FROM (
              SELECT "id", "hash"
              FROM "drizzle"."__drizzle_migrations"
              ORDER BY "id" DESC
              LIMIT 2
            ) latest
          )
          UPDATE "drizzle"."__drizzle_migrations" migrations
          SET "hash" = CASE
            WHEN migrations."id" = pair.ids[1] THEN pair.hashes[2]
            WHEN migrations."id" = pair.ids[2] THEN pair.hashes[1]
            ELSE migrations."hash"
          END
          FROM pair
          WHERE migrations."id" IN (pair.ids[1], pair.ids[2]);

          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('stale-unresolvable-migration-hash', 0)
        `);
        await sourceDbClient.$client.end({ timeout: 5 });
        const laggingMigrationState = await inspectMigrations(sourceDb.connectionString);
        expect(laggingMigrationState.status).toBe("needsMigrations");
        if (laggingMigrationState.status !== "needsMigrations") {
          throw new Error("Expected the source migration journal to lag the code journal");
        }
        expect(laggingMigrationState.pendingMigrations).toHaveLength(1);
        const expectedAppliedPrefix = laggingMigrationState.availableMigrations.slice(
          0,
          laggingMigrationState.appliedMigrations.length,
        );
        expect(laggingMigrationState.appliedMigrations).not.toEqual(expectedAppliedPrefix);
        expect([...laggingMigrationState.appliedMigrations].sort()).toEqual(
          [...expectedAppliedPrefix].sort(),
        );
        expect(laggingMigrationState.journalEntryCount).toBeGreaterThan(
          laggingMigrationState.appliedMigrations.length,
        );
        const sourceMigrationRevision = expectedAppliedPrefix.at(-1);
        expect(sourceMigrationRevision).toBeTruthy();

        fs.mkdirSync(path.dirname(sourceKeyPath), { recursive: true });
        fs.mkdirSync(worktreeRoot, { recursive: true });

        const sourceConfig = buildSourceConfig();
        sourceConfig.database = {
          mode: "postgres",
          embeddedPostgresDataDir: path.join(sourceConfigDir, "db"),
          embeddedPostgresPort: 54329,
          backup: {
            enabled: true,
            intervalMinutes: 60,
            retentionDays: 30,
            dir: path.join(sourceConfigDir, "backups"),
          },
          connectionString: sourceDb.connectionString,
        };
        sourceConfig.logging.logDir = path.join(sourceConfigDir, "logs");
        sourceConfig.storage.localDisk.baseDir = path.join(sourceConfigDir, "storage");
        sourceConfig.secrets.localEncrypted.keyFilePath = sourceKeyPath;

        fs.writeFileSync(sourceConfigPath, JSON.stringify(sourceConfig, null, 2) + "\n", "utf8");
        fs.writeFileSync(sourceEnvPath, "", "utf8");
        fs.writeFileSync(sourceKeyPath, "source-master-key", "utf8");

        process.chdir(worktreeRoot);
        await worktreeInitCommand({
          name: "PAP-999-auth-seed",
          home: worktreeHome,
          fromConfig: sourceConfigPath,
          force: true,
        });

        const targetConfig = JSON.parse(
          fs.readFileSync(path.join(worktreeRoot, ".paperclip", "config.json"), "utf8"),
        ) as PaperclipConfig;
        const manifestText = fs.readFileSync(
          path.join(worktreeRoot, ".paperclip", "seed-manifest.json"),
          "utf8",
        );
        expect(JSON.parse(manifestText)).toMatchObject({
          version: 2,
          seedMode: "minimal",
          state: "verified",
          phase: "complete",
        });
        expect(manifestText).toContain(`Validated migration ${sourceMigrationRevision}`);
        expect(manifestText).not.toContain("fixture-password-hash");
        expect(manifestText).not.toContain("source-master-key");
        const { default: EmbeddedPostgres } = await import("embedded-postgres");
        const targetPg = new EmbeddedPostgres({
          databaseDir: targetConfig.database.embeddedPostgresDataDir,
          user: "paperclip",
          password: "paperclip",
          port: targetConfig.database.embeddedPostgresPort,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
          onLog: () => {},
          onError: () => {},
        });

        await targetPg.start();
        try {
          const targetDb = createDb(
            `postgres://paperclip:paperclip@127.0.0.1:${targetConfig.database.embeddedPostgresPort}/paperclip`,
          );
          const seededUsers = await targetDb.select().from(authUsers);
          expect(seededUsers.some((row) => row.email === "existing@paperclip.ing")).toBe(true);
        } finally {
          await targetPg.stop();
        }
      } finally {
        process.chdir(originalCwd);
        await sourceDb.cleanup();
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    30000,
  );

  it("avoids ports already claimed by sibling worktree instance configs", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-claimed-ports-"));
    const repoRoot = path.join(tempRoot, "repo");
    const homeDir = path.join(tempRoot, ".paperclip-worktrees");
    const siblingInstanceRoot = path.join(homeDir, "instances", "existing-worktree");
    const originalCwd = process.cwd();

    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(siblingInstanceRoot, { recursive: true });
      fs.writeFileSync(
        path.join(siblingInstanceRoot, "config.json"),
        JSON.stringify(
          {
            ...buildSourceConfig(),
            database: {
              mode: "embedded-postgres",
              embeddedPostgresDataDir: path.join(siblingInstanceRoot, "db"),
              embeddedPostgresPort: 54330,
              backup: {
                enabled: true,
                intervalMinutes: 60,
                retentionDays: 30,
                dir: path.join(siblingInstanceRoot, "backups"),
              },
            },
            logging: {
              mode: "file",
              logDir: path.join(siblingInstanceRoot, "logs"),
            },
            server: {
              deploymentMode: "authenticated",
              exposure: "private",
              host: "127.0.0.1",
              port: 3101,
              allowedHostnames: ["localhost"],
              serveUi: true,
            },
            storage: {
              provider: "local_disk",
              localDisk: {
                baseDir: path.join(siblingInstanceRoot, "storage"),
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
                keyFilePath: path.join(siblingInstanceRoot, "secrets", "master.key"),
              },
            },
          },
          null,
          2,
        ) + "\n",
      );

      process.chdir(repoRoot);
      await worktreeInitCommand({
        seed: false,
        fromConfig: path.join(tempRoot, "missing", "config.json"),
        home: homeDir,
      });

      const config = JSON.parse(fs.readFileSync(path.join(repoRoot, ".paperclip", "config.json"), "utf8"));
      expect(config.server.port).toBeGreaterThan(3101);
      expect(config.database.embeddedPostgresPort).not.toBe(54330);
      expect(config.database.embeddedPostgresPort).not.toBe(config.server.port);
      expect(config.database.embeddedPostgresPort).toBeGreaterThan(54330);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reserves distinct ports for postgres-mode siblings under a custom worktree parent", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-custom-parent-"));
    const homeDir = path.join(tempRoot, ".paperclip-worktrees");
    const customParentDir = path.join(tempRoot, "custom", "workspace-lanes");
    const firstWorktreeRoot = path.join(customParentDir, "lane-one");
    const secondWorktreeRoot = path.join(customParentDir, "lane-two");
    const missingSourceConfig = path.join(tempRoot, "missing", "config.json");
    const firstConfigPath = path.join(firstWorktreeRoot, ".paperclip", "config.json");
    const secondConfigPath = path.join(secondWorktreeRoot, ".paperclip", "config.json");
    const originalCwd = process.cwd();

    try {
      fs.mkdirSync(firstWorktreeRoot, { recursive: true });
      fs.mkdirSync(secondWorktreeRoot, { recursive: true });

      process.chdir(firstWorktreeRoot);
      await worktreeInitCommand({
        name: "lane-one",
        seed: false,
        fromConfig: missingSourceConfig,
        home: homeDir,
      });

      const firstConfig = JSON.parse(fs.readFileSync(firstConfigPath, "utf8"));
      firstConfig.database = {
        ...firstConfig.database,
        mode: "postgres",
        connectionString: "postgres://paperclip:paperclip@127.0.0.1:54330/paperclip",
      };
      fs.writeFileSync(firstConfigPath, `${JSON.stringify(firstConfig, null, 2)}\n`, "utf8");

      process.chdir(secondWorktreeRoot);
      await worktreeInitCommand({
        name: "lane-two",
        seed: false,
        fromConfig: missingSourceConfig,
        home: homeDir,
      });

      const secondConfig = JSON.parse(fs.readFileSync(secondConfigPath, "utf8"));
      const registry = JSON.parse(
        fs.readFileSync(path.join(homeDir, "worktree-port-reservations.json"), "utf8"),
      );

      expect(secondConfig.server.port).not.toBe(firstConfig.server.port);
      expect(secondConfig.database.embeddedPostgresPort).not.toBe(
        firstConfig.database.embeddedPostgresPort,
      );
      expect(registry.configPaths).toEqual([firstConfigPath, secondConfigPath].sort());
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("defaults the seed source config to the current repo-local Paperclip config", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-source-config-"));
    const repoRoot = path.join(tempRoot, "repo");
    const localConfigPath = path.join(repoRoot, ".paperclip", "config.json");
    const originalCwd = process.cwd();
    const originalPaperclipConfig = process.env.PAPERCLIP_CONFIG;

    try {
      fs.mkdirSync(path.dirname(localConfigPath), { recursive: true });
      fs.writeFileSync(localConfigPath, JSON.stringify(buildSourceConfig()), "utf8");
      delete process.env.PAPERCLIP_CONFIG;
      process.chdir(repoRoot);

      expect(fs.realpathSync(resolveSourceConfigPath({}))).toBe(fs.realpathSync(localConfigPath));
    } finally {
      process.chdir(originalCwd);
      if (originalPaperclipConfig === undefined) {
        delete process.env.PAPERCLIP_CONFIG;
      } else {
        process.env.PAPERCLIP_CONFIG = originalPaperclipConfig;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves the source config path across worktree:make cwd changes", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-source-override-"));
    const sourceConfigPath = path.join(tempRoot, "source", "config.json");
    const targetRoot = path.join(tempRoot, "target");
    const originalCwd = process.cwd();
    const originalPaperclipConfig = process.env.PAPERCLIP_CONFIG;

    try {
      fs.mkdirSync(path.dirname(sourceConfigPath), { recursive: true });
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(sourceConfigPath, JSON.stringify(buildSourceConfig()), "utf8");
      delete process.env.PAPERCLIP_CONFIG;
      process.chdir(targetRoot);

      expect(resolveSourceConfigPath({ sourceConfigPathOverride: sourceConfigPath })).toBe(
        path.resolve(sourceConfigPath),
      );
    } finally {
      process.chdir(originalCwd);
      if (originalPaperclipConfig === undefined) {
        delete process.env.PAPERCLIP_CONFIG;
      } else {
        process.env.PAPERCLIP_CONFIG = originalPaperclipConfig;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("requires an explicit reseed source", () => {
    expect(() => resolveWorktreeReseedSource({})).toThrow(
      "Pass --from <worktree> or --from-config/--from-instance explicitly so the reseed source is unambiguous.",
    );
  });

  it("rejects mixed reseed source selectors", () => {
    expect(() => resolveWorktreeReseedSource({
      from: "current",
      fromInstance: "default",
    })).toThrow(
      "Use either --from <worktree> or --from-config/--from-data-dir/--from-instance, not both.",
    );
  });

  it("derives worktree reseed target paths from the adjacent env file", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-reseed-target-"));
    const worktreeRoot = path.join(tempRoot, "repo");
    const configPath = path.join(worktreeRoot, ".paperclip", "config.json");
    const envPath = path.join(worktreeRoot, ".paperclip", ".env");

    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(buildSourceConfig()), "utf8");
      fs.writeFileSync(
        envPath,
        [
          "PAPERCLIP_HOME=/tmp/paperclip-worktrees",
          "PAPERCLIP_INSTANCE_ID=pap-1132-chat",
        ].join("\n"),
        "utf8",
      );
      expect(
        resolveWorktreeReseedTargetPaths({
          configPath,
          rootPath: worktreeRoot,
        }),
      ).toMatchObject({
        cwd: worktreeRoot,
        homeDir: "/tmp/paperclip-worktrees",
        instanceId: "pap-1132-chat",
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects reseed targets without worktree env metadata", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-reseed-target-missing-"));
    const worktreeRoot = path.join(tempRoot, "repo");
    const configPath = path.join(worktreeRoot, ".paperclip", "config.json");

    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(buildSourceConfig()), "utf8");
      fs.writeFileSync(path.join(worktreeRoot, ".paperclip", ".env"), "", "utf8");

      expect(() =>
        resolveWorktreeReseedTargetPaths({
          configPath,
          rootPath: worktreeRoot,
        })).toThrow("does not look like a worktree-local Paperclip instance");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses streaming backup selection for full seeds and transformed backup selection for minimal seeds", () => {
    expect(resolveWorktreeSeedBackupEngine(resolveWorktreeSeedPlan("full"))).toBe("auto");
    expect(resolveWorktreeSeedBackupEngine(resolveWorktreeSeedPlan("minimal"))).toBe("javascript");
  });

  itEmbeddedPostgres("reseed preserves the current worktree ports, instance id, and branding", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-reseed-"));
    const repoRoot = path.join(tempRoot, "repo");
    const sourceRoot = path.join(tempRoot, "source");
    const homeDir = path.join(tempRoot, ".paperclip-worktrees");
    const currentInstanceId = "existing-worktree";
    const currentPaths = resolveWorktreeLocalPaths({
      cwd: repoRoot,
      homeDir,
      instanceId: currentInstanceId,
    });
    const sourcePaths = resolveWorktreeLocalPaths({
      cwd: sourceRoot,
      homeDir: path.join(tempRoot, ".paperclip-source"),
      instanceId: "default",
    });
    const originalCwd = process.cwd();
    const originalPaperclipConfig = process.env.PAPERCLIP_CONFIG;
    const currentDatabaseReservation = await reserveTestPort();
    const currentDatabasePort = currentDatabaseReservation.port;
    const sourceDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-reseed-source-");

    try {
      fs.mkdirSync(path.dirname(currentPaths.configPath), { recursive: true });
      fs.mkdirSync(path.dirname(sourcePaths.configPath), { recursive: true });
      fs.mkdirSync(path.dirname(sourcePaths.secretsKeyFilePath), { recursive: true });
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(sourceRoot, { recursive: true });

      const currentConfig = buildWorktreeConfig({
        sourceConfig: buildSourceConfig(),
        paths: currentPaths,
        serverPort: 3114,
        databasePort: currentDatabasePort,
      });
      const sourceConfig = buildSourceConfig();
      sourceConfig.database = {
        mode: "postgres",
        embeddedPostgresDataDir: sourcePaths.embeddedPostgresDataDir,
        embeddedPostgresPort: 54329,
        backup: {
          enabled: true,
          intervalMinutes: 60,
          retentionDays: 30,
          dir: sourcePaths.backupDir,
        },
        connectionString: sourceDb.connectionString,
      };
      sourceConfig.logging.logDir = sourcePaths.logDir;
      sourceConfig.storage.localDisk.baseDir = sourcePaths.storageDir;
      sourceConfig.secrets.localEncrypted.keyFilePath = sourcePaths.secretsKeyFilePath;
      await seedValidWorktreeSource(sourceDb.connectionString);
      fs.writeFileSync(currentPaths.configPath, JSON.stringify(currentConfig, null, 2), "utf8");
      fs.writeFileSync(sourcePaths.configPath, JSON.stringify(sourceConfig, null, 2), "utf8");
      fs.writeFileSync(sourcePaths.secretsKeyFilePath, "source-secret", "utf8");
      const worktreeSentinelPath = path.join(repoRoot, "user-worktree-file.txt");
      fs.writeFileSync(worktreeSentinelPath, "preserve me", "utf8");
      fs.writeFileSync(
        currentPaths.envPath,
        [
          `PAPERCLIP_HOME=${homeDir}`,
          `PAPERCLIP_INSTANCE_ID=${currentInstanceId}`,
          "PAPERCLIP_WORKTREE_NAME=existing-name",
          "PAPERCLIP_WORKTREE_COLOR=\"#112233\"",
        ].join("\n"),
        "utf8",
      );

      delete process.env.PAPERCLIP_CONFIG;
      process.chdir(repoRoot);

      await currentDatabaseReservation.release();

      await worktreeReseedCommand({
        fromConfig: sourcePaths.configPath,
        yes: true,
        backupTarget: true,
      });

      const rewrittenConfig = JSON.parse(fs.readFileSync(currentPaths.configPath, "utf8"));
      const rewrittenEnv = fs.readFileSync(currentPaths.envPath, "utf8");

      expect(rewrittenConfig.server.port).toBe(3114);
      expect(rewrittenConfig.database.embeddedPostgresPort).toBe(currentDatabasePort);
      expect(rewrittenConfig.database.embeddedPostgresDataDir).toBe(currentPaths.embeddedPostgresDataDir);
      expect(rewrittenEnv).toContain(`PAPERCLIP_INSTANCE_ID=${currentInstanceId}`);
      expect(rewrittenEnv).toContain("PAPERCLIP_WORKTREE_NAME=existing-name");
      expect(rewrittenEnv).toContain("PAPERCLIP_WORKTREE_COLOR=\"#112233\"");
      expect(fs.readFileSync(worktreeSentinelPath, "utf8")).toBe("preserve me");
      expect(
        fs.readdirSync(path.join(currentPaths.backupDir, "repair")).some((name) => name.endsWith(".sql.gz")),
      ).toBe(true);
    } finally {
      await currentDatabaseReservation.release();
      await sourceDb.cleanup();
      process.chdir(originalCwd);
      if (originalPaperclipConfig === undefined) {
        delete process.env.PAPERCLIP_CONFIG;
      } else {
        process.env.PAPERCLIP_CONFIG = originalPaperclipConfig;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("restores the current worktree config and instance data if reseed fails", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-reseed-rollback-"));
    const repoRoot = path.join(tempRoot, "repo");
    const sourceRoot = path.join(tempRoot, "source");
    const homeDir = path.join(tempRoot, ".paperclip-worktrees");
    const currentInstanceId = "rollback-worktree";
    const currentPaths = resolveWorktreeLocalPaths({
      cwd: repoRoot,
      homeDir,
      instanceId: currentInstanceId,
    });
    const sourcePaths = resolveWorktreeLocalPaths({
      cwd: sourceRoot,
      homeDir: path.join(tempRoot, ".paperclip-source"),
      instanceId: "default",
    });
    const originalCwd = process.cwd();
    const originalPaperclipConfig = process.env.PAPERCLIP_CONFIG;

    try {
      fs.mkdirSync(path.dirname(currentPaths.configPath), { recursive: true });
      fs.mkdirSync(path.dirname(sourcePaths.configPath), { recursive: true });
      fs.mkdirSync(currentPaths.instanceRoot, { recursive: true });
      fs.mkdirSync(path.dirname(sourcePaths.secretsKeyFilePath), { recursive: true });
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(sourceRoot, { recursive: true });

      const currentConfig = buildWorktreeConfig({
        sourceConfig: buildSourceConfig(),
        paths: currentPaths,
        serverPort: 3114,
        databasePort: 54341,
      });
      const sourceConfig = {
        ...buildSourceConfig(),
        database: {
          mode: "postgres",
          connectionString: "",
        },
        secrets: {
          provider: "local_encrypted",
          strictMode: false,
          localEncrypted: {
            keyFilePath: sourcePaths.secretsKeyFilePath,
          },
        },
      } as PaperclipConfig;

      fs.writeFileSync(currentPaths.configPath, JSON.stringify(currentConfig, null, 2), "utf8");
      fs.writeFileSync(currentPaths.envPath, `PAPERCLIP_HOME=${homeDir}\nPAPERCLIP_INSTANCE_ID=${currentInstanceId}\n`, "utf8");
      fs.writeFileSync(path.join(currentPaths.instanceRoot, "marker.txt"), "keep me", "utf8");
      fs.writeFileSync(sourcePaths.configPath, JSON.stringify(sourceConfig, null, 2), "utf8");
      fs.writeFileSync(sourcePaths.secretsKeyFilePath, "source-secret", "utf8");

      delete process.env.PAPERCLIP_CONFIG;
      process.chdir(repoRoot);

      await expect(worktreeReseedCommand({
        fromConfig: sourcePaths.configPath,
        yes: true,
      })).rejects.toThrow("Source instance uses postgres mode but has no connection string");

      const restoredConfig = JSON.parse(fs.readFileSync(currentPaths.configPath, "utf8"));
      const restoredEnv = fs.readFileSync(currentPaths.envPath, "utf8");
      const restoredMarker = fs.readFileSync(path.join(currentPaths.instanceRoot, "marker.txt"), "utf8");

      expect(restoredConfig.server.port).toBe(3114);
      expect(restoredConfig.database.embeddedPostgresPort).toBe(54341);
      expect(restoredEnv).toContain(`PAPERCLIP_INSTANCE_ID=${currentInstanceId}`);
      expect(restoredMarker).toBe("keep me");
    } finally {
      process.chdir(originalCwd);
      if (originalPaperclipConfig === undefined) {
        delete process.env.PAPERCLIP_CONFIG;
      } else {
        process.env.PAPERCLIP_CONFIG = originalPaperclipConfig;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rebinds same-repo workspace paths onto the current worktree root", () => {
    expect(
      rebindWorkspaceCwd({
        sourceRepoRoot: "/Users/example/paperclip",
        targetRepoRoot: "/Users/example/paperclip-pr-432",
        workspaceCwd: "/Users/example/paperclip",
      }),
    ).toBe("/Users/example/paperclip-pr-432");

    expect(
      rebindWorkspaceCwd({
        sourceRepoRoot: "/Users/example/paperclip",
        targetRepoRoot: "/Users/example/paperclip-pr-432",
        workspaceCwd: "/Users/example/paperclip/packages/db",
      }),
    ).toBe("/Users/example/paperclip-pr-432/packages/db");
  });

  it("does not rebind paths outside the source repo root", () => {
    expect(
      rebindWorkspaceCwd({
        sourceRepoRoot: "/Users/example/paperclip",
        targetRepoRoot: "/Users/example/paperclip-pr-432",
        workspaceCwd: "/Users/example/other-project",
      }),
    ).toBeNull();
  });

  it("copies shared git hooks into a linked worktree git dir", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-hooks-"));
    const repoRoot = path.join(tempRoot, "repo");
    const worktreePath = path.join(tempRoot, "repo-feature");

    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot, stdio: "ignore" });
      fs.writeFileSync(path.join(repoRoot, "README.md"), "# temp\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoRoot, stdio: "ignore" });

      const sourceHooksDir = path.join(repoRoot, ".git", "hooks");
      const sourceHookPath = path.join(sourceHooksDir, "pre-commit");
      const sourceTokensPath = path.join(sourceHooksDir, "forbidden-tokens.txt");
      fs.writeFileSync(sourceHookPath, "#!/usr/bin/env bash\nexit 0\n", { encoding: "utf8", mode: 0o755 });
      fs.chmodSync(sourceHookPath, 0o755);
      fs.writeFileSync(sourceTokensPath, "secret-token\n", "utf8");

      execFileSync("git", ["worktree", "add", "--detach", worktreePath], { cwd: repoRoot, stdio: "ignore" });

      const copied = copyGitHooksToWorktreeGitDir(worktreePath);
      const worktreeGitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const resolvedSourceHooksDir = fs.realpathSync(sourceHooksDir);
      const resolvedTargetHooksDir = fs.realpathSync(path.resolve(worktreePath, worktreeGitDir, "hooks"));
      const targetHookPath = path.join(resolvedTargetHooksDir, "pre-commit");
      const targetTokensPath = path.join(resolvedTargetHooksDir, "forbidden-tokens.txt");

      expect(copied).toMatchObject({
        sourceHooksPath: resolvedSourceHooksDir,
        targetHooksPath: resolvedTargetHooksDir,
        copied: true,
      });
      expect(fs.readFileSync(targetHookPath, "utf8")).toBe("#!/usr/bin/env bash\nexit 0\n");
      expect(fs.statSync(targetHookPath).mode & 0o111).not.toBe(0);
      expect(fs.readFileSync(targetTokensPath, "utf8")).toBe("secret-token\n");
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot, stdio: "ignore" });
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("creates and initializes a worktree from the top-level worktree:make command", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-make-"));
    const repoRoot = path.join(tempRoot, "repo");
    const fakeHome = path.join(tempRoot, "home");
    const worktreePath = path.join(fakeHome, "paperclip-make-test");
    const originalCwd = process.cwd();
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(fakeHome, { recursive: true });
      execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot, stdio: "ignore" });
      fs.writeFileSync(path.join(repoRoot, "README.md"), "# temp\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoRoot, stdio: "ignore" });

      process.chdir(repoRoot);

      await worktreeMakeCommand("paperclip-make-test", {
        seed: false,
        home: path.join(tempRoot, ".paperclip-worktrees"),
      });

      expect(fs.existsSync(path.join(worktreePath, ".git"))).toBe(true);
      expect(fs.existsSync(path.join(worktreePath, ".paperclip", "config.json"))).toBe(true);
      expect(fs.existsSync(path.join(worktreePath, ".paperclip", ".env"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      homedirSpy.mockRestore();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("no-ops on the primary checkout unless --branch is provided", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-repair-primary-"));
    const repoRoot = path.join(tempRoot, "repo");
    const originalCwd = process.cwd();

    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot, stdio: "ignore" });
      fs.writeFileSync(path.join(repoRoot, "README.md"), "# temp\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoRoot, stdio: "ignore" });

      process.chdir(repoRoot);
      await worktreeRepairCommand({});

      expect(fs.existsSync(path.join(repoRoot, ".paperclip", "config.json"))).toBe(false);
      expect(fs.existsSync(path.join(repoRoot, ".paperclip", "worktrees"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("repairs the current linked worktree when Paperclip metadata is missing", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-repair-current-"));
    const repoRoot = path.join(tempRoot, "repo");
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", "repair-me");
    const sourceConfigPath = path.join(tempRoot, "source-config.json");
    const worktreeHome = path.join(tempRoot, ".paperclip-worktrees");
    const worktreePaths = resolveWorktreeLocalPaths({
      cwd: worktreePath,
      homeDir: worktreeHome,
      instanceId: sanitizeWorktreeInstanceId(path.basename(worktreePath)),
    });
    const originalCwd = process.cwd();

    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot, stdio: "ignore" });
      fs.writeFileSync(path.join(repoRoot, "README.md"), "# temp\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoRoot, stdio: "ignore" });
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      execFileSync("git", ["worktree", "add", "-b", "repair-me", worktreePath, "HEAD"], {
        cwd: repoRoot,
        stdio: "ignore",
      });

      fs.writeFileSync(sourceConfigPath, JSON.stringify(buildSourceConfig(), null, 2), "utf8");
      fs.mkdirSync(worktreePaths.instanceRoot, { recursive: true });
      fs.writeFileSync(path.join(worktreePaths.instanceRoot, "marker.txt"), "stale", "utf8");

      process.chdir(worktreePath);
      await worktreeRepairCommand({
        fromConfig: sourceConfigPath,
        home: worktreeHome,
        noSeed: true,
      });

      expect(fs.existsSync(path.join(worktreePath, ".paperclip", "config.json"))).toBe(true);
      expect(fs.existsSync(path.join(worktreePath, ".paperclip", ".env"))).toBe(true);
      expect(fs.existsSync(path.join(worktreePaths.instanceRoot, "marker.txt"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("creates and repairs a missing branch worktree when --branch is provided", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-repair-branch-"));
    const repoRoot = path.join(tempRoot, "repo");
    const sourceConfigPath = path.join(tempRoot, "source-config.json");
    const worktreeHome = path.join(tempRoot, ".paperclip-worktrees");
    const originalCwd = process.cwd();
    const expectedWorktreePath = path.join(repoRoot, ".paperclip", "worktrees", "feature-repair-me");

    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot, stdio: "ignore" });
      fs.writeFileSync(path.join(repoRoot, "README.md"), "# temp\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoRoot, stdio: "ignore" });
      fs.writeFileSync(sourceConfigPath, JSON.stringify(buildSourceConfig(), null, 2), "utf8");

      process.chdir(repoRoot);
      await worktreeRepairCommand({
        branch: "feature/repair-me",
        fromConfig: sourceConfigPath,
        home: worktreeHome,
        noSeed: true,
      });

      expect(fs.existsSync(path.join(expectedWorktreePath, ".git"))).toBe(true);
      expect(fs.existsSync(path.join(expectedWorktreePath, ".paperclip", "config.json"))).toBe(true);
      expect(fs.existsSync(path.join(expectedWorktreePath, ".paperclip", ".env"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 20_000);
});

describeEmbeddedPostgres("pauseSeededScheduledRoutines", () => {
  it("pauses only routines with enabled schedule triggers", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worktree-routines-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const activeScheduledRoutineId = randomUUID();
    const activeApiRoutineId = randomUUID();
    const pausedScheduledRoutineId = randomUUID();
    const archivedScheduledRoutineId = randomUUID();
    const disabledScheduleRoutineId = randomUUID();

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Coder",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Project",
        status: "in_progress",
      });
      await db.insert(routines).values([
        {
          id: activeScheduledRoutineId,
          companyId,
          projectId,
          assigneeAgentId: agentId,
          title: "Active scheduled",
          status: "active",
        },
        {
          id: activeApiRoutineId,
          companyId,
          projectId,
          assigneeAgentId: agentId,
          title: "Active API",
          status: "active",
        },
        {
          id: pausedScheduledRoutineId,
          companyId,
          projectId,
          assigneeAgentId: agentId,
          title: "Paused scheduled",
          status: "paused",
        },
        {
          id: archivedScheduledRoutineId,
          companyId,
          projectId,
          assigneeAgentId: agentId,
          title: "Archived scheduled",
          status: "archived",
        },
        {
          id: disabledScheduleRoutineId,
          companyId,
          projectId,
          assigneeAgentId: agentId,
          title: "Disabled schedule",
          status: "active",
        },
      ]);
      await db.insert(routineTriggers).values([
        {
          companyId,
          routineId: activeScheduledRoutineId,
          kind: "schedule",
          enabled: true,
          cronExpression: "0 9 * * *",
          timezone: "UTC",
        },
        {
          companyId,
          routineId: activeApiRoutineId,
          kind: "api",
          enabled: true,
        },
        {
          companyId,
          routineId: pausedScheduledRoutineId,
          kind: "schedule",
          enabled: true,
          cronExpression: "0 10 * * *",
          timezone: "UTC",
        },
        {
          companyId,
          routineId: archivedScheduledRoutineId,
          kind: "schedule",
          enabled: true,
          cronExpression: "0 11 * * *",
          timezone: "UTC",
        },
        {
          companyId,
          routineId: disabledScheduleRoutineId,
          kind: "schedule",
          enabled: false,
          cronExpression: "0 12 * * *",
          timezone: "UTC",
        },
      ]);

      const pausedCount = await pauseSeededScheduledRoutines(tempDb.connectionString);
      expect(pausedCount).toBe(1);

      const rows = await db.select({ id: routines.id, status: routines.status }).from(routines);
      const statusById = new Map(rows.map((row) => [row.id, row.status]));
      expect(statusById.get(activeScheduledRoutineId)).toBe("paused");
      expect(statusById.get(activeApiRoutineId)).toBe("active");
      expect(statusById.get(pausedScheduledRoutineId)).toBe("paused");
      expect(statusById.get(archivedScheduledRoutineId)).toBe("archived");
      expect(statusById.get(disabledScheduleRoutineId)).toBe("active");
    } finally {
      await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
      await tempDb.cleanup();
    }
  }, 20_000);
});
