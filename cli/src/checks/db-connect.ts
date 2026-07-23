import fs from "node:fs";
import path from "node:path";
import { createDb, type Db } from "@paperclipai/db";
import type { PaperclipConfig } from "../config/schema.js";
import { resolveRuntimeLikePath } from "../utils/path-resolver.js";

export const EMBEDDED_PG_USER = "paperclip";
export const EMBEDDED_PG_PASSWORD = "paperclip";

export type ResolveDbConnectionOptions = {
  /** Connection timeout in milliseconds (default 1500). */
  connectTimeoutMs?: number;
};

/**
 * Resolve a usable postgres connection string from the current config.
 *
 * - For `postgres` mode, returns the configured connection string.
 * - For `embedded-postgres` mode, builds the canonical `postgres://paperclip:paperclip@127.0.0.1:<port>/paperclip`
 *   connection the server uses when it boots the embedded cluster. If the cluster has not been
 *   initialised yet (no `PG_VERSION` in the data dir), returns null — doctor cannot run DB-touching
 *   checks until the server has been started at least once.
 */
export function resolveDoctorConnectionString(
  config: PaperclipConfig,
  configPath?: string,
): string | null {
  if (config.database.mode === "postgres") {
    const cs = config.database.connectionString?.trim();
    return cs && cs.length > 0 ? cs : null;
  }

  if (config.database.mode === "embedded-postgres") {
    const dataDir = resolveRuntimeLikePath(config.database.embeddedPostgresDataDir, configPath);
    // If the embedded cluster hasn't been initialised, there is nothing to connect to.
    // We deliberately do NOT attempt to start the cluster from doctor — that's the server's job.
    if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
      return null;
    }

    const port = config.database.embeddedPostgresPort;
    return `postgres://${EMBEDDED_PG_USER}:${EMBEDDED_PG_PASSWORD}@127.0.0.1:${port}/paperclip`;
  }

  return null;
}

export type OpenDbOptions = ResolveDbConnectionOptions & {
  /** Inject for tests; defaults to `createDb` from @paperclipai/db. */
  createDb?: (url: string) => Db;
};

/**
 * Open a doctor DB handle. Throws if the connection string cannot be resolved OR the
 * `SELECT 1` probe does not respond within `connectTimeoutMs`. Callers should catch and
 * surface a "skipped" check rather than treating connection failure as a hard failure —
 * doctor is safe to run when the server is down.
 */
export async function openDoctorDb(
  config: PaperclipConfig,
  configPath: string | undefined,
  opts: OpenDbOptions = {},
): Promise<{ db: Db; connectionString: string }> {
  const connectionString = resolveDoctorConnectionString(config, configPath);
  if (!connectionString) {
    throw new Error("No usable database connection (cluster not initialised or no connection string configured)");
  }

  const factory = opts.createDb ?? createDb;
  const db = factory(connectionString);

  const timeoutMs = opts.connectTimeoutMs ?? 1500;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.execute("SELECT 1"),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`doctor DB probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  return { db, connectionString };
}
