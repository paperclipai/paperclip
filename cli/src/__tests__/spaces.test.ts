import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultServerRunningCheck, migrateDefaultSpaceInstall } from "../commands/spaces.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function createLegacyInstallFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-space-migrate-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-space-migrate-cwd-"));
  process.chdir(cwd);
  process.env.PAPERCLIP_HOME = home;
  delete process.env.PAPERCLIP_CONFIG;
  delete process.env.PAPERCLIP_INSTANCE_ID;
  delete process.env.PAPERCLIP_SPACE_ID;

  const instanceRoot = path.join(home, "instances", "default");
  const spaceRoot = path.join(instanceRoot, "spaces", "default");
  const config: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: "2026-05-09T00:00:00.000Z",
      source: "onboard",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(instanceRoot, "db"),
      embeddedPostgresPort: 54329,
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
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
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
  };

  writeJson(path.join(instanceRoot, "config.json"), config);
  writeText(path.join(instanceRoot, ".env"), "PAPERCLIP_AGENT_JWT_SECRET=test-secret\n");
  writeText(path.join(instanceRoot, "db", "PG_VERSION"), "17\n");
  writeText(path.join(instanceRoot, "data", "storage", "hello.txt"), "hello\n");
  writeText(path.join(instanceRoot, "logs", "server.log"), "log\n");
  writeText(path.join(instanceRoot, "secrets", "master.key"), "01234567890123456789012345678901");
  writeText(path.join(instanceRoot, "workspaces", "agent-1", "README.md"), "workspace\n");
  writeText(path.join(instanceRoot, "projects", "company", "project", "repo", "README.md"), "project\n");
  writeText(path.join(instanceRoot, "companies", "company-1", "codex-home", "config.toml"), "model=\"x\"\n");
  writeText(path.join(instanceRoot, "codex-home", "config.toml"), "model=\"shared\"\n");

  return { instanceRoot, spaceRoot };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.chdir(ORIGINAL_CWD);
  vi.unstubAllGlobals();
});

describe("spaces migrate-default", () => {
  it("moves a legacy root-shaped install into spaces/default and rewrites config paths", async () => {
    const fixture = createLegacyInstallFixture();

    const result = await migrateDefaultSpaceInstall({
      serverRunningCheck: async () => false,
    });

    expect(result.status).toBe("migrated");
    expect(result.movedPaths).toEqual([
      "config.json",
      ".env",
      "db",
      "data",
      "logs",
      "secrets",
      "workspaces",
      "projects",
      "companies",
      "codex-home",
    ]);

    expect(fs.existsSync(path.join(fixture.instanceRoot, "db"))).toBe(false);
    expect(fs.readFileSync(path.join(fixture.spaceRoot, ".env"), "utf8")).toContain("PAPERCLIP_AGENT_JWT_SECRET");
    expect(fs.readFileSync(path.join(fixture.spaceRoot, "db", "PG_VERSION"), "utf8")).toBe("17\n");
    expect(fs.readFileSync(path.join(fixture.spaceRoot, "data", "storage", "hello.txt"), "utf8")).toBe("hello\n");
    expect(fs.readFileSync(path.join(fixture.spaceRoot, "companies", "company-1", "codex-home", "config.toml"), "utf8")).toContain("model");
    expect(fs.readFileSync(path.join(fixture.spaceRoot, "codex-home", "config.toml"), "utf8")).toContain("shared");

    const migratedConfig = JSON.parse(fs.readFileSync(path.join(fixture.spaceRoot, "config.json"), "utf8")) as PaperclipConfig;
    expect(migratedConfig.database.embeddedPostgresDataDir).toBe(path.join(fixture.spaceRoot, "db"));
    expect(migratedConfig.database.backup.dir).toBe(path.join(fixture.spaceRoot, "data", "backups"));
    expect(migratedConfig.logging.logDir).toBe(path.join(fixture.spaceRoot, "logs"));
    expect(migratedConfig.storage.localDisk.baseDir).toBe(path.join(fixture.spaceRoot, "data", "storage"));
    expect(migratedConfig.secrets.localEncrypted.keyFilePath).toBe(path.join(fixture.spaceRoot, "secrets", "master.key"));

    const marker = JSON.parse(fs.readFileSync(path.join(fixture.instanceRoot, "config.json"), "utf8")) as {
      activeSpaceId?: string;
      defaultSpaceMigration?: { sourceRoot?: string; destinationRoot?: string; movedPaths?: string[] };
    };
    expect(marker.activeSpaceId).toBe("default");
    expect(marker.defaultSpaceMigration).toMatchObject({
      sourceRoot: fixture.instanceRoot,
      destinationRoot: fixture.spaceRoot,
      movedPaths: result.movedPaths,
    });

    expect(resolveConfigPath()).toBe(path.join(fixture.spaceRoot, "config.json"));
    expect(readConfig()?.database.embeddedPostgresDataDir).toBe(path.join(fixture.spaceRoot, "db"));
  });

  it("refuses to merge when destination data already exists", async () => {
    const fixture = createLegacyInstallFixture();
    writeText(path.join(fixture.spaceRoot, "db", "PG_VERSION"), "existing\n");

    await expect(migrateDefaultSpaceInstall({
      serverRunningCheck: async () => false,
    })).rejects.toThrow(/destination paths already exist:[\s\S]*db/);

    expect(fs.readFileSync(path.join(fixture.instanceRoot, "db", "PG_VERSION"), "utf8")).toBe("17\n");
    expect(fs.readFileSync(path.join(fixture.spaceRoot, "db", "PG_VERSION"), "utf8")).toBe("existing\n");
  });

  it("refuses to migrate when the server appears to be running", async () => {
    const fixture = createLegacyInstallFixture();

    await expect(migrateDefaultSpaceInstall({
      serverRunningCheck: async () => true,
    })).rejects.toThrow(/server appears to be running/);

    expect(fs.existsSync(path.join(fixture.instanceRoot, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.spaceRoot, "config.json"))).toBe(false);
  });

  it("checks the destination space config when the instance root only has a space registry", async () => {
    const fixture = createLegacyInstallFixture();
    const destinationConfig = JSON.parse(fs.readFileSync(path.join(fixture.instanceRoot, "config.json"), "utf8")) as PaperclipConfig;
    fs.rmSync(path.join(fixture.instanceRoot, "config.json"));
    writeJson(path.join(fixture.instanceRoot, "config.json"), {
      $meta: { version: 1, updatedAt: "2026-05-10T00:00:00.000Z", source: "system" },
      activeSpaceId: "default",
      spaces: [{ id: "default", root: "spaces/default", createdAt: "2026-05-10T00:00:00.000Z" }],
    });
    writeJson(path.join(fixture.spaceRoot, "config.json"), {
      ...destinationConfig,
      server: {
        ...destinationConfig.server,
        port: 43210,
      },
    });
    const fetchMock = vi.fn(async () => ({ status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(defaultServerRunningCheck({
      instanceId: "default",
      sourceRoot: fixture.instanceRoot,
      destinationRoot: fixture.spaceRoot,
      legacyRuntimeConfig: false,
      sourcePathNames: [],
      conflicts: [],
    })).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:43210/api/health", expect.any(Object));
  });
});
