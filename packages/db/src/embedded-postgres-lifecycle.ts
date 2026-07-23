import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPostgresDataDirectory } from "./client.js";

const BOOT_BOUNDARY_TOLERANCE_MS = 5 * 60 * 1000;

export type EmbeddedPostgresPidLiveness = "alive" | "dead" | "inaccessible";

export type EmbeddedPostgresLifecycleReason =
  | "pid_file_missing"
  | "pid_file_unreadable"
  | "invalid_pid"
  | "dead_pid"
  | "pre_boot_pid_file"
  | "non_postgres_process"
  | "data_directory_mismatch"
  | "invalid_start_time"
  | "identity_unverified"
  | "data_directory_match";

type EmbeddedPostgresLifecycleBase = {
  dataDir: string;
  pidFile: string;
  pidFileDataDir: string | null;
  port: number;
  reason: EmbeddedPostgresLifecycleReason;
};

export type EmbeddedPostgresLifecycleResult =
  | (EmbeddedPostgresLifecycleBase & {
      state: "absent";
      pid: null;
      reason: "pid_file_missing";
    })
  | (EmbeddedPostgresLifecycleBase & {
      state: "running";
      pid: number;
      reason: "data_directory_match";
    })
  | (EmbeddedPostgresLifecycleBase & {
      state: "stale";
      pid: number | null;
      reason: "invalid_pid" | "dead_pid" | "pre_boot_pid_file" | "non_postgres_process";
    })
  | (EmbeddedPostgresLifecycleBase & {
      state: "ambiguous";
      pid: number | null;
      reason:
        | "pid_file_unreadable"
        | "data_directory_mismatch"
        | "invalid_start_time"
        | "identity_unverified";
    });

export type EmbeddedPostgresLifecycleDependencies = {
  now: () => number;
  uptimeSeconds: () => number;
  checkPidLiveness: (pid: number) => EmbeddedPostgresPidLiveness;
  inspectProcessCommand: (pid: number) => Promise<string | null>;
  probeDataDirectory: (connectionString: string) => Promise<string | null>;
  platform: NodeJS.Platform;
};

export function formatEmbeddedPostgresLifecycleAmbiguity(
  result: Extract<EmbeddedPostgresLifecycleResult, { state: "ambiguous" }>,
): string {
  const pid = result.pid ?? "unknown";
  const pidFileDataDir = result.pidFileDataDir ?? "unknown";
  return (
    `Embedded PostgreSQL identity is ambiguous (pid=${pid}, port=${result.port}, ` +
    `expectedDataDir=${result.dataDir}, pidFileDataDir=${pidFileDataDir}, reason=${result.reason}). ` +
    `Refusing to remove ${result.pidFile} or start another PostgreSQL process. ` +
    "Stop Paperclip, verify that no PostgreSQL process uses this data directory, then archive or remove the PID file manually if it is stale."
  );
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function checkPidLiveness(pid: number): EmbeddedPostgresPidLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "inaccessible";
  }
}

async function inspectProcessCommand(pid: number): Promise<string | null> {
  return await new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "comm="],
      { timeout: 1_000, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const command = stdout.trim();
        resolve(command.length > 0 ? command : null);
      },
    );
  });
}

const defaultDependencies: EmbeddedPostgresLifecycleDependencies = {
  now: Date.now,
  uptimeSeconds: os.uptime,
  checkPidLiveness,
  inspectProcessCommand,
  probeDataDirectory: getPostgresDataDirectory,
  platform: process.platform,
};

function isPossiblyPostgresCommand(command: string): boolean {
  return /(?:^|[\\/])(?:postgres|postmaster)(?:$|[\s:])/i.test(command.trim());
}

export async function inspectEmbeddedPostgresLifecycle(
  input: { dataDir: string; configuredPort: number },
  dependencies: EmbeddedPostgresLifecycleDependencies = defaultDependencies,
): Promise<EmbeddedPostgresLifecycleResult> {
  const dataDir = path.resolve(input.dataDir);
  const pidFile = path.resolve(dataDir, "postmaster.pid");
  const configuredPort = parsePositiveInteger(String(input.configuredPort));
  if (configuredPort === null) {
    throw new Error(`Invalid embedded PostgreSQL configured port: ${input.configuredPort}`);
  }

  const base = {
    dataDir,
    pidFile,
    pidFileDataDir: null,
    port: configuredPort,
  };

  if (!existsSync(pidFile)) {
    return { ...base, state: "absent", pid: null, reason: "pid_file_missing" };
  }

  let lines: string[];
  try {
    lines = readFileSync(pidFile, "utf8").split("\n");
  } catch {
    return { ...base, state: "ambiguous", pid: null, reason: "pid_file_unreadable" };
  }

  const pidFileDataDir = lines[1]?.trim() || null;
  const pid = parsePositiveInteger(lines[0]);
  const recordedPort = parsePositiveInteger(lines[3]);
  const port = recordedPort ?? configuredPort;
  const parsedBase = { ...base, pidFileDataDir, port };

  if (pid === null) {
    return { ...parsedBase, state: "stale", pid: null, reason: "invalid_pid" };
  }

  const adminConnectionString =
    `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  let actualDataDir: string | null = null;
  try {
    actualDataDir = await dependencies.probeDataDirectory(adminConnectionString);
  } catch {
    actualDataDir = null;
  }
  if (typeof actualDataDir === "string" && path.resolve(actualDataDir) === dataDir) {
    return { ...parsedBase, state: "running", pid, reason: "data_directory_match" };
  }

  let liveness: EmbeddedPostgresPidLiveness;
  try {
    liveness = dependencies.checkPidLiveness(pid);
  } catch {
    liveness = "inaccessible";
  }
  if (liveness === "dead") {
    return { ...parsedBase, state: "stale", pid, reason: "dead_pid" };
  }

  const startEpochSeconds = parsePositiveInteger(lines[2]);
  if (startEpochSeconds !== null) {
    const bootEpochMs = dependencies.now() - dependencies.uptimeSeconds() * 1000;
    if (startEpochSeconds * 1000 < bootEpochMs - BOOT_BOUNDARY_TOLERANCE_MS) {
      return { ...parsedBase, state: "stale", pid, reason: "pre_boot_pid_file" };
    }
  }

  if (dependencies.platform !== "win32") {
    let command: string | null = null;
    try {
      command = await dependencies.inspectProcessCommand(pid);
    } catch {
      command = null;
    }
    if (command !== null && !isPossiblyPostgresCommand(command)) {
      return { ...parsedBase, state: "stale", pid, reason: "non_postgres_process" };
    }
  }

  if (actualDataDir !== null) {
    return { ...parsedBase, state: "ambiguous", pid, reason: "data_directory_mismatch" };
  }
  if (startEpochSeconds === null) {
    return { ...parsedBase, state: "ambiguous", pid, reason: "invalid_start_time" };
  }
  return { ...parsedBase, state: "ambiguous", pid, reason: "identity_unverified" };
}
