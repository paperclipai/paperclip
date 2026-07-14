/**
 * Resolve a millisecond timeout override from an environment variable.
 *
 * Returns `defaultMs` when the variable is unset, blank, non-numeric, or
 * non-positive; fractional values are truncated. All deployer-facing timeout
 * knobs share this parser so every knob validates its override identically.
 */
export function resolveEnvTimeoutMs(
  name: string,
  defaultMs: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[name];
  if (raw != null && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  return defaultMs;
}
