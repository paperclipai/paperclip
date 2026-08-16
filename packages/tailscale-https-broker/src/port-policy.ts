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
