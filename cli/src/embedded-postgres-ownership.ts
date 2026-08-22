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
  if (!(await isPortInUse(preferredPort))) {
    return { action: "start" };
  }

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

  // Identified as a different cluster: our directory is unowned, so the caller
  // may start on another port.
  return { action: "start" };
}
