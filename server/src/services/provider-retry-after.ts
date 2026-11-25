export function providerRetryAt(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  const deadline = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(deadline) && deadline > now ? Math.min(deadline, now + 24 * 3600_000) : undefined;
}
