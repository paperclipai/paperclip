import { existsSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";

/**
 * Parsed content of a PostgreSQL postmaster.pid file.
 */
export interface PostmasterPidInfo {
  /** The process ID recorded in the first line. */
  pid: number;
  /** The port number recorded in the fourth line, or null if absent/invalid. */
  port: number | null;
}

/**
 * Read and parse a PostgreSQL postmaster.pid file.
 * Returns null if the file does not exist or contains invalid data.
 */
export function readPostmasterPidFile(pidFilePath: string): PostmasterPidInfo | null {
  if (!existsSync(pidFilePath)) return null;
  try {
    const lines = readFileSync(pidFilePath, "utf8").split("\n");
    const pid = Number(lines[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const port = Number(lines[3]?.trim());
    const parsedPort = Number.isInteger(port) && port > 0 ? port : null;
    return { pid, port: parsedPort };
  } catch {
    return null;
  }
}

/**
 * Check whether a process with the given PID exists.
 *
 * Uses `process.kill(pid, 0)` which sends signal 0 (no-op) to test
 * whether the process exists without actually killing it.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt a TCP connection to the given host and port.
 * Resolves to `true` if the connection succeeds within `timeoutMs`,
 * `false` otherwise (connection refused, timeout, etc.).
 *
 * This is used to verify that a process holding a PID is actually
 * listening on the expected PostgreSQL port, guarding against PID
 * reuse by unrelated processes (common on Windows).
 */
export function tryTcpConnect(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Determine whether the postmaster.pid file points to a genuinely running
 * PostgreSQL instance.
 *
 * The check is:
 * 1. Parse the PID from the file.
 * 2. Verify the PID is alive via `process.kill(pid, 0)`.
 * 3. If a port is recorded, verify that something is actually listening
 *    on that port via a TCP connect probe. This guards against PID reuse
 *    by unrelated processes (e.g. a browser tab inheriting an old PID on
 *    Windows after a crash).
 *
 * Returns the validated PID and port, or null if the pid file is stale.
 */
export async function validatePostmasterPid(
  pidFilePath: string,
  opts?: { logger?: { warn: (message: string) => void }; tcpTimeoutMs?: number },
): Promise<PostmasterPidInfo | null> {
  const info = readPostmasterPidFile(pidFilePath);
  if (!info) return null;

  if (!isPidAlive(info.pid)) {
    opts?.logger?.warn(
      `Postmaster PID ${info.pid} from ${pidFilePath} is not alive; treating as stale`,
    );
    return null;
  }

  // If we have a port recorded, verify the process is actually listening on it.
  // This catches PID reuse: the PID may belong to an unrelated process (especially
  // on Windows where PIDs are recycled quickly).
  if (info.port !== null) {
    const reachable = await tryTcpConnect("127.0.0.1", info.port, opts?.tcpTimeoutMs ?? 1500);
    if (!reachable) {
      opts?.logger?.warn(
        `PID ${info.pid} is alive but port ${info.port} is not reachable; treating postmaster.pid as stale (likely PID reuse by an unrelated process)`,
      );
      return null;
    }
  }

  return info;
}

/**
 * Remove a stale postmaster.pid file, logging the action if a logger is provided.
 */
export function removeStalePostmasterPid(
  pidFilePath: string,
  opts?: { logger?: { warn: (message: string) => void } },
): void {
  if (!existsSync(pidFilePath)) return;
  opts?.logger?.warn(`Removing stale postmaster.pid at ${pidFilePath}`);
  rmSync(pidFilePath, { force: true });
}
