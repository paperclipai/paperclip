export function buildEmbeddedPostgresFlags(): string[] {
  return ["-c", "listen_addresses=127.0.0.1"];
}
