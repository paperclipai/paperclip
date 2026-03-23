/** Max drain aligned with typical Docker `stop_grace_period: 30s` minus headroom for close + embedded PG. */
const SHUTDOWN_DRAIN_MAX_MS = 28000;
const SHUTDOWN_DRAIN_DEFAULT_MS = 25000;

export function parseShutdownDrainMsFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return SHUTDOWN_DRAIN_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SHUTDOWN_DRAIN_DEFAULT_MS;
  return Math.min(Math.floor(n), SHUTDOWN_DRAIN_MAX_MS);
}
