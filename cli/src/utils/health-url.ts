// A healthy instance does not always answer /api/health promptly. Measured on
// macOS/arm64, a server that curl confirmed healthy seconds later answered in
// 2.5s-3.1s while still warming up, because migrations, background sweeps and
// plugin loading all contend during the first minutes after a start. At a 2s
// budget the probe reported such a server as down, so `service status` printed
// `ok: false` for a service that was in fact serving requests.
export const HEALTH_PROBE_TIMEOUT_MS = 10_000;

// First boot after a payload upgrade applies database migrations before the
// server binds, and that is unbounded in the instance's size rather than in
// anything the CLI controls. A 148MB instance upgrading across roughly 200
// commits took ~250s to answer, and a plain supervised restart of the same
// instance took ~100s. At 60s `service restart` reported "did not become
// healthy" for restarts that then succeeded on their own.
export const HEALTH_READY_TIMEOUT_MS = 300_000;

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
