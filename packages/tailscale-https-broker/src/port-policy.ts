/**
 * Default dedicated port allowlist for the broker. Kept numerically in sync
 * with `@paperclipai/shared` `runtime-exposure/ports` so the broker and the
 * runtime allocator agree, but inlined here so the broker stays deployable as a
 * standalone host service without a workspace dependency graph.
 */
export const DEFAULT_APP_PORT_MIN = 42000;
export const DEFAULT_APP_PORT_MAX = 42999;
export const DEFAULT_HMR_PORT_OFFSET = 10000;
export const DEFAULT_HMR_PORT_MIN = DEFAULT_APP_PORT_MIN + DEFAULT_HMR_PORT_OFFSET;
export const DEFAULT_HMR_PORT_MAX = DEFAULT_APP_PORT_MAX + DEFAULT_HMR_PORT_OFFSET;

export function defaultIsAllowedPort(port: number): boolean {
  if (!Number.isInteger(port)) return false;
  const inApp = port >= DEFAULT_APP_PORT_MIN && port <= DEFAULT_APP_PORT_MAX;
  const inHmr = port >= DEFAULT_HMR_PORT_MIN && port <= DEFAULT_HMR_PORT_MAX;
  return inApp || inHmr;
}

/**
 * Parse `BROKER_PROTECTED_PORTS` (comma/space separated) into a sorted, deduped
 * set of operator-protected ports (PAP-17285).
 *
 * Fails closed: a malformed list throws so the broker refuses to start rather
 * than silently protecting nothing. Protecting a port the broker cannot mutate
 * anyway is harmless, so no range restriction is applied — but `443` is rejected
 * because the primary route has its own stronger, non-optional invariant and
 * listing it here would imply it were opt-in.
 */
export function parseProtectedPorts(raw: string | undefined): number[] {
  if (raw === undefined) return [];
  const tokens = raw.split(/[,\s]+/).filter((token) => token.length > 0);
  const ports = new Set<number>();
  for (const token of tokens) {
    if (!/^[0-9]{1,5}$/.test(token)) {
      throw new Error(`BROKER_PROTECTED_PORTS contains a non-numeric entry: ${JSON.stringify(token)}`);
    }
    const port = Number(token);
    if (port < 1 || port > 65535) {
      throw new Error(`BROKER_PROTECTED_PORTS contains an out-of-range port: ${token}`);
    }
    if (port === 443) {
      throw new Error("BROKER_PROTECTED_PORTS must not list 443; the primary route is always protected");
    }
    ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}
