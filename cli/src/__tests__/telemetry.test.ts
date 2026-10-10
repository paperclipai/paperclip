import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const CI_ENV_VARS = ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI"];

function makeConfigPath(root: string, enabled: boolean): string {
  const configPath = path.join(root, ".paperclip", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    $meta: {
      version: 1,
      updatedAt: "2026-03-31T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(root, "runtime", "db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(root, "runtime", "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(root, "runtime", "logs"),
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
      enabled,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(root, "runtime", "storage"),
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
        keyFilePath: path.join(root, "runtime", "secrets", "master.key"),
      },
    },
  }, null, 2));
  return configPath;
}

describe("cli telemetry", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    for (const key of CI_ENV_VARS) {
      delete process.env[key];
    }
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("respects telemetry.enabled=false from the config file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-telemetry-"));
    const configPath = makeConfigPath(root, false);
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "telemetry-test";

    const { initTelemetryFromConfigFile } = await import("../telemetry.js");
    const client = initTelemetryFromConfigFile(configPath);

    expect(client).toBeNull();
    expect(fs.existsSync(path.join(root, "home", "instances", "telemetry-test", "telemetry", "state.json"))).toBe(false);
  });

  it("creates telemetry state only after the first event is tracked", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-telemetry-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "telemetry-test";

    const { initTelemetry, flushTelemetry } = await import("../telemetry.js");
    const client = initTelemetry({ enabled: true });
    const statePath = path.join(root, "home", "instances", "telemetry-test", "telemetry", "state.json");

    expect(client).not.toBeNull();
    expect(fs.existsSync(statePath)).toBe(false);

    client!.track("install.started", { setupMode: "quickstart" });

    expect(fs.existsSync(statePath)).toBe(true);

    await flushTelemetry();
  });
});
