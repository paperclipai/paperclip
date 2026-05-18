const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string, t?: (key: string, options?: any) => string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return t ? t("common.time.justNow") : "just now";
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return t ? t("common.time.m_ago", { count: m }) : `${m}m ago`;
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return t ? t("common.time.h_ago", { count: h }) : `${h}h ago`;
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return t ? t("common.time.d_ago", { count: d }) : `${d}d ago`;
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return t ? t("common.time.w_ago", { count: w }) : `${w}w ago`;
  }
  const mo = Math.floor(seconds / MONTH);
  return t ? t("common.time.mo_ago", { count: mo }) : `${mo}mo ago`;
}
