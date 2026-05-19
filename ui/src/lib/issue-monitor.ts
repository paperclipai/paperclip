export function formatMonitorOffset(nextCheckAt: Date | string): string {
  const deltaMs = new Date(nextCheckAt).getTime() - Date.now();
  const absMinutes = Math.round(Math.abs(deltaMs) / 60_000);
  if (absMinutes <= 0) return "now";
  if (absMinutes < 60) return deltaMs >= 0 ? `in ${absMinutes}m` : `${absMinutes}m ago`;

  const absHours = Math.round(absMinutes / 60);
  if (absHours < 24) return deltaMs >= 0 ? `in ${absHours}h` : `${absHours}h ago`;

  const absDays = Math.round(absHours / 24);
  return deltaMs >= 0 ? `in ${absDays}d` : `${absDays}d ago`;
}
