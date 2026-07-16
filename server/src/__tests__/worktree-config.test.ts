import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRuntimePortSelectionToConfig,
  maybePersistWorktreeRuntimePorts,
  maybeRepairLegacyWorktreeConfigAndEnvFiles,
} from "../worktree-config.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

// The ambient shell can carry real PAPERCLIP_* settings (agent shells export
// PAPERCLIP_CONFIG pointing at the live default instance). Repair helpers
// resolve paths from these, so a test that forgets to override one would
// otherwise rewrite the machine's real config/env files.
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete process.env[key];
    }
  }
  process.env.PAPERCLIP_INSTANCE_ID = "default";
});

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

function buildLegacyConfig(sharedRoot: string, publicBaseUrl = "http://127.0.0.1:3100") {
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
      publicBaseUrl,
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

function buildIsolatedConfig(instanceRoot: string, serverPort: number, databasePort: number) {
  const config = buildLegacyConfig(instanceRoot, `http://127.0.0.1:${serverPort}`);
  return {
    ...config,
    database: {
      ...config.database,
      embeddedPostgresPort: databasePort,
    },
    server: {
      ...config.server,
      port: serverPort,
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
    delete process.env.PORT;
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
    expect(process.env.PORT).toBe("3101");
    expect(process.env.PAPERCLIP_INSTANCE_ID).toBe("pap-884-ai-commits-component");
  });

  it("preserves an externally supplied PORT while repairing worktree config", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-repair-external-port-"));
    const worktreeRoot = path.join(tempRoot, "PAP-10341-runtime-managed-port");
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
        "PAPERCLIP_WORKTREE_NAME=PAP-10341-runtime-managed-port",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-10341-runtime-managed-port";
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    process.env.PORT = "32987";
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(result.repairedConfig).toBe(true);
    expect(repairedConfig.server.port).toBe(3101);
    expect(process.env.PORT).toBe("32987");
    expect(process.env.PAPERCLIP_HOME).toBe(isolatedHome);
  });

  it("never rewrites a main-instance env when ambient worktree flags leak into the process", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-leak-"));
    const homeDir = path.join(tempRoot, ".paperclip");
    const instanceRoot = path.join(homeDir, "instances", "default");
    const configPath = path.join(instanceRoot, "config.json");
    const envPath = path.join(instanceRoot, ".env");

    await fs.mkdir(instanceRoot, { recursive: true });
    const originalConfig = JSON.stringify(buildLegacyConfig(instanceRoot), null, 2) + "\n";
    await fs.writeFile(configPath, originalConfig, "utf8");
    const cleanEnv = [
      "# Paperclip environment variables",
      "# Generated by `paperclip onboard`",
      `PAPERCLIP_HOME=${JSON.stringify(homeDir)}`,
      'PAPERCLIP_INSTANCE_ID="default"',
      `PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`,
      "",
    ].join("\n");
    await fs.writeFile(envPath, cleanEnv, "utf8");

    process.chdir(tempRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(result).toEqual({ repairedConfig: false, repairedEnv: false });
    expect(await fs.readFile(envPath, "utf8")).toBe(cleanEnv);
    expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
    expect(process.env.PAPERCLIP_HOME).toBe(homeDir);
    expect(process.env.PAPERCLIP_INSTANCE_ID).toBe("default");
  });

  it("does not persist runtime ports into a main-instance config when ambient worktree flags leak in", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-leak-ports-"));
    const homeDir = path.join(tempRoot, ".paperclip");
    const instanceRoot = path.join(homeDir, "instances", "default");
    const configPath = path.join(instanceRoot, "config.json");

    await fs.mkdir(instanceRoot, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(instanceRoot), null, 2) + "\n", "utf8");

    process.chdir(tempRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PORT;
    delete process.env.DATABASE_URL;

    maybePersistWorktreeRuntimePorts({ serverPort: 3999, databasePort: 54399 });

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(writtenConfig.server.port).toBe(3100);
    expect(writtenConfig.database.embeddedPostgresPort).toBe(54329);
  });

  it("does not adopt a .paperclip config whose own env does not declare a worktree", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-unattested-"));
    const repoRoot = path.join(tempRoot, "repo");
    const paperclipDir = path.join(repoRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");

    await fs.mkdir(paperclipDir, { recursive: true });
    const originalConfig =
      JSON.stringify(buildLegacyConfig(path.join(tempRoot, "shared")), null, 2) + "\n";
    await fs.writeFile(configPath, originalConfig, "utf8");
    const nonWorktreeEnv = [
      "# Paperclip environment variables",
      `PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`,
      "",
    ].join("\n");
    await fs.writeFile(envPath, nonWorktreeEnv, "utf8");

    process.chdir(repoRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-884-ai-commits-component";
    process.env.PAPERCLIP_WORKTREES_DIR = path.join(tempRoot, ".paperclip-worktrees");
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(result).toEqual({ repairedConfig: false, repairedEnv: false });
    expect(await fs.readFile(envPath, "utf8")).toBe(nonWorktreeEnv);
    expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
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
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(result.repairedConfig).toBe(true);
    expect(repairedConfig.server.port).toBe(3102);
    expect(repairedConfig.database.embeddedPostgresPort).toBe(54331);
  });

  it("serializes and persists cross-repo worktree port reservations", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-port-registry-"));
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const firstWorktreeRoot = path.join(tempRoot, "repo-one", "PAP-14013-import-bulk-skills");
    const secondWorktreeRoot = path.join(tempRoot, "repo-two", "PAP-14069-port-conflicts");
    const firstConfigPath = path.join(firstWorktreeRoot, ".paperclip", "config.json");
    const secondConfigPath = path.join(secondWorktreeRoot, ".paperclip", "config.json");

    const writeWorktree = async (worktreeRoot: string, name: string) => {
      const paperclipDir = path.join(worktreeRoot, ".paperclip");
      const instanceRoot = path.join(isolatedHome, "instances", name.toLowerCase());
      await fs.mkdir(paperclipDir, { recursive: true });
      await fs.writeFile(
        path.join(paperclipDir, "config.json"),
        `${JSON.stringify(buildIsolatedConfig(instanceRoot, 45439, 55439), null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(paperclipDir, ".env"),
        [
          "# Paperclip environment variables",
          "PAPERCLIP_IN_WORKTREE=true",
          `PAPERCLIP_WORKTREE_NAME=${name}`,
          `PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`,
          `PAPERCLIP_INSTANCE_ID=${name.toLowerCase()}`,
          `PAPERCLIP_CONFIG=${JSON.stringify(path.join(paperclipDir, "config.json"))}`,
          "",
        ].join("\n"),
        "utf8",
      );
    };

    const activateWorktree = (worktreeRoot: string, name: string) => {
      process.chdir(worktreeRoot);
      process.env.PAPERCLIP_IN_WORKTREE = "true";
      process.env.PAPERCLIP_WORKTREE_NAME = name;
      process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
      process.env.PAPERCLIP_HOME = isolatedHome;
      process.env.PAPERCLIP_INSTANCE_ID = name.toLowerCase();
      process.env.PAPERCLIP_CONFIG = path.join(worktreeRoot, ".paperclip", "config.json");
      delete process.env.PORT;
      delete process.env.DATABASE_URL;
    };

    await writeWorktree(firstWorktreeRoot, "PAP-14013-import-bulk-skills");
    await writeWorktree(secondWorktreeRoot, "PAP-14069-port-conflicts");
    const staleLockPath = path.join(isolatedHome, ".worktree-port-reservations.lock");
    await fs.mkdir(staleLockPath, { recursive: true });
    const staleLockTime = new Date(Date.now() - 6_000);
    await fs.utimes(staleLockPath, staleLockTime, staleLockTime);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    activateWorktree(firstWorktreeRoot, "PAP-14013-import-bulk-skills");
    expect(maybeRepairLegacyWorktreeConfigAndEnvFiles().repairedConfig).toBe(false);
    await expect(fs.stat(staleLockPath)).rejects.toMatchObject({ code: "ENOENT" });

    activateWorktree(secondWorktreeRoot, "PAP-14069-port-conflicts");
    expect(maybeRepairLegacyWorktreeConfigAndEnvFiles().repairedConfig).toBe(true);

    const firstConfig = JSON.parse(await fs.readFile(firstConfigPath, "utf8"));
    const secondConfig = JSON.parse(await fs.readFile(secondConfigPath, "utf8"));
    const registry = JSON.parse(
      await fs.readFile(path.join(isolatedHome, "worktree-port-reservations.json"), "utf8"),
    );

    expect(firstConfig.server.port).toBe(45439);
    expect(firstConfig.database.embeddedPostgresPort).toBe(55439);
    expect(secondConfig.server.port).toBe(45440);
    expect(secondConfig.database.embeddedPostgresPort).toBe(55440);
    expect(secondConfig.auth.publicBaseUrl).toBe("http://127.0.0.1:45440/");
    expect(registry.configPaths).toEqual([firstConfigPath, secondConfigPath].sort());
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Worktree port conflict detected"));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("server: 45439 -> 45440"));

    warning.mockClear();
    expect(maybeRepairLegacyWorktreeConfigAndEnvFiles().repairedConfig).toBe(false);
    const persistedConfig = JSON.parse(await fs.readFile(secondConfigPath, "utf8"));
    expect(persistedConfig.server.port).toBe(45440);
    expect(persistedConfig.database.embeddedPostgresPort).toBe(55440);
    expect(warning).not.toHaveBeenCalled();
  });

  it("ignores stale migrated env paths when the dev runner resolved the local config", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-migrated-env-"));
    const worktreeRoot = path.join(tempRoot, "PAP-9940-what-can-we-learn");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const envPath = path.join(paperclipDir, ".env");
    const oldHome = "/old/home/.paperclip-worktrees";
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(buildLegacyConfig(oldHome), null, 2) + "\n", "utf8");
    await fs.writeFile(
      envPath,
      [
        "# Paperclip environment variables",
        "PAPERCLIP_HOME=/old/home/.paperclip-worktrees",
        "PAPERCLIP_INSTANCE_ID=pap-9940-what-can-we-learn",
        "PAPERCLIP_CONFIG=/old/home/paperclip/.paperclip/worktrees/PAP-9940-what-can-we-learn/.paperclip/config.json",
        "PAPERCLIP_CONTEXT=/old/home/.paperclip-worktrees/context.json",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=PAP-9940-what-can-we-learn",
        "",
      ].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_CONFIG = configPath;
    process.env.PAPERCLIP_WORKTREES_DIR = isolatedHome;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const repairedEnv = await fs.readFile(envPath, "utf8");
    const instanceRoot = path.join(isolatedHome, "instances", "pap-9940-what-can-we-learn");

    expect(result).toEqual({
      repairedConfig: true,
      repairedEnv: true,
    });
    expect(repairedConfig.database.embeddedPostgresDataDir).toBe(path.join(instanceRoot, "db"));
    expect(repairedConfig.secrets.localEncrypted.keyFilePath).toBe(path.join(instanceRoot, "secrets", "master.key"));
    expect(repairedEnv).toContain(`PAPERCLIP_HOME=${JSON.stringify(isolatedHome)}`);
    expect(repairedEnv).toContain(`PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`);
    expect(repairedEnv).not.toContain("/old/home");
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
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_CONFIG;
    delete process.env.PAPERCLIP_CONTEXT;

    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();
    const repairedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(result.repairedConfig).toBe(true);
    expect(repairedConfig.server.port).toBe(3102);
    expect(repairedConfig.database.embeddedPostgresPort).toBe(54331);
  });

  it("persists runtime-selected worktree ports back into explicit-port auth URLs", async () => {
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
          ...buildLegacyConfig(instanceRoot, "http://my-host.ts.net:3100"),
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

    await fs.writeFile(
      path.join(paperclipDir, ".env"),
      ["# Paperclip environment variables", "PAPERCLIP_IN_WORKTREE=true", ""].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-878-create-a-mine-tab-in-inbox";
    process.env.PAPERCLIP_HOME = isolatedHome;
    process.env.PAPERCLIP_INSTANCE_ID = "pap-878-create-a-mine-tab-in-inbox";
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PORT;
    delete process.env.DATABASE_URL;

    maybePersistWorktreeRuntimePorts({
      serverPort: 3103,
      databasePort: 54335,
    });

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(writtenConfig.server.port).toBe(3103);
    expect(writtenConfig.database.embeddedPostgresPort).toBe(54335);
    expect(writtenConfig.auth.publicBaseUrl).toBe("http://my-host.ts.net:3103/");
  });

  it("does not rewrite no-port public auth URLs when persisting runtime-selected ports", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-public-ports-"));
    const worktreeRoot = path.join(tempRoot, "PAP-125-public-base-url");
    const paperclipDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(paperclipDir, "config.json");
    const isolatedHome = path.join(tempRoot, ".paperclip-worktrees");
    const instanceRoot = path.join(isolatedHome, "instances", "pap-125-public-base-url");

    await fs.mkdir(paperclipDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          ...buildLegacyConfig(instanceRoot, "https://paperclip.example"),
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

    await fs.writeFile(
      path.join(paperclipDir, ".env"),
      ["# Paperclip environment variables", "PAPERCLIP_IN_WORKTREE=true", ""].join("\n"),
      "utf8",
    );

    process.chdir(worktreeRoot);
    process.env.PAPERCLIP_IN_WORKTREE = "true";
    process.env.PAPERCLIP_WORKTREE_NAME = "PAP-125-public-base-url";
    process.env.PAPERCLIP_HOME = isolatedHome;
    process.env.PAPERCLIP_INSTANCE_ID = "pap-125-public-base-url";
    process.env.PAPERCLIP_CONFIG = configPath;
    delete process.env.PORT;
    delete process.env.DATABASE_URL;

    maybePersistWorktreeRuntimePorts({
      serverPort: 3103,
      databasePort: 54335,
    });

    const writtenConfig = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(writtenConfig.server.port).toBe(3103);
    expect(writtenConfig.database.embeddedPostgresPort).toBe(54335);
    expect(writtenConfig.auth.publicBaseUrl).toBe("https://paperclip.example");
  });

  it("can update the in-memory config when auth URL already includes a port", () => {
    const { config, changed } = applyRuntimePortSelectionToConfig(
      buildLegacyConfig("/tmp/shared", "http://my-host.ts.net:3100"),
      {
        serverPort: 3104,
        databasePort: 54340,
        allowServerPortWrite: false,
        allowDatabasePortWrite: true,
      },
    );

    expect(changed).toBe(true);
    expect(config.server.port).toBe(3100);
    expect(config.database.embeddedPostgresPort).toBe(54340);
    expect(config.auth.publicBaseUrl).toBe("http://my-host.ts.net:3104/");
  });

  it("does not rewrite the in-memory config when auth URL has no explicit port", () => {
    const { config, changed } = applyRuntimePortSelectionToConfig(
      buildLegacyConfig("/tmp/shared", "https://paperclip.example"),
      {
        serverPort: 3104,
        databasePort: 54340,
        allowServerPortWrite: false,
        allowDatabasePortWrite: true,
      },
    );

    expect(changed).toBe(true);
    expect(config.server.port).toBe(3100);
    expect(config.database.embeddedPostgresPort).toBe(54340);
    expect(config.auth.publicBaseUrl).toBe("https://paperclip.example");
  });
});
