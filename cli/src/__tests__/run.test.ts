import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeConfig } from "../config/store.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_STDIN_TTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const ORIGINAL_STDOUT_TTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

const mocks = vi.hoisted(() => ({
  onboard: vi.fn(),
  doctor: vi.fn(),
  startServer: vi.fn(),
  bootstrap: vi.fn(),
}));

vi.mock("../commands/onboard.js", () => ({
  onboard: mocks.onboard,
}));

vi.mock("../commands/doctor.js", () => ({
  doctor: mocks.doctor,
}));

vi.mock("../commands/auth-bootstrap-ceo.js", () => ({
  bootstrapCeoInvite: mocks.bootstrap,
}));

vi.mock("@paperclipai/server", () => ({
  startServer: mocks.startServer,
}));

function writeMinimalConfig(configPath: string) {
  const runtimeRoot = path.join(path.dirname(configPath), "runtime");
  const config: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: "2026-04-12T00:00:00.000Z",
      source: "onboard",
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

  writeConfig(config, configPath);
}

function setTTY(isInteractive: boolean) {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: isInteractive,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: isInteractive,
  });
}

function restoreTTY() {
  if (ORIGINAL_STDIN_TTY) {
    Object.defineProperty(process.stdin, "isTTY", ORIGINAL_STDIN_TTY);
  }
  if (ORIGINAL_STDOUT_TTY) {
    Object.defineProperty(process.stdout, "isTTY", ORIGINAL_STDOUT_TTY);
  }
}

describe("runCommand", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_AUTO_ONBOARD;
    mocks.onboard.mockReset();
    mocks.doctor.mockReset();
    mocks.startServer.mockReset();
    mocks.bootstrap.mockReset();
    mocks.onboard.mockImplementation(async ({ config }: { config?: string }) => {
      if (!config) {
        throw new Error("expected config path");
      }
      writeMinimalConfig(config);
    });
    mocks.doctor.mockResolvedValue({ failed: 0, warned: 0 });
    mocks.startServer.mockResolvedValue({
      apiUrl: "http://127.0.0.1:3100/api",
      databaseUrl: "postgres://local-test",
      host: "127.0.0.1",
      listenPort: 3100,
    });
    mocks.bootstrap.mockResolvedValue(undefined);
    setTTY(false);
  });

  afterEach(() => {
    restoreTTY();
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("auto-bootstraps config for managed non-interactive launches", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-run-auto-"));
    const configPath = path.join(tempRoot, "instance", "config.json");
    const devEntryPath = path.resolve(process.cwd(), "server/src/index.ts");
    const originalExistsSync = fs.existsSync.bind(fs);

    process.env.PAPERCLIP_AUTO_ONBOARD = "1";

    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      if (path.resolve(String(candidate)) === devEntryPath) {
        return false;
      }
      return originalExistsSync(candidate);
    });

    const { runCommand } = await import("../commands/run.js");
    await runCommand({ config: configPath });

    expect(mocks.onboard).toHaveBeenCalledWith({
      config: configPath,
      yes: true,
      invokedByRun: true,
    });
    expect(mocks.doctor).toHaveBeenCalled();
    expect(mocks.startServer).toHaveBeenCalled();
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("keeps failing in non-interactive mode when auto-bootstrap is not enabled", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-run-fail-"));
    const configPath = path.join(tempRoot, "instance", "config.json");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as never);

    const { runCommand } = await import("../commands/run.js");

    await expect(runCommand({ config: configPath })).rejects.toThrow("process.exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.onboard).not.toHaveBeenCalled();
    expect(fs.existsSync(configPath)).toBe(false);
  });
});
