import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  embeddedPostgresCtorMock,
  embeddedPostgresInitialiseMock,
  embeddedPostgresStartMock,
  inspectEmbeddedPostgresLifecycleMock,
  resolveDatabaseTargetMock,
} = vi.hoisted(() => {
  const embeddedPostgresInitialiseMock = vi.fn(async () => undefined);
  const embeddedPostgresStartMock = vi.fn(async () => undefined);
  const embeddedPostgresCtorMock = vi.fn(function EmbeddedPostgresMock() {
    return {
      initialise: embeddedPostgresInitialiseMock,
      start: embeddedPostgresStartMock,
      stop: vi.fn(async () => undefined),
    };
  });
  return {
    embeddedPostgresCtorMock,
    embeddedPostgresInitialiseMock,
    embeddedPostgresStartMock,
    inspectEmbeddedPostgresLifecycleMock: vi.fn(),
    resolveDatabaseTargetMock: vi.fn(),
  };
});

vi.mock("embedded-postgres", () => ({ default: embeddedPostgresCtorMock }));

vi.mock("node:net", () => ({
  createServer: vi.fn(() => {
    const server = {
      unref: vi.fn(),
      once: vi.fn(() => server),
      listen: vi.fn((_port: number, _host: string, onListen: () => void) => {
        onListen();
        return server;
      }),
      close: vi.fn(),
    };
    return server;
  }),
}));

vi.mock("./client.js", () => ({
  ensurePostgresDatabase: vi.fn(async () => "exists"),
  getPostgresDataDirectory: vi.fn(async () => null),
}));

vi.mock("./embedded-postgres-error.js", () => ({
  createEmbeddedPostgresLogBuffer: vi.fn(() => ({
    append: vi.fn(),
    getRecentLogs: vi.fn(() => []),
  })),
  formatEmbeddedPostgresError: vi.fn((error: unknown) => error),
}));

vi.mock("./embedded-postgres-lifecycle.js", () => ({
  formatEmbeddedPostgresLifecycleAmbiguity: vi.fn(
    () => "ambiguous embedded PostgreSQL identity",
  ),
  inspectEmbeddedPostgresLifecycle: inspectEmbeddedPostgresLifecycleMock,
}));

vi.mock("./embedded-postgres-native.js", () => ({
  prepareEmbeddedPostgresNativeRuntime: vi.fn(async () => undefined),
}));

vi.mock("./runtime-config.js", () => ({
  resolveDatabaseTarget: resolveDatabaseTargetMock,
}));

import { resolveMigrationConnection } from "./migration-runtime.js";

describe("migration embedded PostgreSQL lifecycle", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createTarget() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-migration-lifecycle-"));
    tempDirs.push(dataDir);
    const port = 65420;
    resolveDatabaseTargetMock.mockReturnValue({ mode: "embedded-postgres", dataDir, port });
    return { dataDir, port, pidFile: path.join(dataDir, "postmaster.pid") };
  }

  it("removes a PID file classified as stale immediately before startup", async () => {
    const target = createTarget();
    fs.writeFileSync(target.pidFile, "4242\n");
    inspectEmbeddedPostgresLifecycleMock.mockResolvedValue({
      state: "stale",
      pid: 4242,
      port: target.port,
      dataDir: target.dataDir,
      pidFile: target.pidFile,
      pidFileDataDir: target.dataDir,
      reason: "dead_pid",
    });

    const connection = await resolveMigrationConnection();

    expect(fs.existsSync(target.pidFile)).toBe(false);
    expect(embeddedPostgresStartMock).toHaveBeenCalledTimes(1);
    expect(connection.connectionString).toBe(
      `postgres://paperclip:paperclip@127.0.0.1:${target.port}/paperclip`,
    );
  });

  it("preserves an ambiguous PID file and does not construct a second postmaster", async () => {
    const target = createTarget();
    fs.writeFileSync(target.pidFile, "4242\n");
    inspectEmbeddedPostgresLifecycleMock.mockResolvedValue({
      state: "ambiguous",
      pid: 4242,
      port: target.port,
      dataDir: target.dataDir,
      pidFile: target.pidFile,
      pidFileDataDir: target.dataDir,
      reason: "identity_unverified",
    });

    await expect(resolveMigrationConnection()).rejects.toThrow(
      "ambiguous embedded PostgreSQL identity",
    );

    expect(fs.readFileSync(target.pidFile, "utf8")).toBe("4242\n");
    expect(embeddedPostgresCtorMock).not.toHaveBeenCalled();
    expect(embeddedPostgresStartMock).not.toHaveBeenCalled();
  });
});
