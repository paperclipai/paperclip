import { describe, expect, it } from "vitest";
import { fitReports } from "./AgentDirectReports";
import { revisionSummary } from "./AgentHistoryDialog";
import { checkExternalProfile } from "./InstructionsBundleSettings";
import { countSince, formatWindowCount } from "./overview-counts";

describe("revisionSummary", () => {
  it("names the changed parts of the configuration in plain words", () => {
    expect(revisionSummary({ changedKeys: ["adapterConfig"], rolledBackFromRevisionId: null })).toBe("Changed harness settings");
    expect(revisionSummary({ changedKeys: ["name", "title"], rolledBackFromRevisionId: null })).toBe("Changed name and title");
    expect(revisionSummary({ changedKeys: ["name", "runtimeConfig", "budgetMonthlyCents"], rolledBackFromRevisionId: null })).toBe(
      "Changed name, runtime settings and budget",
    );
  });

  it("calls out restores and empty revisions", () => {
    expect(revisionSummary({ changedKeys: ["adapterConfig"], rolledBackFromRevisionId: "rev-1" })).toBe("Restored an earlier version");
    expect(revisionSummary({ changedKeys: [], rolledBackFromRevisionId: null })).toBe("Saved with no tracked changes");
  });
});

describe("checkExternalProfile", () => {
  it("accepts an absolute or home root and any entry file inside it", () => {
    expect(checkExternalProfile("/Users/avery/prompts/atlas", "AGENTS.md")).toBeNull();
    expect(checkExternalProfile("~/prompts/atlas", "AGENTS")).toBeNull();
    expect(checkExternalProfile("/Users/avery/prompts", "docs/instructions.txt")).toBeNull();
    expect(checkExternalProfile("/Users/avery/prompts", "notes..md")).toBeNull();
  });

  it("points at the field that needs fixing", () => {
    expect(checkExternalProfile("prompts/atlas", "AGENTS.md")).toMatchObject({ field: "root" });
    expect(checkExternalProfile("/Users/avery/prompts", "../AGENTS.md")).toMatchObject({ field: "entry" });
    expect(checkExternalProfile("/Users/avery/prompts", "docs/../../AGENTS.md")).toMatchObject({ field: "entry" });
    expect(checkExternalProfile("/Users/avery/prompts", "/etc/AGENTS.md")).toMatchObject({ field: "entry" });
  });
});

describe("countSince", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-10-30T12:00:00Z");
  const rows = (ages: number[]) => ages.map((age, index) => ({ id: index, createdAt: new Date(now - age * day).toISOString() }));

  it("counts rows inside the window and reports an exact total when the list reaches past it", () => {
    const counted = countSince(rows([0.5, 1, 3, 9]), now - 7 * day, 4);
    expect(counted).toEqual({ count: 3, atLeast: false });
    expect(formatWindowCount(counted)).toBe("3");
  });

  it("marks the total as a lower bound when a capped list ends inside the window", () => {
    const counted = countSince(rows([0.5, 1, 2, 3]), now - 7 * day, 4);
    expect(counted).toEqual({ count: 4, atLeast: true });
    expect(formatWindowCount(counted)).toBe("4+");
  });

  it("applies the row filter", () => {
    const failed = rows([0.5, 1, 3]).map((row, index) => ({ ...row, status: index === 1 ? "failed" : "succeeded" }));
    expect(countSince(failed, now - 2 * day, 200, (row) => row.status === "failed")).toEqual({ count: 1, atLeast: false });
  });
});

describe("fitReports", () => {
  const widths = [106, 106, 56, 60, 106, 129, 116, 140];

  it("shows every report when they fit in two lines", () => {
    expect(fitReports(widths.slice(0, 4), 406, 16, 56)).toBe(4);
    expect(fitReports(widths, 900, 16, 56)).toBe(8);
  });

  it("leaves room for the more button on the second line", () => {
    expect(fitReports(widths, 406, 16, 56)).toBe(6);
    expect(fitReports(widths, 202, 16, 56)).toBe(2);
  });

  it("shows every report before the width is known", () => {
    expect(fitReports(widths, 0, 16, 56)).toBe(8);
  });
});
