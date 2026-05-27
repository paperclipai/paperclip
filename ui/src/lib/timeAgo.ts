import { isKoreanLocale } from "@/i18n/locale-utils";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string, locale?: string | null): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);
  const korean = isKoreanLocale(locale);

  if (seconds < MINUTE) return korean ? "방금 전" : "just now";
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return korean ? `${m}분 전` : `${m}m ago`;
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return korean ? `${h}시간 전` : `${h}h ago`;
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return korean ? `${d}일 전` : `${d}d ago`;
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return korean ? `${w}주 전` : `${w}w ago`;
  }
  const mo = Math.floor(seconds / MONTH);
  return korean ? `${mo}개월 전` : `${mo}mo ago`;
}
