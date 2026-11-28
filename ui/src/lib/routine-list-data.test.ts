import type { FolderListResult, RoutineListItem } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { selectRoutineRows } from "./routine-list-data";
import { defaultRoutineView } from "./routine-list-view";

describe("routine rows shared by current and Classic pages", () => {
  it.each(["all", "folder-17", "unfiled"])("bounds filtering, sorting, and folder counts for %s", (selection) => {
    const folderCount = 120;
    const routineCount = folderCount * 10;
    let rowReads = 0;
    let selectionReads = 0;
    const selectedIds = (prefix: string) => new Proxy(
      Array.from({ length: folderCount }, (_, index) => `${prefix}-${index}`),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            if (++selectionReads > folderCount * 6) {
              throw new Error("Routine filtering repeatedly scans selected IDs");
            }
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const date = new Date("2026-04-01T00:00:00Z");
    const folders: FolderListResult = {
      kind: "routine", allCount: routineCount, unfiledCount: folderCount,
      folders: Array.from({ length: folderCount }, (_, index) => ({
        id: `folder-${index}`, companyId: "company-1", kind: "routine",
        name: `Folder ${index}`, slug: `folder-${index}`, path: `folder-${index}`,
        parentId: null, systemKey: null, depth: 0, color: null, position: index,
        createdAt: date, updatedAt: date, itemCount: 9,
      })),
    };
    const routines = Array.from({ length: routineCount }, (_, index) => {
      const folder = Math.floor(index / 10);
      const slot = index % 10;
      const row: RoutineListItem = {
        id: `routine-${index}`, companyId: "company-1", folderId: slot === 9 ? null : `folder-${folder}`,
        title: `${slot === 1 ? "Maintenance" : "Weekly digest"} ${String(index).padStart(4, "0")}`,
        description: "Operations", projectId: slot === 2 ? "excluded" : `project-${folder}`,
        assigneeAgentId: slot === 3 ? "excluded" : `agent-${folder}`,
        responsibleUserId: slot === 4 ? "excluded" : `user-${folder}`,
        originKind: slot === 5 ? "built_in_agent_bundle" : "manual",
        status: slot === 6 ? "paused" : slot === 7 ? "archived" : "active",
        goalId: null, parentIssueId: null, priority: "medium",
        concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed",
        activityGatePolicy: "always", activityGateScope: "company", variables: [],
        latestRevisionId: null, latestRevisionNumber: 1,
        createdByAgentId: null, createdByUserId: null, updatedByAgentId: null, updatedByUserId: null,
        lastTriggeredAt: null, lastEnqueuedAt: null, createdAt: date, updatedAt: date,
        triggers: [], lastRun: null, activeIssue: null,
      };
      return new Proxy(row, {
        get(target, property, receiver) {
          if (++rowReads > routineCount * 64) {
            throw new Error("Routine selection exceeded its collection work limit");
          }
          return Reflect.get(target, property, receiver);
        },
      });
    }).reverse();

    // Both Routines pages call this selector for the table and folder rail.
    const result = selectRoutineRows(routines, {
      ...defaultRoutineView, query: "weekly operations", statuses: ["active"], origins: ["manual"],
      projects: selectedIds("project"), agents: selectedIds("agent"), responsibleUsers: selectedIds("user"),
    }, folders, selection);
    const measuredRowReads = rowReads;
    const expectedIds = Array.from({ length: folderCount }, (_, folder) =>
      (selection === "unfiled" ? [9] : selection === "all" ? [0, 8, 9] : folder === 17 ? [0, 8] : [])
        .map(slot => `routine-${folder * 10 + slot}`),
    ).flat();

    expect(result.sortedRoutines.map(row => row.id)).toEqual(expectedIds);
    expect(result.visibleRoutines).toHaveLength(folderCount * 8);
    expect(result.railFolderResult).toMatchObject({ allCount: folderCount * 8, unfiledCount: folderCount });
    expect(result.railFolderResult?.folders.map(folder => folder.itemCount)).toEqual(Array(folderCount).fill(7));
    expect(folders.folders[0].itemCount).toBe(9);
    expect(selectionReads).toBeGreaterThanOrEqual(folderCount * 3);
    expect(selectionReads).toBeLessThanOrEqual(folderCount * 6);
    expect(measuredRowReads).toBeGreaterThanOrEqual(routineCount);
    expect(measuredRowReads).toBeLessThanOrEqual(routineCount * 64);
  });
});
