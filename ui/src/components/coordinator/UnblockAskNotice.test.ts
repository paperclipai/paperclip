import { describe, expect, it } from "vitest";
import type { IssueLockedStub, IssueRelationIssueSummary } from "@paperclipai/shared";
import { openHeldUpTasks } from "./UnblockAskNotice";

describe("openHeldUpTasks", () => {
  const task = (identifier: string, priority: string, status = "todo") =>
    ({ id: identifier, identifier, title: identifier, status, priority }) as IssueRelationIssueSummary;

  it("lists held-up tasks in the card's order: highest priority, then the oldest task", () => {
    const sorted = openHeldUpTasks([task("PAP-15", "medium"), task("PAP-7", "high"), task("PAP-16", "high"), task("PAP-10", "critical"), task("PAP-9", "low")]);
    expect(sorted.map((entry) => entry.identifier)).toEqual(["PAP-10", "PAP-7", "PAP-16", "PAP-15", "PAP-9"]);
  });

  it("leaves out finished tasks and private tasks the viewer cannot read", () => {
    const locked = { id: "secret", identifier: "PAP-20", locked: true } as IssueLockedStub;
    const listed = openHeldUpTasks([task("PAP-1", "medium"), task("PAP-2", "high", "done"), task("PAP-3", "low", "cancelled"), locked]);
    expect(listed.map((entry) => entry.identifier)).toEqual(["PAP-1"]);
  });
});
