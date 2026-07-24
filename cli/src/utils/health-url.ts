export function buildLocalHealthUrl(host: string | undefined, port: number): string {
  const configuredHost = host?.trim();
  const reachableHost = !configuredHost || configuredHost === "0.0.0.0" || configuredHost === "::"
    ? "127.0.0.1"
    : configuredHost;
  const urlHost = reachableHost.includes(":") && !reachableHost.startsWith("[")
    ? `[${reachableHost}]`
    : reachableHost;
  return `http://${urlHost}:${port}/api/health`;
}
