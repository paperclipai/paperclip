import { readConfig } from "./store.js";

/**
 * Resolve the Postgres connection string for CLI commands that talk to the
 * database directly (auth bootstrap-ceo, auth seed-instance-admin).
 *
 * Precedence: explicit --db-url flag, then DATABASE_URL, then the config
 * file's postgres connection string, then the embedded-postgres default.
 */
export function resolveDbUrl(configPath?: string, explicitDbUrl?: string): string | null {
  if (explicitDbUrl) return explicitDbUrl;
  const config = readConfig(configPath);
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (config?.database.mode === "postgres" && config.database.connectionString) {
    return config.database.connectionString;
  }
  if (config?.database.mode === "embedded-postgres") {
    const port = config.database.embeddedPostgresPort ?? 54329;
    return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  }
  return null;
}
