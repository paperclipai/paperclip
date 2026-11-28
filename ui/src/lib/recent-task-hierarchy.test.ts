import { describe, expect, it } from "vitest";
import { recentTaskHierarchy } from "./recent-task-hierarchy";
import type { RecentTaskEntry } from "./recent-tasks";

const task = (id: string, parentId: string | null = null, subtaskCount = 0): RecentTaskEntry => ({
  id, parentId, subtaskCount, companyId: "company", title: id, identifier: id, status: "todo", recordedAt: 0,
});
describe("recent task hierarchy", () => {
  it("nests only beneath readable recent roots, retaining orphans and cycles", () => {
    const entries = [task("root", null, 2), task("child", "root", 1), task("grandchild", "child"),
      task("orphan", "absent"), task("cycle-a", "cycle-b", 1), task("cycle-b", "cycle-a", 1)];
    const hierarchy = recentTaskHierarchy(entries, "/PAP/issues/child");
    expect([...hierarchy.nestedIds]).toEqual(["child"]);
    expect(hierarchy.selectedChild?.id).toBe("child");
    expect(hierarchy.flattenedIds).toEqual(new Set(["cycle-a", "cycle-b"]));
  });
  it("deduplicates children of every displayed root in a four-level chain regardless of recent order", () => {
    const entries = [task("d", "c"), task("b", "a", 1), task("c", "b", 1), task("a", null, 1)];
    expect(recentTaskHierarchy(entries, "/PAP/issues/d").nestedIds).toEqual(new Set(["b", "d"]));
  });
  it("indexes a large history without rescanning it for each child", () => {
    let reads = 0;
    const entries = Array.from({ length: 10_000 }, (_, index) => ({ ...task(`task-${index}`, null, 1),
      get parentId() {
        if (++reads > 120_000) throw new Error("Repeated parent scans");
        return index % 2 ? `task-${index - 1}` : null;
      },
    }));
    expect(recentTaskHierarchy(entries, "/PAP/issues/task-9999").nestedIds.size).toBe(5_000);
    expect(reads).toBeLessThan(120_000);
  });
});
