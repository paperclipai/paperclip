import { createServer } from "node:net";
import {
  POSTMASTER_LOCK_FILE_NAME,
  canonicalizeDataDirectory,
  getPostgresDataDirectory,
  inspectPostmasterLock,
  waitForPostgresReady,
} from "@paperclipai/db";

/**
 * How long an already-listening server gets to identify itself. Short: something
 * is on the port, so this only has to outlast a socket still binding or a backend
 * replaying WAL, not a cold start.
 */
const IDENTIFY_TIMEOUT_MS = 3_000;

/**
 * Connect timeout for a single identify probe, in seconds. Must stay below the
 * budget above: the driver default (5s) outlives it, so a port held by something
 * that accepts the socket and then stalls would burn the entire budget on one
 * attempt and never reach the retry loop.
 */
const IDENTIFY_CONNECT_TIMEOUT_SECONDS = 1;

export type EmbeddedClusterDecision =
  /** A cluster of ours already serves this directory on `port`; reuse it. */
  | { action: "adopt"; port: number }
  /** Nothing owns the directory; the caller may start one. */
  | { action: "start" };

function adminConnectionString(port: number): string {
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
}

/** Whether anything holds `port`, regardless of what it is. */
async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close();
      resolve(false);
    });
  });
}

/**
 * How far above the preferred port to look for a cluster that already serves a
 * data directory.
 *
 * Callers allocate with a first-free-port walk that starts at the preferred
 * port, so a cluster this repo started for a directory sits a small number of
 * ports above it. Sixteen covers that spread without turning an ownership
 * question into a port sweep. It is a bound, not a proof: a cluster pushed far
 * from its preferred port by an unusually crowded range stays invisible here,
 * and only its lock file can place it.
 */
export const EMBEDDED_POSTGRES_PORT_SCAN_WINDOW = 16;

/**
 * Hard ceiling on identifying one scanned port.
 *
 * `waitForPostgresReady` checks its own budget only between attempts, so a
 * single attempt that never settles is never cut off: a service that accepts
 * the socket and then says nothing leaves the handshake pending, and
 * `connect_timeout` does not cover that -- it bounds the TCP connect, which
 * already succeeded. On the preferred port the caller has to pay that cost,
 * because it is about to start there. A scanned neighbour does not deserve it.
 */
const SCAN_PORT_TIMEOUT_MS = 3_000;

/**
 * Hard ceiling on the whole scan, so a crowded port range cannot turn an
 * ownership question into a minute of probing. Exhausting it is reported as "no
 * adjacent owner found": the residual risk is a live cluster that the budget ran
 * out before reaching, which is the same answer this code gave for every cluster
 * before the scan existed.
 */
const SCAN_TOTAL_TIMEOUT_MS = 12_000;

/**
 * Resolve `work`, or `null` if it has not settled within `ms`.
 *
 * The abandoned promise is left to finish on its own. Both probes close their
 * client in a `finally`, so nothing stays open beyond that.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const guarded = work.catch(() => null);
  try {
    return await Promise.race([
      guarded,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whether the server on `port` reports `dataDir` as its data directory. */
async function servesDataDirectory(port: number, dataDir: string): Promise<boolean> {
  await waitForPostgresReady(adminConnectionString(port), {
    timeoutMs: IDENTIFY_TIMEOUT_MS,
    connectTimeoutSeconds: IDENTIFY_CONNECT_TIMEOUT_SECONDS,
  });
  const actualDataDir = await getPostgresDataDirectory(adminConnectionString(port));
  return (
    typeof actualDataDir === "string" &&
    canonicalizeDataDirectory(actualDataDir) === canonicalizeDataDirectory(dataDir)
  );
}

/**
 * Find a live cluster serving `dataDir` on one of the ports just above
 * `preferredPort`, or `null` when none answers for it.
 *
 * A port that will not identify itself is skipped rather than refused. On the
 * preferred port a silent holder is a genuine ambiguity, because the caller was
 * about to start there. Here it is evidence about a neighbour, and refusing on
 * it would block every seed that runs near an unrelated service.
 */
async function findAdjacentClusterServing(
  dataDir: string,
  preferredPort: number,
  window: number,
  now: () => number = () => Date.now(),
): Promise<number | null> {
  const deadline = now() + SCAN_TOTAL_TIMEOUT_MS;
  for (let port = preferredPort + 1; port <= preferredPort + window; port += 1) {
    if (now() >= deadline) return null;
    if (!(await isPortInUse(port))) continue;
    const serves = await withDeadline(servesDataDirectory(port, dataDir), SCAN_PORT_TIMEOUT_MS);
    if (serves === true) return port;
  }
  return null;
}


