const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;

export function timeAgo(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.round((now - then) / 1000);

  if (seconds < MINUTE) return translateUiLiteral("just now");
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE);
    return translateUiLiteral("{{value1}}m ago".replace("{{value1}}", String(m)));
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR);
    return translateUiLiteral("{{value1}}h ago".replace("{{value1}}", String(h)));
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY);
    return translateUiLiteral("{{value1}}d ago".replace("{{value1}}", String(d)));
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK);
    return translateUiLiteral("{{value1}}w ago".replace("{{value1}}", String(w)));
  }
  const mo = Math.floor(seconds / MONTH);
  return translateUiLiteral("{{value1}}mo ago".replace("{{value1}}", String(mo)));
}
import { translateUiLiteral } from "@/i18n/LegacyLiteralLocalizer";
