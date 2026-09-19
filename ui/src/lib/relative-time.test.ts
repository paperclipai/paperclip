import { describe, expect, it } from "vitest";
import { formatRelativeTimestamp, RELATIVE_TIMESTAMP_MAX_AGE_MS } from "./relative-time";

const NOW = new Date("2026-09-13T12:00:00.000Z").getTime();
/** Pin the phrasing under test; production still follows the reader's locale. */
const EN = "en-US";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `now - age`, so each case reads as "a message this old".
 *
 * The locale is pinned: these cases assert English phrasing and US date order,
 * which the formatter only produces when the runtime's default locale happens
 * to be English. Under any other locale it would still be correct and these
 * would still fail.
 */
function ago(age: number): string | undefined {
  return formatRelativeTimestamp(new Date(NOW - age), NOW, EN);
}

describe("formatRelativeTimestamp", () => {
  it("reads the live tail as elapsed time", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(5 * MINUTE)).toBe("5 minutes ago");
    expect(ago(3 * HOUR)).toBe("3 hours ago");
  });

  it("uses the locale's idiomatic phrasing where it has one", () => {
    expect(ago(DAY)).toBe("yesterday");
  });

  describe("ladder boundaries", () => {
    it("holds 'just now' up to 45 seconds", () => {
      expect(ago(44 * SECOND)).toBe("just now");
      expect(ago(45 * SECOND)).toBe("1 minute ago");
    });

    it("switches to hours at 60 minutes", () => {
      expect(ago(59 * MINUTE)).toBe("59 minutes ago");
      expect(ago(HOUR)).toBe("1 hour ago");
    });

    it("switches to days at 24 hours", () => {
      expect(ago(23 * HOUR)).toBe("23 hours ago");
      expect(ago(DAY)).toBe("yesterday");
    });

    it("switches to an absolute date at 7 days", () => {
      expect(ago(6 * DAY)).toBe("6 days ago");
      expect(ago(RELATIVE_TIMESTAMP_MAX_AGE_MS)).toBe("Sep 6");
    });

    it("rounds down so a label never claims more time than has passed", () => {
      expect(ago(HOUR + 59 * MINUTE)).toBe("1 hour ago");
      expect(ago(6 * DAY + 23 * HOUR)).toBe("6 days ago");
    });
  });

  describe("absolute dates", () => {
    it("omits the year within the current year", () => {
      expect(formatRelativeTimestamp("2026-09-05T12:48:00.000Z", NOW, EN)).toBe("Sep 5");
    });

    // The bug that prompted this: "Sep 5" alone is ambiguous across years, and
    // the old formatter printed "12:48 PM" with no date at all.
    it("qualifies dates from another year", () => {
      expect(formatRelativeTimestamp("2025-09-05T12:48:00.000Z", NOW, EN)).toBe("Sep 5, 2025");
    });
  });

  describe("inputs", () => {
    it("accepts Date, ISO string, and epoch milliseconds alike", () => {
      const at = NOW - 2 * HOUR;
      expect(formatRelativeTimestamp(new Date(at), NOW, EN)).toBe("2 hours ago");
      expect(formatRelativeTimestamp(new Date(at).toISOString(), NOW, EN)).toBe("2 hours ago");
      expect(formatRelativeTimestamp(at, NOW, EN)).toBe("2 hours ago");
    });

    it("returns undefined for an unparseable value rather than 'Invalid Date'", () => {
      expect(formatRelativeTimestamp("not a date", NOW)).toBeUndefined();
      expect(formatRelativeTimestamp(Number.NaN, NOW)).toBeUndefined();
    });

    // Server/browser clock skew, not a scheduled message.
    it("reads a future timestamp as the present", () => {
      expect(formatRelativeTimestamp(NOW + 30 * SECOND, NOW, EN)).toBe("just now");
    });

    it("defaults to the current clock", () => {
      expect(formatRelativeTimestamp(new Date())).toBe("just now");
    });
  });
});