/**
 * Decide whether to adopt an existing cluster for `dataDir` or start a new one.
 *
 * The CLI previously made this decision with its own copy of the pid check, and
 * that copy kept the two defects the shared adjudicator exists to prevent: a
 * blanket catch that reports an unsignalable live postmaster as dead, and
 * adoption of whatever happens to answer a port without checking whose data
 * directory it serves. Both are routed through the shared module here.
 *
 * Ambiguity is never resolved by starting. A directory that might be owned gets
 * a refusal naming the file to remove, because starting a second postmaster over
 * live data is the failure this whole path guards against.
 */
export async function decideEmbeddedCluster(
  dataDir: string,
  preferredPort: number,
): Promise<EmbeddedClusterDecision> {
  const inspected = inspectPostmasterLock(dataDir);

  if (inspected.status === "indeterminate") {
    const detail = inspected.lock
      ? `${POSTMASTER_LOCK_FILE_NAME} records pid ${inspected.lock.pid}`
      : POSTMASTER_LOCK_FILE_NAME;
    throw new Error(
      `Embedded PostgreSQL at ${dataDir} cannot be adjudicated: ${inspected.reason} (${detail}). `
      + `Refusing to adopt or start a cluster, because neither is safe while ownership is unknown. `
      + `If no PostgreSQL is running for this directory, stop it or remove its ${POSTMASTER_LOCK_FILE_NAME}, then retry.`,
    );
  }

  if (inspected.status === "running") {
    // A recorded port is not proof of identity: an unrelated cluster may hold it.
    // Confirm the server there serves THIS directory before handing it to callers
    // that will create databases and take backups on it.
    const port = inspected.lock.port ?? preferredPort;
    await waitForPostgresReady(adminConnectionString(port), {
      timeoutMs: IDENTIFY_TIMEOUT_MS,
      connectTimeoutSeconds: IDENTIFY_CONNECT_TIMEOUT_SECONDS,
    });
    const actualDataDir = await getPostgresDataDirectory(adminConnectionString(port));
    if (
      typeof actualDataDir !== "string" ||
      canonicalizeDataDirectory(actualDataDir) !== canonicalizeDataDirectory(dataDir)
    ) {
      throw new Error(
        `PostgreSQL on port ${port} serves ${actualDataDir ?? "an unreported data directory"}, not ${dataDir}. `
        + `Refusing to adopt an unrelated cluster. Stop whatever is using port ${port}, then retry.`,
      );
    }
    return { action: "adopt", port };
  }

  // "absent" or "stale": the lock file records no live owner. That is not the
  // same as the directory being free -- a cluster started outside Paperclip, or
  // one whose lock file was deleted, can still be serving it. This is the exact
  // shape of the bug this change set exists to fix, so probe before starting.
  if (await isPortInUse(preferredPort)) {
    let servesThisDirectory: boolean;
    try {
      await waitForPostgresReady(adminConnectionString(preferredPort), {
        timeoutMs: IDENTIFY_TIMEOUT_MS,
        connectTimeoutSeconds: IDENTIFY_CONNECT_TIMEOUT_SECONDS,
      });
      const actualDataDir = await getPostgresDataDirectory(adminConnectionString(preferredPort));
      servesThisDirectory =
        typeof actualDataDir === "string" &&
        canonicalizeDataDirectory(actualDataDir) === canonicalizeDataDirectory(dataDir);
    } catch (error) {
      // Something holds the port and will not identify itself. It may be our own
      // postmaster replaying WAL, so refusing is the only safe answer.
      throw new Error(
        `Port ${preferredPort} is in use, but the server there did not identify itself, so ownership of `
        + `${dataDir} cannot be established. Refusing to start a second postmaster over possibly-live data. `
        + `Stop whatever is using port ${preferredPort}, then retry.`,
        { cause: error },
      );
    }

    if (servesThisDirectory) {
      return { action: "adopt", port: preferredPort };
    }
  }

  // The preferred port is idle, or an unrelated cluster holds it. Neither
  // settles ownership of this directory. Callers allocate with a first-free-port
  // walk, so a cluster started here earlier can be listening a few ports above
  // -- and with the lock file absent or stale, nothing else records where it
  // went. Answering "start" on the preferred port alone is what let the worktree
  // seed path run resetPostgresDatabase against a live database.
  const adjacentPort = await findAdjacentClusterServing(
    dataDir,
    preferredPort,
    EMBEDDED_POSTGRES_PORT_SCAN_WINDOW,
  );
  if (adjacentPort !== null) {
    // The server named this directory itself, which outranks the pid file that
    // failed to record it. Callers that must not share a live cluster refuse on
    // "adopt"; callers that may share one get a working port instead of a second
    // postmaster over the same data.
    return { action: "adopt", port: adjacentPort };
  }

  return { action: "start" };
}
