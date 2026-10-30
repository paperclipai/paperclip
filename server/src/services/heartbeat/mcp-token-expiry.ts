const MIN_LIFETIME_MS = 4 * 60 * 60 * 1_000;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const TIMEOUT_GRACE_MS = 15 * 60 * 1_000;

export function runScopedMcpTokenExpiresAt(
  config: Record<string, unknown>,
  mintedAtMs = Date.now(),
): Date {
  const timeoutSec = config.timeoutSec;
  const graceSec = config.graceSec;
  const configuredTimeoutMs =
    typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec > 0
      ? timeoutSec * 1_000
      : 0;
  const configuredGraceMs =
    typeof graceSec === "number" && Number.isFinite(graceSec) && graceSec > 0
      ? graceSec * 1_000
      : 0;
  const requestedLifetimeMs = Math.max(
    MIN_LIFETIME_MS,
    configuredTimeoutMs > 0
      ? configuredTimeoutMs + configuredGraceMs + TIMEOUT_GRACE_MS
      : 0,
  );
  if (requestedLifetimeMs > MAX_LIFETIME_MS) {
    throw new Error(
      "Heartbeat MCP credentials need renewal for configured runs longer than 24 hours",
    );
  }
  return new Date(mintedAtMs + requestedLifetimeMs);
}
