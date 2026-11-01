import { displayText } from "../i18n/display-text";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return displayText("just now");
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return displayText("{{v0}}m ago", { v0: m });
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return displayText("{{v0}}h ago", { v0: h });
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return displayText("{{v0}}d ago", { v0: d });
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return displayText("{{v0}}w ago", { v0: w });
  }
  const mo = Math.floor(seconds / MONTH);
  return displayText("{{v0}}mo ago", { v0: mo });
}
