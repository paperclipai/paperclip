import { getRuntimeLocaleConfig } from "./runtime-locale";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const locale = getRuntimeLocaleConfig().locale;
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return locale === "zh-CN" ? "刚刚" : "just now";
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return locale === "zh-CN" ? `${m}分钟前` : `${m}m ago`;
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return locale === "zh-CN" ? `${h}小时前` : `${h}h ago`;
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return locale === "zh-CN" ? `${d}天前` : `${d}d ago`;
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return locale === "zh-CN" ? `${w}周前` : `${w}w ago`;
  }
  const mo = Math.floor(seconds / MONTH);
  return locale === "zh-CN" ? `${mo}个月前` : `${mo}mo ago`;
}
