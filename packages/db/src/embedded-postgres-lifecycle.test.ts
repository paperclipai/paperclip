import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectEmbeddedPostgresLifecycle,
  type EmbeddedPostgresLifecycleDependencies,
} from "./embedded-postgres-lifecycle.js";

const NOW_MS = Date.UTC(2026, 6, 17, 12, 0, 0);
const UPTIME_SECONDS = 60 * 60;
const CURRENT_BOOT_EPOCH_SECONDS = NOW_MS / 1000 - UPTIME_SECONDS;

describe("embedded Postgres lifecycle inspection", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function createDataDir(): string {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-pg-lifecycle-"));
    tempDirs.push(dataDir);
    return dataDir;
  }

  function writePidFile(input: {
    dataDir: string;
    pid?: string | number;
    pidDataDir?: string;
    startEpochSeconds?: string | number;
    port?: string | number;
  }): string {
    const pidFile = path.join(input.dataDir, "postmaster.pid");
    fs.writeFileSync(
      pidFile,
      [
        input.pid ?? 4242,
        input.pidDataDir ?? input.dataDir,
        input.startEpochSeconds ?? CURRENT_BOOT_EPOCH_SECONDS + 60,
        input.port ?? 54330,
        "",
      ].join("\n"),
    );
    return pidFile;
  }

  function dependencies(
    overrides: Partial<EmbeddedPostgresLifecycleDependencies> = {},
  ): EmbeddedPostgresLifecycleDependencies {
    return {
      now: () => NOW_MS,
      uptimeSeconds: () => UPTIME_SECONDS,
      checkPidLiveness: () => "alive",
      inspectProcessCommand: async () => null,
      probeDataDirectory: async () => null,
      platform: "darwin",
      ...overrides,
    };
  }

  it("returns absent when postmaster.pid does not exist", async () => {
    const dataDir = createDataDir();

    const result = await inspectEmbeddedPostgresLifecycle(
      { dataDir, configuredPort: 54329 },
      dependencies(),
    );

    expect(result).toMatchObject({
      state: "absent",
      pid: null,
      port: 54329,
      dataDir: path.resolve(dataDir),
    });
  });

  it.each(["not-a-pid", "0", "-1", "42.5"])(
    "returns stale for malformed or non-positive PID %s without probing a process",
    async (pid) => {
      const dataDir = createDataDir();
      writePidFile({ dataDir, pid });
      const checkPidLiveness = vi.fn(() => "alive" as const);

      const result = await inspectEmbeddedPostgresLifecycle(
        { dataDir, configuredPort: 54329 },
        dependencies({ checkPidLiveness }),
      );

      expect(result).toMatchObject({ state: "stale", pid: null, reason: "invalid_pid" });
      expect(checkPidLiveness).not.toHaveBeenCalled();
    },
  );

  it("returns stale for a dead PID", async () => {
    const dataDir = createDataDir();
    writePidFile({ dataDir });

    const result = await inspectEmbeddedPostgresLifecycle(
      { dataDir, configuredPort: 54329 },
      dependencies({ checkPidLiveness: () => "dead" }),
    );

    expect(result).toMatchObject({ state: "stale", pid: 4242, reason: "dead_pid" });
  });

  it("returns stale when a pre-boot PID was reused by a live process", async () => {
    const dataDir = createDataDir();
    writePidFile({
      dataDir,
      pid: 1406,
      startEpochSeconds: CURRENT_BOOT_EPOCH_SECONDS - 301,
      port: 54330,
    });

    const result = await inspectEmbeddedPostgresLifecycle(
      { dataDir, configuredPort: 54329 },
      dependencies({
        checkPidLiveness: () => "alive",
        inspectProcessCommand: async () => "nginx: worker process",
      }),
    );

    expect(result).toMatchObject({
      state: "stale",
      pid: 1406,
      port: 54330,
      reason: "pre_boot_pid_file",
    });
  });

  it("returns stale for a live current-boot PID definitively owned by another command", async () => {
    const dataDir = createDataDir();
    writePidFile({ dataDir });

    const result = await inspectEmbeddedPostgresLifecycle(
      { dataDir, configuredPort: 54329 },
      dependencies({ inspectProcessCommand: async () => "/usr/sbin/nginx" }),
    );

    expect(result).toMatchObject({
      state: "stale",
      pid: 4242,
      reason: "non_postgres_process",
    });
  });

  it("returns ambiguous for a live current-boot PID when identity evidence is unavailable", async () => {
    const dataDir = createDataDir();
    writePidFile({ dataDir });

    const result = await inspectEmbeddedPostgresLifecycle(
      { dataDir, configuredPort: 54329 },
      dependencies(),
    );

    expect(result).toMatchObject({
      state: "ambiguous",
      pid: 4242,
      port: 54330,
      reason: "identity_unverified",
    });
  });

  it("does not treat a PostgreSQL-looking process name as positive identity proof", async () => {
    const dataDir = createDataDir();
    writePidFile({ dataDir });

    const result = await inspectEmbeddedPostgresLifecycle(
      { dataDir, configuredPort: 54329 },
      dependencies({ inspectProcessCommand: async () => "/Applications/My App/bin/postgres" }),
    );

    expect(result).toMatchObject({
      state: "ambiguous",
      pid: 4242,
      reason: "identity_unverified",
    });
  });

  it("treats EPERM-style inaccessible PID evidence as live and fails closed", async () => {
    const dataDir = createDataDir();
    writePidFile({ dataDir });

    const result = await inspectEmbeddedPostgresLifecycle(
      { dataDir, configuredPort: 54329 },
      dependencies({ checkPidLiveness: () => "inaccessible" }),
    );

    expect(result).toMatchObject({
      state: "ambiguous",
      pid: 4242,
      reason: "identity_unverified",
    });
  });

  it("returns ambiguous when reachable PostgreSQL uses another data directory", async () => {
    const dataDir = createDataDir();
    writePidFile({ dataDir });

    const result = await inspectEmbeddedPostgresLifecycle(
      { dataDir, configuredPort: 54329 },
      dependencies({ probeDataDirectory: async () => path.join(dataDir, "other") }),
    );

    expect(result).toMatchObject({
      state: "ambiguous",
      pid: 4242,
      reason: "data_directory_mismatch",
    });
  });

  it("returns running for a matching data directory and uses the recorded port", async () => {
    const dataDir = createDataDir();
    writePidFile({ dataDir, pidDataDir: `${dataDir}/.`, port: 55444 });
    const probeDataDirectory = vi.fn(async () => `${dataDir}/.`);

    const result = await inspectEmbeddedPostgresLifecycle(
      { dataDir, configuredPort: 54329 },
      dependencies({ probeDataDirectory }),
    );

    expect(result).toMatchObject({ state: "running", pid: 4242, port: 55444 });
    expect(probeDataDirectory).toHaveBeenCalledWith(
      "postgres://paperclip:paperclip@127.0.0.1:55444/postgres",
    );
  });

  it.each(["", "not-a-port", "0", "-1", "54329.5"])(
    "falls back to the configured port when PID-file port is invalid: %s",
    async (port) => {
      const dataDir = createDataDir();
      writePidFile({ dataDir, port });
      const probeDataDirectory = vi.fn(async () => dataDir);

      const result = await inspectEmbeddedPostgresLifecycle(
        { dataDir, configuredPort: 54329 },
        dependencies({ probeDataDirectory }),
      );

      expect(result).toMatchObject({ state: "running", port: 54329 });
      expect(probeDataDirectory).toHaveBeenCalledWith(
        "postgres://paperclip:paperclip@127.0.0.1:54329/postgres",
      );
    },
  );

  it("keeps a PID-file timestamp within the boot tolerance ambiguous", async () => {
    const dataDir = createDataDir();
    writePidFile({ startEpochSeconds: CURRENT_BOOT_EPOCH_SECONDS - 299, dataDir });

    const result = await inspectEmbeddedPostgresLifecycle(
      { dataDir, configuredPort: 54329 },
      dependencies(),
    );

    expect(result).toMatchObject({ state: "ambiguous", reason: "identity_unverified" });
  });

  it("does not modify postmaster.pid while inspecting it", async () => {
    const dataDir = createDataDir();
    const pidFile = writePidFile({
      dataDir,
      pid: 1406,
      startEpochSeconds: CURRENT_BOOT_EPOCH_SECONDS - 301,
    });
    const before = fs.readFileSync(pidFile);

    await inspectEmbeddedPostgresLifecycle(
      { dataDir, configuredPort: 54329 },
      dependencies({ inspectProcessCommand: async () => "nginx" }),
    );

    expect(fs.readFileSync(pidFile)).toEqual(before);
  });
});
