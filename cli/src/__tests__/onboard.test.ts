import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
}));

import { onboard } from "../commands/onboard.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };

function createExistingConfigFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-onboard-"));
  const runtimeRoot = path.join(root, "runtime");
  const configPath = path.join(root, ".paperclip", "config.json");
  const config: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: "2026-03-29T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(runtimeRoot, "db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: path.join(runtimeRoot, "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(runtimeRoot, "logs"),
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
        baseDir: path.join(runtimeRoot, "storage"),
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
        keyFilePath: path.join(runtimeRoot, "secrets", "master.key"),
      },
    },
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  return { configPath, configText: fs.readFileSync(configPath, "utf8") };
}

function createFreshConfigPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-onboard-fresh-"));
  return path.join(root, ".paperclip", "config.json");
}

describe("onboard", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    execFileSyncMock.mockReset();
    execFileSyncMock.mockImplementation(() => {
      throw new Error("tailscale unavailable");
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("preserves an existing config when rerun without flags", async () => {
    const fixture = createExistingConfigFixture();

    await onboard({ config: fixture.configPath });

    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(fixture.configText);
    expect(fs.existsSync(`${fixture.configPath}.backup`)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(fixture.configPath), ".env"))).toBe(true);
  });

  it("preserves an existing config when rerun with --yes", async () => {
    const fixture = createExistingConfigFixture();

    await onboard({ config: fixture.configPath, yes: true, invokedByRun: true });

    expect(fs.readFileSync(fixture.configPath, "utf8")).toBe(fixture.configText);
    expect(fs.existsSync(`${fixture.configPath}.backup`)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(fixture.configPath), ".env"))).toBe(true);
  });

  it("keeps --yes onboarding on local trusted loopback defaults", async () => {
    const configPath = createFreshConfigPath();
    process.env.HOST = "0.0.0.0";
    process.env.PAPERCLIP_BIND = "lan";

    await onboard({ config: configPath, yes: true, invokedByRun: true });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as PaperclipConfig;
    expect(raw.server.deploymentMode).toBe("local_trusted");
    expect(raw.server.exposure).toBe("private");
    expect(raw.server.bind).toBe("loopback");
    expect(raw.server.host).toBe("127.0.0.1");
  });

  it("supports authenticated/private quickstart bind presets", async () => {
    const configPath = createFreshConfigPath();
    process.env.PAPERCLIP_TAILNET_BIND_HOST = "100.64.0.8";

    await onboard({ config: configPath, yes: true, invokedByRun: true, bind: "tailnet" });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as PaperclipConfig;
    expect(raw.server.deploymentMode).toBe("authenticated");
    expect(raw.server.exposure).toBe("private");
    expect(raw.server.bind).toBe("tailnet");
    expect(raw.server.host).toBe("100.64.0.8");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("keeps tailnet quickstart on loopback until tailscale is available", async () => {
    const configPath = createFreshConfigPath();
    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;

    await onboard({ config: configPath, yes: true, invokedByRun: true, bind: "tailnet" });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as PaperclipConfig;
    expect(raw.server.deploymentMode).toBe("authenticated");
    expect(raw.server.exposure).toBe("private");
    expect(raw.server.bind).toBe("tailnet");
    expect(raw.server.host).toBe("127.0.0.1");
    expect(execFileSyncMock).toHaveBeenCalled();
  });

  it("ignores deployment env overrides during --yes quickstart", async () => {
    const configPath = createFreshConfigPath();
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";

    await onboard({ config: configPath, yes: true, invokedByRun: true });

    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as PaperclipConfig;
    expect(raw.server.deploymentMode).toBe("local_trusted");
    expect(raw.server.exposure).toBe("private");
    expect(raw.server.bind).toBe("loopback");
    expect(raw.server.host).toBe("127.0.0.1");
  });
});
