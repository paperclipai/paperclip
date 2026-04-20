import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRuntimePortSelectionToConfig,
  maybePersistWorktreeRuntimePorts,
  maybeRepairLegacyWorktreeConfigAndEnvFiles,
} from "../worktree-config.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);

  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

function buildLegacyConfig(sharedRoot: string) {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-03-26T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres" as const,
      embeddedPostgresDataDir: path.join(sharedRoot, "db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(sharedRoot, "data", "backups"),
      },
    },
    logging: {
      mode: "file" as const,
      logDir: path.join(sharedRoot, "logs"),
    },
    server: {
      deploymentMode: "local_trusted" as const,
      exposure: "private" as const,
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "explicit" as const,
      publicBaseUrl: "http://127.0.0.1:3100",
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk" as const,
      localDisk: {
        baseDir: path.join(sharedRoot, "data", "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted" as const,
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(sharedRoot, "secrets", "master.key"),
      },
    },
  };
}

describe("worktree config repair", () => {
  it("repairs legacy repo-local worktree config and env files into an isolated instance", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-repair-"));
    const worktreeRoot = path.join(tempRoot, "PAP-884-ai-commits-component");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const sharedRoot = path.join(tempRoot, ".paperclip", "instances", "default");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(sharedRoot), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=PAP-884-ai-commits-component",
        "PAPERCLIP_AGENT_JWT_SECRET=shared-secret",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(result).toEqual({
      repairedConfig: true,
      repairedEnv: true,
    });

    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const repairedEnv = await fs.readFile(envPath, "utf8");
    const instanceRoot = path.join(isolatedHome, "instances", "pap-884-ai-commits-component");

    expect(repairedConfig.database.embeddedPostgresDataDir).toBe(path.join(instanceRoot, "db"));
    expect(repairedConfig.database.backup.dir).toBe(path.join(instanceRoot, "data", "backups"));
    expect(repairedConfig.logging.logDir).toBe(path.join(instanceRoot, "logs"));
    expect(repairedConfig.storage.localDisk.baseDir).toBe(path.join(instanceRoot, "data", "storage"));
    expect(repairedConfig.secrets.localEncrypted.keyFilePath).toBe(path.join(instanceRoot, "secrets", "master.key"));
    expect(repairedEnv).toContain(`PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`);
    expect(repairedEnv).toContain('PAPERCLIP_INSTANCE_ID="pap-884-ai-commits-component"');
    expect(repairedEnv).toContain(`PAPERCLIP_CONFIG=${JSON.stringify(await fs.realpath(configPath))}`);
    expect(repairedEnv).toContain(`PAPERCLIP_CONTEXT=${JSON.stringify(path.join(isolatedHome, "context.json"))}`);
    expect(repairedEnv).toContain('PAPERCLIP_AGENT_JWT_SECRET="shared-secret"');
    expect(process.env.PAPERCLIP_HOME).toBe(isolatedHome);
    expect(process.env.PAPERCLIP_INSTANCE_ID).toBe("pap-884-ai-commits-component");
  });

  it("avoids sibling worktree ports when repairing legacy configs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-repair-ports-"));
    const worktreeRoot = path.join(tempRoot, "PAP-880-thumbs-capture-for-evals-feature");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const sharedRoot = path.join(tempRoot, ".paperclip", "instances", "default");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const siblingInstanceRoot = path.join(isolatedHome, "instances", "pap-878-create-a-mine-tab-in-inbox");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.mkdir(siblingInstanceRoot, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(sharedRoot), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=PAP-880-thumbs-capture-for-evals-feature",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(siblingInstanceRoot, "config.json"),
      JSON.stringify(
        {
          ...buildLegacyConfig(siblingInstanceRoot),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(siblingInstanceRoot, "db"),
            embeddedPostgresPort: 54330,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(siblingInstanceRoot, "data", "backups"),
            },
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-880-thumbs-capture-for-evals-feature";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(result.repairedConfig).toBe(true);
    expect(repairedConfig.server.port).toBe(3102);
    expect(repairedConfig.database.embeddedPostgresPort).toBe(54331);
  });

  it("does not persist transient runtime home overrides over repo-local worktree env", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-runtime-override-"));
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const transientHome = path.join(tempRoot, "tests", "e2e", ".tmp", "multiuser-authenticated");
    const worktreeRoot = path.join(tempRoot, "PAP-989-multi-user-implementation-using-plan-from-pap-958");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const instanceId = "pap-989-multi-user-implementation-using-plan-from-pap-958";
    const stableInstanceRoot = path.join(isolatedHome, "instances", instanceId);

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(transientHome),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(transientHome, "instances", instanceId, "db"),
            embeddedPostgresPort: 54334,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(transientHome, "instances", instanceId, "data", "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(transientHome, "instances", instanceId, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3104,
            allowedHostnames: [],
            serveUi: true,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(transientHome, "instances", instanceId, "data", "storage"),
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
              keyFilePath: path.join(transientHome, "instances", instanceId, "secrets", "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        `PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`,
        `PAPERCLIP_INSTANCE_ID=${JSON.stringify(instanceId)}`,
        `PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`,
        `PAPERCLIP_CONTEXT=${JSON.stringify(path.join(isolatedHome, "context.json"))}`,
        'PAPERCLIP_IN_WORKTREE="true"',
        'PAPERCLIP_WORKTREE_NAME="PAP-989-multi-user-implementation-using-plan-from-pap-958"',
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-989-multi-user-implementation-using-plan-from-pap-958";
    process.env.PAPERCLIP_HOME = transientHome;
    process.env.PAPERCLIP_INSTANCE_ID = instanceId;
    process.env.PAPERCLIP_CONFIG = configPath;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const repairedEnv = await fs.readFile(envPath, "utf8");

    expect(result).toEqual({
      repairedConfig: true,
      repairedEnv: false,
    });
    expect(repairedConfig.database.embeddedPostgresDataDir).toBe(path.join(stableInstanceRoot, "db"));
    expect(repairedConfig.database.backup.dir).toBe(path.join(stableInstanceRoot, "data", "backups"));
    expect(repairedConfig.logging.logDir).toBe(path.join(stableInstanceRoot, "logs"));
    expect(repairedConfig.storage.localDisk.baseDir).toBe(path.join(stableInstanceRoot, "data", "storage"));
    expect(repairedConfig.secrets.localEncrypted.keyFilePath).toBe(
      path.join(stableInstanceRoot, "secrets", "master.key"),
    );
    expect(repairedEnv).toContain(`PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`);
    expect(repairedEnv).not.toContain(`PAPERCLIP_HOME=${JSON.stringify(transientHome)}`);
    expect(process.env.PAPERCLIP_HOME).toBe(isolatedHome);
  });

  it("rebalances duplicate ports for already isolated worktree configs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-rebalance-"));
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const repoWorktreesRoot = path.join(tempRoot, "repo", ".paperclip", "worktrees");
    const siblingWorktreeRoot = path.join(repoWorktreesRoot, "PAP-878-create-a-mine-tab-in-inbox");
    const siblingInstanceRoot = path.join(isolatedHome, "instances", "pap-878-create-a-mine-tab-in-inbox");
    const currentWorktreeRoot = path.join(repoWorktreesRoot, "PAP-884-ai-commits-component");
    const paperclipDir = path.join(currentWorktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const currentInstanceRoot = path.join(isolatedHome, "instances", "pap-884-ai-commits-component");
    const siblingConfigPath = path.join(siblingWorktreeRoot, ".paperclip", "config.json");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.mkdir(path.dirname(siblingConfigPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(currentInstanceRoot),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(currentInstanceRoot, "db"),
            embeddedPostgresPort: 54330,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(currentInstanceRoot, "data", "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(currentInstanceRoot, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(currentInstanceRoot, "data", "storage"),
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
              keyFilePath: path.join(currentInstanceRoot, "secrets", "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=PAP-884-ai-commits-component",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      siblingConfigPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(siblingInstanceRoot),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(siblingInstanceRoot, "db"),
            embeddedPostgresPort: 54330,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(siblingInstanceRoot, "data", "backups"),
            },
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.chdir(currentWorktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(result.repairedConfig).toBe(true);
    expect(repairedConfig.server.port).toBe(3102);
    expect(repairedConfig.database.embeddedPostgresPort).toBe(54331);
  });

  it("persists runtime-selected worktree ports back into config", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-ports-"));
    const worktreeRoot = path.join(tempRoot, "PAP-878-create-a-mine-tab-in-inbox");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const instanceRoot = path.join(isolatedHome, "instances", "pap-878-create-a-mine-tab-in-inbox");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(instanceRoot),
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(instanceRoot, "db"),
            embeddedPostgresPort: 54331,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(instanceRoot, "data", "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(instanceRoot, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3101,
            allowedHostnames: [],
            serveUi: true,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(instanceRoot, "data", "storage"),
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
              keyFilePath: path.join(instanceRoot, "secrets", "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-878-create-a-mine-tab-in-inbox";
    process.env.PAPERCLIP_HOME = isolatedHome;
    process.env.PAPERCLIP_INSTANCE_ID = "pap-878-create-a-mine-tab-in-inbox";
    process.env.PAPERCLIP_CONFIG = configPath;

    maybePersistWorktreeRuntimePorts({
      serverPort: 3103,
      databasePort: 54335,
    });

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(writtenConfig.server.port).toBe(3103);
    expect(writtenConfig.database.embeddedPostgresPort).toBe(54335);
    expect(writtenConfig.auth.publicBaseUrl).toBe("http://127.0.0.1:3103/");
  });

  it("can update the in-memory config without rewriting env-driven ports", () => {
    const { config, changed } = applyRuntimePortSelectionToConfig(buildLegacyConfig("/tmp/shared"), {
      serverPort: 3104,
      databasePort: 54340,
      allowServerPortWrite: false,
      allowDatabasePortWrite: true,
    });

    expect(changed).toBe(true);
    expect(config.server.port).toBe(3100);
    expect(config.database.embeddedPostgresPort).toBe(54340);
    expect(config.auth.publicBaseUrl).toBe("http://127.0.0.1:3104/");
  });
});
