/**
 * One relative-time label for chat surfaces, built on `Intl.RelativeTimeFormat`.
 *
 * Recent messages read as elapsed time ("5 minutes ago"), because that is what
 * you want to know about the live tail. Past a week the ladder switches to an
 * absolute date: "9 months ago" is a worse way to locate a message than
 * "Sep 5", and it never answers "what day was that?". The 7-day cutoff matches
 * the hand-rolled ladders already in `IssueChatThread` and `AgentBubbleActionRow`
 * so a later consolidation is a merge rather than a reconciliation.
 */
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Past this age the label is a fixed date, so it never needs refreshing again.
 * Callers that re-render to keep labels current can stop once every message on
 * screen is older than this.
 */
export const RELATIVE_TIMESTAMP_MAX_AGE_MS = WEEK;

/**
 * Formatter construction is the expensive part, so each locale's set is built
 * once. In the app that is a single entry, for the reader's own locale; the
 * cache exists so a test can pin one without rebuilding on every call.
 */
const formattersByLocale = new Map<
  string,
  {
    relative: Intl.RelativeTimeFormat;
    sameYearDate: Intl.DateTimeFormat;
    otherYearDate: Intl.DateTimeFormat;
  }
>();

function formattersFor(locale: string | undefined) {
  const key = locale ?? "";
  let built = formattersByLocale.get(key);
  if (!built) {
    built = {
      relative: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
      sameYearDate: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
      otherYearDate: new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    };
    formattersByLocale.set(key, built);
  }
  return built;
}

/**
 * "just now" · "5 minutes ago" · "3 hours ago" · "yesterday" · "Sep 5".
 *
 * `now` is injectable so the ladder's boundaries are testable against a fixed
 * clock. `locale` is injectable for the same reason: left alone it follows the
 * reader's own locale, which is what the app wants and exactly what a test
 * asserting English phrasing cannot depend on.
 */
export function formatRelativeTimestamp(
  value: Date | string | number,
  now: number = Date.now(),
  locale?: string,
): string | undefined {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return undefined;
  const { relative, sameYearDate, otherYearDate } = formattersFor(locale);

  // A negative age means clock skew between the server and this browser, not a
  // scheduled message. Read it as the present rather than "in 3 seconds".
  const age = now - time;
  if (age < 45 * SECOND) return "just now";
  if (age < HOUR) return relative.format(-Math.max(1, Math.floor(age / MINUTE)), "minute");
  if (age < DAY) return relative.format(-Math.floor(age / HOUR), "hour");
  if (age < WEEK) return relative.format(-Math.floor(age / DAY), "day");

  const formatter =
    date.getFullYear() === new Date(now).getFullYear() ? sameYearDate : otherYearDate;
  return formatter.format(date);
}
