// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_TASKS_LIMIT,
  RECENT_TASKS_UPDATED_EVENT,
  getRecentTasksStorageKey,
  pruneRecentTasks,
  readRecentTasks,
  recordRecentTask,
  updateRecentTaskSnapshots,
} from "./recent-tasks";

const issue = (id: string, companyId = "company-1") => ({
  id,
  companyId,
  title: `Task ${id}`,
  identifier: `PAP-${id}`,
  status: "todo" as const,
  updatedAt: new Date(0),
});

describe("recent task persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("is account and company scoped", () => {
    expect(getRecentTasksStorageKey("company-1", "user-1")).not.toBe(
      getRecentTasksStorageKey("company-1", "user-2"),
    );
    expect(getRecentTasksStorageKey("company-1", "user-1")).not.toBe(
      getRecentTasksStorageKey("company-2", "user-1"),
    );
  });

  it("deduplicates, only promotes newer activity, and stays bounded", () => {
    for (let index = 0; index < RECENT_TASKS_LIMIT + 2; index += 1) {
      recordRecentTask(issue(String(index)), "user-1", index);
    }
    recordRecentTask(issue("4"), "user-1", 4);

    let entries = readRecentTasks(getRecentTasksStorageKey("company-1", "user-1"), "company-1");
    expect(entries[0]?.id).toBe("6");

    recordRecentTask(issue("4"), "user-1", 99);

    entries = readRecentTasks(getRecentTasksStorageKey("company-1", "user-1"), "company-1");
    expect(entries).toHaveLength(RECENT_TASKS_LIMIT);
    expect(entries[0]?.id).toBe("4");
    expect(entries.filter((entry) => entry.id === "4")).toHaveLength(1);
  });

  it("publishes same-tab updates", () => {
    const listener = vi.fn();
    window.addEventListener(RECENT_TASKS_UPDATED_EVENT, listener);
    recordRecentTask(issue("1"), "user-1");
    expect(listener).toHaveBeenCalledOnce();
    listener.mockClear();
    recordRecentTask(issue("1"), "user-1");
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(RECENT_TASKS_UPDATED_EVENT, listener);
  });

  it("prunes unavailable tasks and refreshes stored snapshots", () => {
    recordRecentTask(issue("1"), "user-1", 1);
    recordRecentTask(issue("2"), "user-1", 2);
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");

    updateRecentTaskSnapshots(storageKey, "company-1", [{
      ...issue("2"),
      title: "Updated task",
      status: "in_progress",
      updatedAt: new Date(3),
    }]);
    pruneRecentTasks(storageKey, "company-1", new Set(["1"]));

    expect(readRecentTasks(storageKey, "company-1")).toEqual([
      expect.objectContaining({
        id: "2",
        title: "Updated task",
        status: "in_progress",
        recordedAt: 3,
      }),
    ]);
  });

  it("ignores malformed and cross-company entries", () => {
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    window.localStorage.setItem(storageKey, JSON.stringify([
      issue("other", "company-2"),
      { nonsense: true },
    ]));
    expect(readRecentTasks(storageKey, "company-1")).toEqual([]);
  });
});
