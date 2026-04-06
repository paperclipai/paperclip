export function moneySmart(v: unknown, prefix = "$"): string {
  if (v === undefined || v === null || v === "") return `${prefix}0.00`;
  const n = Number(v);
  if (!Number.isFinite(n)) return `${prefix}0.00`;
  const a = Math.abs(n);
  if (a < 1e3) return `${prefix}${n.toFixed(1)}`;
  if (a >= 1e9) return `${prefix}${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${prefix}${(n / 1e6).toFixed(2)}M`;
  return `${prefix}${(n / 1e3).toFixed(1)}K`;
}

export function growthBadge(v: unknown): string {
  const n = Number(v) || 0;
  if (n > 0) return `🟢▲ +${n.toFixed(1)}%`;
  if (n < 0) return `🔻 ${n.toFixed(1)}%`;
  return "";
}

export function acqBadge(v: unknown): string {
  const n = Number(v) || 0;
  if (n > 0) return `🟢${n.toFixed(1)}%`;
  if (n < 0) return `🔻${n.toFixed(1)}%`;
  return "0.0%";
}
