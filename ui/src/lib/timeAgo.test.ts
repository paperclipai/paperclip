import { describe, expect, it } from "vitest";
import { timeAgo } from "./timeAgo.js";

function secondsAgo(s: number): Date {
  return new Date(Date.now() - s * 1000);
}

describe("timeAgo", () => {
  it("returns 'just now' for very recent dates (< 1 minute)", () => {
    expect(timeAgo(secondsAgo(10))).toBe("just now");
  });

  it("returns minutes for dates 1-59 minutes ago", () => {
    expect(timeAgo(secondsAgo(60))).toBe("1m ago");
    expect(timeAgo(secondsAgo(90))).toBe("1m ago");
    expect(timeAgo(secondsAgo(120))).toBe("2m ago");
    expect(timeAgo(secondsAgo(59 * 60))).toBe("59m ago");
  });

  it("returns hours for dates 1-23 hours ago", () => {
    expect(timeAgo(secondsAgo(3600))).toBe("1h ago");
    expect(timeAgo(secondsAgo(7200))).toBe("2h ago");
    expect(timeAgo(secondsAgo(23 * 3600))).toBe("23h ago");
  });

  it("returns days for dates 1-6 days ago", () => {
    expect(timeAgo(secondsAgo(86400))).toBe("1d ago");
    expect(timeAgo(secondsAgo(6 * 86400))).toBe("6d ago");
  });

  it("returns weeks for dates 1-4 weeks ago", () => {
    expect(timeAgo(secondsAgo(7 * 86400))).toBe("1w ago");
    expect(timeAgo(secondsAgo(14 * 86400))).toBe("2w ago");
  });

  it("returns months for dates >= 30 days ago", () => {
    expect(timeAgo(secondsAgo(30 * 86400))).toBe("1mo ago");
    expect(timeAgo(secondsAgo(60 * 86400))).toBe("2mo ago");
  });

  it("accepts a date string", () => {
    const result = timeAgo(new Date(Date.now() - 5000).toISOString());
    expect(result).toBe("just now");
  });
});
