import { describe, expect, it } from "vitest";
import { buildIssueTree } from "./issue-tree";
import { sortTaskListItems, type TaskListSort } from "./task-list";
import type { Issue } from "@paperclipai/shared";

describe("task-list sorting", () => {
  it("sorts identifiers naturally and names case-insensitively without mutating the input", () => {
    const items = ["PAP-10", "pap-2", "PAP-1"];
    expect(sortTaskListItems(items, { column: "taskId", direction: "ascending" }, item => item)).toEqual(["PAP-1", "pap-2", "PAP-10"]);
    expect(items).toEqual(["PAP-10", "pap-2", "PAP-1"]);
    expect(sortTaskListItems(["beta", "ALPHA", "alpha"], { column: "task", direction: "descending" }, item => item)).toEqual(["beta", "ALPHA", "alpha"]);
  });

  it.each<TaskListSort["direction"]>(["ascending", "descending"])("puts missing values last for %s and retains ties", direction => {
    const items = [{ id: "missing", value: null }, { id: "second", value: 2 }, { id: "empty", value: "" }, { id: "first", value: 1 }, { id: "tie", value: 2 }, { id: "invalid", value: NaN }];
    const sorted = sortTaskListItems(items, { column: "lastUpdated", direction }, item => item.value);
    expect(sorted.map(item => item.id)).toEqual(direction === "ascending"
      ? ["first", "second", "tie", "missing", "empty", "invalid"]
      : ["second", "tie", "first", "missing", "empty", "invalid"]);
  });

  it("orders raw timestamps numerically rather than sorting relative date labels", () => {
    const dates = [Date.parse("2026-10-14T17:00:00Z"), Date.parse("2026-10-13T17:00:00Z"), Date.parse("2026-10-14T18:00:00Z")];
    expect(sortTaskListItems(dates, { column: "lastUpdated", direction: "descending" }, date => date)).toEqual([dates[2], dates[0], dates[1]]);
  });

  it("preserves parent groups and sorts every sibling level through the existing tree builder", () => {
    const items = [
      { id: "parent", parentId: null, issueNumber: 2 },
      { id: "child-a", parentId: "parent", issueNumber: 3 },
      { id: "grandchild", parentId: "child-a", issueNumber: 6 },
      { id: "child-b", parentId: "parent", issueNumber: 4 },
      { id: "root", parentId: null, issueNumber: 5 },
    ] as Issue[];
    const { roots, childMap } = buildIssueTree(sortTaskListItems(items, { column: "taskId", direction: "descending" }, item => item.issueNumber));
    expect(roots.map(item => item.id)).toEqual(["root", "parent"]);
    expect(childMap.get("parent")?.map(item => item.id)).toEqual(["child-b", "child-a"]);
    expect(childMap.get("child-a")?.map(item => item.id)).toEqual(["grandchild"]);
  });
});
