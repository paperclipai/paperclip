import { describe, expect, it } from "vitest";
import type { IssueRelationIssueSummary } from "@paperclipai/shared";
import { sortHeldUpTasks } from "./UnblockAskNotice";

describe("sortHeldUpTasks", () => {
  it("lists held-up tasks in the card's order: highest priority, then the oldest task", () => {
    const task = (identifier: string, priority: string) => ({ id: identifier, identifier, title: identifier, status: "todo", priority }) as IssueRelationIssueSummary;
    const sorted = sortHeldUpTasks([task("PAP-15", "medium"), task("PAP-7", "high"), task("PAP-16", "high"), task("PAP-10", "critical"), task("PAP-9", "low")]);
    expect(sorted.map((entry) => entry.identifier)).toEqual(["PAP-10", "PAP-7", "PAP-16", "PAP-15", "PAP-9"]);
  });
});
