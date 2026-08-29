import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Canonicalize for comparison against a path PostgreSQL wrote itself.
 *
 * postmaster.pid records the *physical* directory (make_absolute_path over the
 * post-chdir getcwd), so a data directory reached through a symlink is recorded
 * as `/private/var/...` while the configured path resolves to `/var/...`.
 * Comparing with path.resolve alone reports a healthy cluster as foreign, which
 * is never recoverable. Falls back to path.resolve when the path is gone.
 */
export function canonicalizeDataDirectory(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

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

  if (lock.dataDir && canonicalizeDataDirectory(lock.dataDir) !== canonicalizeDataDirectory(dataDir)) {
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

/**
 * What the server holding the configured port turned out to be.
 *
 * `unidentified` covers two situations that look different but license the same
 * decision: the identify probe failed outright -- a refused connection, or a
 * connect timeout from a postmaster that accepted the socket and then went quiet
 * replaying WAL -- and a server that answered readiness but would not name its
 * data directory.
 */
export type PortHolderIdentity =
  | { kind: "ours" }
  | { kind: "other-cluster"; dataDir: string }
  | { kind: "unidentified" };

export type EmbeddedPostgresStartDecision =
  | { action: "adopt"; port: number }
  | { action: "start"; port: number }
  | { action: "refuse"; reason: string };

/**
 * Decide where -- or whether -- to start a postmaster for `dataDir`.
 *
 * The rule: a port fallback is safe only once the holder of the configured port
 * has been positively identified as a *different* cluster, because the fallback
 * changes the port but not the data directory. An unidentified holder may be our
 * own postmaster still replaying WAL, and starting a second one over its
 * directory fatals on the shared memory block at best.
 *
 * "Nothing answered the probe" is therefore not the same claim as "the directory
 * is free" -- only a genuinely idle port proves that. Callers pass what
 * detectPort reported so the two can be told apart here rather than at the call
 * site, where conflating them is what kept the original bug reachable.
 */
export function decideEmbeddedPostgresStart(input: {
  configuredPort: number;
  detectedPort: number;
  identity: PortHolderIdentity;
  dataDir: string;
}): EmbeddedPostgresStartDecision {
  const { configuredPort, detectedPort, identity, dataDir } = input;

  if (identity.kind === "ours") return { action: "adopt", port: configuredPort };

  // The configured port is idle, so whatever the probe failed to reach is gone
  // and the directory is ours to start over.
  if (detectedPort === configuredPort) return { action: "start", port: configuredPort };

  if (identity.kind === "unidentified") {
    return {
      action: "refuse",
      reason:
        `Port ${configuredPort} is in use, but the server there could not be identified, so ownership ` +
        `of ${dataDir} could not be established. Refusing to start a second postmaster over ` +
        `possibly-live data. Stop whatever is using port ${configuredPort}, or point the instance ` +
        `at a different port, then retry.`,
    };
  }

  // Proven to be somebody else's cluster, so our directory is unowned and moving
  // to a free port starts nothing over live data.
  return { action: "start", port: detectedPort };
}

// NOTE: this module deliberately provides no way to delete postmaster.pid.
// PostgreSQL removes a genuinely stale lock file itself in CreateLockFile,
// atomically, inside the process about to take ownership. Any check-then-delete
// we perform here races a cluster that starts in between and deletes its live
// lock file -- the exact failure this module exists to prevent. Decide with
// inspectPostmasterLock; leave the file to PostgreSQL.
