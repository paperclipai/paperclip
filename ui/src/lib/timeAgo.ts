const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

// i18n-aware time formatter
// Falls back to Korean if no locale function provided
const DEFAULT_LABELS = {
  justNow: "방금",
  minutesAgo: "{n}분 전",
  hoursAgo: "{n}시간 전",
  daysAgo: "{n}일 전",
  weeksAgo: "{n}주 전",
  monthsAgo: "{n}개월 전",
};

let _labels = DEFAULT_LABELS;

export function setTimeAgoLabels(labels: typeof DEFAULT_LABELS) {
  _labels = labels;
}

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return _labels.justNow;
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return _labels.minutesAgo.replace("{n}", String(m));
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return _labels.hoursAgo.replace("{n}", String(h));
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return _labels.daysAgo.replace("{n}", String(d));
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return _labels.weeksAgo.replace("{n}", String(w));
  }
  const mo = Math.floor(seconds / MONTH);
  return _labels.monthsAgo.replace("{n}", String(mo));
}
