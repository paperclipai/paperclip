import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Line offsets inside `postmaster.pid`, per PostgreSQL's
 * `src/include/utils/pidfile.h`. Only the lines Paperclip needs are named.
 */
const LOCK_FILE_LINE_PID = 0;
const LOCK_FILE_LINE_DATA_DIR = 1;
const LOCK_FILE_LINE_PORT = 3;

export const POSTMASTER_LOCK_FILE_NAME = "postmaster.pid";

export type PostmasterLockFile = {
  /** Absolute path of the `postmaster.pid` that was read. */
  path: string;
  /** Postmaster pid. PostgreSQL writes this negated for standalone backends. */
  pid: number;
  /** Data directory the lock file claims to own, when parseable. */
  dataDir: string | null;
  /** Port the postmaster claims to listen on, when parseable. */
  port: number | null;
};

/**
 * Whether a pid is running. `"unknown"` is a distinct state on purpose: a
 * liveness probe that cannot answer must never be collapsed into `"dead"`,
 * because the only thing callers do with `"dead"` is delete a lock file.
 */
export type ProcessLiveness = "alive" | "dead" | "unknown";

export type PostmasterLockStatus =
  | { status: "absent" }
  | { status: "running"; lock: PostmasterLockFile }
  | { status: "stale"; lock: PostmasterLockFile }
  /**
   * A lock file we cannot adjudicate — treated as occupied, never cleared.
   * `lock` is null when the file exists but could not be read or parsed at all,
   * which is still evidence of ownership, not of absence.
   */
  | { status: "indeterminate"; lock: PostmasterLockFile | null; reason: string };

export function postmasterLockFilePath(dataDir: string): string {
  return path.resolve(dataDir, POSTMASTER_LOCK_FILE_NAME);
}

export function readPostmasterLockFile(dataDir: string): PostmasterLockFile | null {
  const lockPath = postmasterLockFilePath(dataDir);
  if (!existsSync(lockPath)) return null;

  let lines: string[];
  try {
    lines = readFileSync(lockPath, "utf8").split("\n");
  } catch {
    return null;
  }

  const pid = Number(lines[LOCK_FILE_LINE_PID]?.trim());
  if (!Number.isInteger(pid) || pid === 0) return null;

  const recordedDataDir = lines[LOCK_FILE_LINE_DATA_DIR]?.trim();
  const recordedPort = Number(lines[LOCK_FILE_LINE_PORT]?.trim());

  return {
    path: lockPath,
    pid,
    dataDir: recordedDataDir ? recordedDataDir : null,
    port: Number.isInteger(recordedPort) && recordedPort > 0 ? recordedPort : null,
  };
}

/**
 * Classify a pid using signal 0.
 *
 * The error code carries the answer and must not be discarded:
 *   - no throw  -> the process exists and is signalable.
 *   - `ESRCH`   -> the process genuinely does not exist. The ONLY proof of death.
 *   - `EPERM`   -> the process exists but this user may not signal it. On Windows
 *     `OpenProcess` returns `ERROR_ACCESS_DENIED` for postmasters left behind by
 *     an elevated or different-session run, so a blanket `catch` reports a live
 *     cluster as dead and its lock file then gets deleted out from under it.
 *   - anything else -> unknown; assume occupied and let the caller fail safe.
 */
export function probeProcessLiveness(
  pid: number,
  kill: (pid: number, signal: 0) => void = (target, signal) => {
    process.kill(target, signal);
  },
): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

export type InspectPostmasterLockDeps = {
  readLockFile?: (dataDir: string) => PostmasterLockFile | null;
  probeLiveness?: (pid: number) => ProcessLiveness;
  lockFileExists?: (dataDir: string) => boolean;
};

/**
 * Decide whether `dataDir` is owned by a live postmaster.
 *
 * A cluster is only reported `"stale"` when the recorded pid is provably gone.
 * Every other ambiguity resolves to "occupied", because the cost of a wrong
 * `"stale"` is a deleted lock file and a second postmaster on live data, while
 * the cost of a wrong "occupied" is a legible startup error.
 */
export function inspectPostmasterLock(
  dataDir: string,
  deps: InspectPostmasterLockDeps = {},
): PostmasterLockStatus {
  const readLockFile = deps.readLockFile ?? readPostmasterLockFile;
  const probeLiveness = deps.probeLiveness ?? ((pid: number) => probeProcessLiveness(pid));
  const lockFileExists = deps.lockFileExists ?? ((dir: string) => existsSync(postmasterLockFilePath(dir)));

  const lock = readLockFile(dataDir);
  if (!lock) {
    // "Could not parse" is not "not there". An unreadable file, or one whose pid
    // line is malformed, still means something claimed this directory — and that
    // postmaster may be listening on a port we would never probe. Reporting
    // "absent" here sends callers down the start path and reintroduces the
    // duplicate-postmaster failure through the back door.
    if (lockFileExists(dataDir)) {
      return {
        status: "indeterminate",
        lock: null,
        reason: `${POSTMASTER_LOCK_FILE_NAME} exists but could not be read or parsed`,
      };
    }
    return { status: "absent" };
  }

  if (lock.dataDir && path.resolve(lock.dataDir) !== path.resolve(dataDir)) {
    return {
      status: "indeterminate",
      lock,
      reason:
        `${POSTMASTER_LOCK_FILE_NAME} records data directory ${lock.dataDir}, ` +
        `which is not ${path.resolve(dataDir)}`,
    };
  }

  // A negative pid marks a standalone backend (not a postmaster) holding the
  // directory. Either way the directory is in use; we must not start over it.
  if (lock.pid < 0) {
    const liveness = probeLiveness(Math.abs(lock.pid));
    if (liveness === "dead") return { status: "stale", lock };
    return {
      status: "indeterminate",
      lock,
      reason: `${POSTMASTER_LOCK_FILE_NAME} records a standalone backend (pid=${Math.abs(lock.pid)})`,
    };
  }

  const liveness = probeLiveness(lock.pid);
  if (liveness === "alive") return { status: "running", lock };
  if (liveness === "dead") return { status: "stale", lock };
  return {
    status: "indeterminate",
    lock,
    reason: `process liveness for pid ${lock.pid} could not be determined`,
  };
}

export type RemoveStalePostmasterLockResult =
  | { removed: true; lock: PostmasterLockFile }
  | { removed: false; reason: string };

/**
 * Delete `postmaster.pid`, but only once the postmaster that wrote it is
 * confirmed dead. Callers must not remove the lock file themselves.
 */
export function removeStalePostmasterLock(
  dataDir: string,
  deps: InspectPostmasterLockDeps & { remove?: (lockPath: string) => void } = {},
): RemoveStalePostmasterLockResult {
  const remove = deps.remove ?? ((lockPath: string) => rmSync(lockPath, { force: true }));
  const inspected = inspectPostmasterLock(dataDir, deps);

  if (inspected.status === "absent") {
    return { removed: false, reason: `no ${POSTMASTER_LOCK_FILE_NAME} to remove` };
  }
  if (inspected.status === "running") {
    return {
      removed: false,
      reason: `refusing to remove ${POSTMASTER_LOCK_FILE_NAME}: pid ${inspected.lock.pid} is still running`,
    };
  }
  if (inspected.status === "indeterminate") {
    return {
      removed: false,
      reason: `refusing to remove ${POSTMASTER_LOCK_FILE_NAME}: ${inspected.reason}`,
    };
  }

  remove(inspected.lock.path);
  return { removed: true, lock: inspected.lock };
}
