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

  it("reads each task's sort keys once, even for hundreds of held-up tasks", () => {
    const size = 600;
    let reads = 0;
    // Counts reads of the sort keys and fails at once if sorting re-reads them per comparison.
    const counted = (n: number) => {
      const entry = { id: `task-${n}`, title: `Task ${n}`, status: n % 10 === 0 ? "done" : "todo" } as IssueRelationIssueSummary;
      const count = <T,>(value: T) => () => { reads += 1; if (reads > 2 * size) throw new Error(`sort keys read ${reads} times for ${size} tasks`); return value; };
      Object.defineProperty(entry, "priority", { get: count(["critical", "high", "medium", "low"][n % 4]) });
      Object.defineProperty(entry, "identifier", { get: count(`PAP-${size - n}`) });
      return entry;
    };
    const listed = openHeldUpTasks(Array.from({ length: size }, (_, n) => counted(n)));
    expect(listed).toHaveLength(size - size / 10);
    expect(reads).toBeLessThanOrEqual(2 * size);
    reads = 0;
    expect(listed.slice(0, 2).map((entry) => entry.identifier)).toEqual(["PAP-4", "PAP-8"]);
  });
});
