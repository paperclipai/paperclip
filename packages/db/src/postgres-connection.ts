import postgres from "postgres";

export function connectPostgres(connectionString: string, options: Record<string, unknown> = {}) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return postgres(connectionString, options);
  }
  const host = url.searchParams.get("host");
  if (!host) return postgres(connectionString, options);
  url.searchParams.delete("host");
  return postgres(url.toString(), { host, ...options });
}
