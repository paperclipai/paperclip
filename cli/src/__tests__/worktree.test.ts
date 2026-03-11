import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  copyGitHooksToWorktreeGitDir,
  copySeededSecretsKey,
  rebindWorkspaceCwd,
  resolveGitWorktreeAddArgs,
  resolveWorktreeMakeTargetPath,
  worktreeMakeCommand,
} from "../commands/worktree.js";
import {
  buildWorktreeConfig,
  buildWorktreeEnvEntries,
  formatShellExports,
  resolveWorktreeSeedPlan,
  resolveWorktreeLocalPaths,
  rewriteLocalUrlPort,
  sanitizeWorktreeInstanceId,
} from "../commands/worktree-lib.js";
import type { PaperclipConfig } from "../config/schema.js";

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

    const env = buildWorktreeEnvEntries(paths);
    expect(env.PAPERCLIP_HOME).toBe(path.resolve("/tmp/paperclip-worktrees"));
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("feature-worktree-support");
    expect(env.PAPERCLIP_IN_WORKTREE).toBe("true");
    expect(formatShellExports(env)).toContain("export PAPERCLIP_INSTANCE_ID='feature-worktree-support'");
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
    try {
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
    const originalHome = process.env.HOME;

    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(fakeHome, { recursive: true });
      execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoRoot, stdio: "ignore" });
      fs.writeFileSync(path.join(repoRoot, "README.md"), "# temp\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoRoot, stdio: "ignore" });

      process.env.HOME = fakeHome;
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
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
