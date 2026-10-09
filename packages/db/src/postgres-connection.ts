import postgres from "postgres";

/**
 * Translate libpq's URI host parameter to postgres.js's driver option.
 * postgres.js otherwise sends `host` as a server setting and connects over TCP,
 * which cannot use the local peer-authentication contract.
 */
export function connectPostgres(connectionString: string, options: Record<string, unknown> = {}) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Keep postgres.js support for empty URLs and multi-host connection strings.
    return postgres(connectionString, options);
  }
  const host = url.searchParams.get("host");
  if (!host) return postgres(connectionString, options);
  url.searchParams.delete("host");
  return postgres(url.toString(), { host, ...options });
}
