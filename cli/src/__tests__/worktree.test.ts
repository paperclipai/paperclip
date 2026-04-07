import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyGitHooksToWorktreeGitDir,
  copySeededSecretsKey,
  readSourceAttachmentBody,
  rebindWorkspaceCwd,
  resolveSourceConfigPath,
  resolveGitWorktreeAddArgs,
  resolveWorktreeMakeTargetPath,
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

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

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

  it("rewrites loopback auth URLs to the new port only", () => {
    expect(rewriteLocalUrlPort("http://127.0.0.1:3100", 3110)).toBe("http://127.0.0.1:3110/");
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

  it("requires an explicit source for worktree reseed", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-worktree-reseed-source-"));
    const repoRoot = path.join(tempRoot, "repo");
    const originalCwd = process.cwd();
    const originalPaperclipConfig = process.env.PAPERCLIP_CONFIG;

    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      delete process.env.PAPERCLIP_CONFIG;
      process.chdir(repoRoot);

      await expect(worktreeReseedCommand({ seed: false, yes: true })).rejects.toThrow(
        "Reseed requires an explicit source.",
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

  it("reseed preserves the current worktree ports, instance id, and branding", async () => {
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

    try {
      fs.mkdirSync(path.dirname(currentPaths.configPath), { recursive: true });
      fs.mkdirSync(path.dirname(sourcePaths.configPath), { recursive: true });
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(sourceRoot, { recursive: true });

      const currentConfig = buildWorktreeConfig({
        sourceConfig: buildSourceConfig(),
        paths: currentPaths,
        serverPort: 3114,
        databasePort: 54341,
      });
      const sourceConfig = buildWorktreeConfig({
        sourceConfig: buildSourceConfig(),
        paths: sourcePaths,
        serverPort: 3200,
        databasePort: 54400,
      });
      fs.writeFileSync(currentPaths.configPath, JSON.stringify(currentConfig, null, 2), "utf8");
      fs.writeFileSync(sourcePaths.configPath, JSON.stringify(sourceConfig, null, 2), "utf8");
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

      await worktreeReseedCommand({
        fromConfig: sourcePaths.configPath,
        seed: false,
        yes: true,
      });

      const rewrittenConfig = JSON.parse(fs.readFileSync(currentPaths.configPath, "utf8"));
      const rewrittenEnv = fs.readFileSync(currentPaths.envPath, "utf8");

      expect(rewrittenConfig.server.port).toBe(3114);
      expect(rewrittenConfig.database.embeddedPostgresPort).toBe(54341);
      expect(rewrittenConfig.database.embeddedPostgresDataDir).toBe(currentPaths.embeddedPostgresDataDir);
      expect(rewrittenEnv).toContain(`PAPERCLIP_INSTANCE_ID=${currentInstanceId}`);
      expect(rewrittenEnv).toContain("PAPERCLIP_WORKTREE_NAME=existing-name");
      expect(rewrittenEnv).toContain("PAPERCLIP_WORKTREE_COLOR=\"#112233\"");
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
  });

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
});
