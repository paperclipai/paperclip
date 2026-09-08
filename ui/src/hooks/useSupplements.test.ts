import { describe, expect, it } from "vitest";
import { buildSkipUrl, buildSupplementsIntakeUrl, buildSupplementsUrl, buildSupplementUrl, buildTakeUrl, buildUndoUrl, formatIntakeDate } from "./useSupplements";

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

describe("buildTakeUrl", () => {
  it("builds the take action URL", () => {
    const url = buildTakeUrl("https://api.example.com", "2026-09-05", "sup-123");
    expect(url).toBe("https://api.example.com/supplements/intake/2026-09-05/sup-123/take");
  });
});

describe("buildSkipUrl", () => {
  it("builds the skip action URL", () => {
    const url = buildSkipUrl("https://api.example.com", "2026-09-05", "sup-123");
    expect(url).toBe("https://api.example.com/supplements/intake/2026-09-05/sup-123/skip");
  });
});

describe("buildUndoUrl", () => {
  it("builds the undo (DELETE) intake URL without an action suffix", () => {
    const url = buildUndoUrl("https://api.example.com", "2026-09-05", "sup-123");
    expect(url).toBe("https://api.example.com/supplements/intake/2026-09-05/sup-123");
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

describe("buildSupplementsUrl", () => {
  it("builds list URL with companyId query param", () => {
    const url = buildSupplementsUrl("https://api.example.com", "company-abc");
    expect(url).toBe("https://api.example.com/supplements?companyId=company-abc");
  });
});

describe("buildSupplementUrl", () => {
  it("builds single supplement URL for PATCH / DELETE", () => {
    const url = buildSupplementUrl("https://api.example.com", "sup-456");
    expect(url).toBe("https://api.example.com/supplements/sup-456");
  });
});
