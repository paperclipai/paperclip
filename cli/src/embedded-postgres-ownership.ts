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

export type EmbeddedClusterDecision =
  /** A cluster of ours already serves this directory on `port`; reuse it. */
  | { action: "adopt"; port: number }
  /** Nothing owns the directory; the caller may start one. */
  | { action: "start" };

function adminConnectionString(port: number): string {
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
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
    await waitForPostgresReady(adminConnectionString(port), { timeoutMs: IDENTIFY_TIMEOUT_MS });
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

  // "absent" or "stale": the lock file records no live owner. PostgreSQL clears a
  // stale file itself as it takes ownership, so leave it alone and start.
  return { action: "start" };
}
