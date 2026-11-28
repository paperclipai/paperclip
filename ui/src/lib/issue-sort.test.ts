import { describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { sortIssues } from "./issue-sort";

const issue = (id: string, updatedAt: string) => ({ id, updatedAt: new Date(updatedAt) }) as Issue;

describe("sortIssues", () => {
  it("sorts by an updated time from the context and reads it once per task", () => {
    const issues = [issue("a", "2026-11-01"), issue("b", "2026-11-02"), issue("c", "2026-11-03"), issue("d", "2026-11-04")];
    const shown: Record<string, string> = { a: "2026-11-10", b: "2026-11-02", c: "2026-11-03", d: "2026-11-04" };
    const context = vi.fn((task: Issue) => ({ updated: shown[task.id] }));
    expect(sortIssues(issues, { sortField: "updated", sortDir: "desc" }, context).map(task => task.id)).toEqual(["a", "d", "c", "b"]);
    expect(context).toHaveBeenCalledTimes(issues.length);
  });

  it("falls back to the stored updatedAt without a context time", () => {
    const issues = [issue("old", "2026-11-01"), issue("new", "2026-11-05")];
    expect(sortIssues(issues, { sortField: "updated", sortDir: "desc" }).map(task => task.id)).toEqual(["new", "old"]);
  });
});
