import os from "node:os";
import path from "node:path";

export const LIVE_FEED_LOG_NAME = "live-announcement-feed-lookups.log";
/** Written by fixtures/no-live-announcement-feed.mjs in every process where the guard is installed. */
export const LIVE_FEED_MARKER_NAME = "live-announcement-feed-guard.active";
/**
 * One marker record: an ISO timestamp, the pid, and the names of the dns.lookup and dns.promises.lookup functions
 * in place when it was written, which are the guard's own only once its hooks are installed.
 */
export const LIVE_FEED_MARKER_RECORD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \d+ guardedLookup guardedPromisesLookup$/;

/**
 * The live-feed guard's log path, or null when `value` is not a path this config creates: a file named
 * LIVE_FEED_LOG_NAME directly inside a `paperclip-e2e-home-*` directory directly under the OS temp
 * directory. Neither the config nor the teardown follows any other path from the environment.
 */
export function liveFeedLogPath(value: string | undefined): string | null {
  if (!value) return null;
  const resolved = path.resolve(value);
  const home = path.dirname(resolved);
  if (path.basename(resolved) !== LIVE_FEED_LOG_NAME) return null;
  if (!path.basename(home).startsWith("paperclip-e2e-home-")) return null;
  if (path.dirname(home) !== path.resolve(os.tmpdir())) return null;
  return resolved;
}

/** The guard's activation marker, beside a log path that liveFeedLogPath accepted. */
export function liveFeedMarkerPath(logPath: string): string {
  return path.join(path.dirname(logPath), LIVE_FEED_MARKER_NAME);
}
