import { describe, expect, it } from "vitest";
import { buildSupplementsIntakeUrl, formatIntakeDate } from "./useSupplements";

// Tests for URL construction — no React/DOM required.
// Regression guard: the hook must call /supplements/intake/:date,
// NOT /supplements/today, which returns 404 on the live backend.

describe("useSupplements URL construction", () => {
  it("builds URL with /supplements/intake/:date path", () => {
    const url = buildSupplementsIntakeUrl("https://api.example.com", "2026-09-04");
    expect(url).toBe("https://api.example.com/supplements/intake/2026-09-04");
  });

  it("does not use the /supplements/today path", () => {
    const url = buildSupplementsIntakeUrl("https://api.example.com", "2026-09-04");
    expect(url).not.toContain("/supplements/today");
  });
});

describe("formatIntakeDate", () => {
  it("formats a Date as YYYY-MM-DD", () => {
    expect(formatIntakeDate(new Date("2026-09-04T13:45:00.000Z"))).toBe("2026-09-04");
  });

  it("zero-pads single-digit months and days", () => {
    expect(formatIntakeDate(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01-05");
  });
});
