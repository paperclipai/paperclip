import { describe, it, expect } from "vitest";
import { buildHabitsUrl, buildHabitCompletionsUrl } from "./useHabits";

describe("buildHabitsUrl", () => {
  it("builds the habits URL with companyId", () => {
    const url = buildHabitsUrl("company-abc");
    expect(url).toBe("/api/habits?companyId=company-abc");
  });

  it("percent-encodes special characters in companyId", () => {
    const url = buildHabitsUrl("co/id?x=1");
    expect(url).toContain(encodeURIComponent("co/id?x=1"));
  });
});

describe("buildHabitCompletionsUrl", () => {
  it("builds the completions URL with all params", () => {
    const url = buildHabitCompletionsUrl("company-abc", "2026-09-01", "2026-09-09");
    expect(url).toBe(
      "/api/habits/completions?companyId=company-abc&from=2026-09-01&to=2026-09-09",
    );
  });

  it("includes both from and to", () => {
    const url = buildHabitCompletionsUrl("c", "2026-06-01", "2026-06-30");
    expect(url).toContain("from=2026-06-01");
    expect(url).toContain("to=2026-06-30");
  });
});
