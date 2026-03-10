import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copySeededSecretsKey, rebindWorkspaceCwd } from "../commands/worktree.js";
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
});
