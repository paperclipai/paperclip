import { clearIssueExecutionRun } from "./optimistic-issue-runs";
import type { Issue } from "@paperclipai/shared";
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_TASKS_LIMIT,
  RECENT_TASKS_UPDATED_EVENT,
  getRecentTasksStorageKey,
  migrateRecentTasks,
  pruneRecentTasks,
  readRecentTasks,
  recordRecentTask,
  updateRecentTaskSnapshots,
  writeRecentTasks,
} from "./recent-tasks";

const issue = (id: string, companyId = "company-1") => ({
  id,
  companyId,
  title: `Task ${id}`,
  identifier: `PAP-${id}`,
  status: "todo" as const,
  updatedAt: new Date(0),
});
// Support both jsdom Storage (Node 24) and the setup's storage shim (newer Node).
const storageMethods = window.localStorage instanceof window.Storage ? window.Storage.prototype : window.localStorage;

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

  it("refreshes conversation readiness when review or delivery changes without a task edit", () => {
    const task = { ...issue("1"), status: "in_review" as const, externalConversationState: "waiting" as const };
    recordRecentTask(task, "user-1");
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    updateRecentTaskSnapshots(storageKey, "company-1", [{ ...task, externalConversationState: "active" }]);
    expect(readRecentTasks(storageKey, "company-1")[0]?.externalConversationState).toBe("active");
  });

  it("accepts server settlement after an optimistic run-lock clear", () => {
    const running = { ...issue("1"), status: "in_progress" as const, externalConversationState: "active" as const, executionRunId: "run-1", updatedAt: new Date(10) } as Issue;
    recordRecentTask(running, "user-1");
    recordRecentTask(clearIssueExecutionRun(running, "run-1")!, "user-1");
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    updateRecentTaskSnapshots(storageKey, "company-1", [{ ...running, status: "in_review", externalConversationState: "waiting", updatedAt: new Date(20) }]);
    expect(readRecentTasks(storageKey, "company-1")[0]).toMatchObject({ status: "in_review", externalConversationState: "waiting", snapshotUpdatedAt: 20 });
    updateRecentTaskSnapshots(storageKey, "company-1", [{ ...running, updatedAt: new Date(30) }]);
    updateRecentTaskSnapshots(storageKey, "company-1", [{ ...running, status: "in_review", externalConversationState: "waiting", updatedAt: new Date(20) }]);
    expect(readRecentTasks(storageKey, "company-1")[0]).toMatchObject({ status: "in_progress", externalConversationState: "active", snapshotUpdatedAt: 30 });
  });

  it("keeps readiness and task status together when a turn settles at the same timestamp", () => {
    const task = { ...issue("1"), status: "in_progress" as const, externalConversationState: "active" as const };
    recordRecentTask(task, "user-1");
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    updateRecentTaskSnapshots(storageKey, "company-1", [{ ...task, status: "in_review", externalConversationState: "waiting" }]);
    expect(readRecentTasks(storageKey, "company-1")[0]).toMatchObject({ status: "in_review", externalConversationState: "waiting" });
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

  it("does not demote recent comment activity when older task details arrive", () => {
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    recordRecentTask({ ...issue("1"), updatedAt: new Date(50) }, "user-1", 100);
    recordRecentTask({ ...issue("2"), updatedAt: new Date(80) }, "user-1", 90);
    const listener = vi.fn();
    window.addEventListener(RECENT_TASKS_UPDATED_EVENT, listener);

    for (let index = 0; index < 10; index += 1) {
      recordRecentTask({ ...issue("1"), updatedAt: new Date(50) }, "user-1");
      updateRecentTaskSnapshots(storageKey, "company-1", [
        { ...issue("1"), updatedAt: new Date(50) },
        { ...issue("2"), updatedAt: new Date(80) },
      ]);
    }

    expect(readRecentTasks(storageKey, "company-1").map(({ id, recordedAt }) => ({ id, recordedAt }))).toEqual([
      { id: "1", recordedAt: 100 },
      { id: "2", recordedAt: 90 },
    ]);
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(RECENT_TASKS_UPDATED_EVENT, listener);

    updateRecentTaskSnapshots(storageKey, "company-1", [{
      ...issue("1"), title: "Renamed task", status: "done", updatedAt: new Date(60),
    }]);
    expect(readRecentTasks(storageKey, "company-1")[0]).toMatchObject({
      id: "1", title: "Renamed task", status: "done", recordedAt: 100,
    });
  });

  it("ignores malformed and cross-company entries", () => {
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    window.localStorage.setItem(storageKey, JSON.stringify([
      issue("other", "company-2"),
      { nonsense: true },
      { ...issue("invalid-version"), recordedAt: 1, snapshotUpdatedAt: "invalid" },
    ]));
    expect(readRecentTasks(storageKey, "company-1")).toEqual([]);
  });

  it("settles conflicting tab snapshots without further writes or notifications", () => {
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    const older = { ...issue("1"), title: "Old title", updatedAt: new Date(10) };
    const newer = { ...issue("1"), title: "New title", status: "done" as const, updatedAt: new Date(20) };
    recordRecentTask(older, "user-1");
    updateRecentTaskSnapshots(storageKey, "company-1", [newer]);
    const setItem = vi.spyOn(storageMethods, "setItem");
    const listener = vi.fn();
    window.addEventListener(RECENT_TASKS_UPDATED_EVENT, listener);
    try {
      for (let index = 0; index < 20; index += 1) {
        updateRecentTaskSnapshots(storageKey, "company-1", [older]);
        recordRecentTask(older, "user-1");
        updateRecentTaskSnapshots(storageKey, "company-1", [newer]);
      }
      expect(readRecentTasks(storageKey, "company-1")[0]).toMatchObject({
        title: "New title", status: "done", snapshotUpdatedAt: 20, recordedAt: 20,
      });
      expect(setItem).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
      window.removeEventListener(RECENT_TASKS_UPDATED_EVENT, listener);
    }
  });

  it("promotes a new comment without overwriting newer task details", () => {
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    recordRecentTask({ ...issue("1"), title: "Done", status: "done", updatedAt: new Date(20) }, "user-1");
    recordRecentTask({ ...issue("1"), updatedAt: new Date(10) }, "user-1", 30);
    expect(readRecentTasks(storageKey, "company-1")[0]).toMatchObject({
      title: "Done", status: "done", snapshotUpdatedAt: 20, recordedAt: 30,
    });
  });

  it("retains the current snapshot for equal or invalid versions", () => {
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    recordRecentTask(issue("1"), "user-1");
    for (const updatedAt of [new Date(0), new Date("invalid")]) {
      updateRecentTaskSnapshots(storageKey, "company-1", [{ ...issue("1"), title: "Conflict", updatedAt }]);
    }
    expect(readRecentTasks(storageKey, "company-1")[0]).toMatchObject({ title: "Task 1", snapshotUpdatedAt: 0 });
  });

  it("does not write or publish an unchanged normalized list", () => {
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    recordRecentTask(issue("1"), "user-1", 1);
    recordRecentTask(issue("2"), "user-1", 2);
    const entries = readRecentTasks(storageKey, "company-1");
    const setItem = vi.spyOn(storageMethods, "setItem");
    const listener = vi.fn();
    window.addEventListener(RECENT_TASKS_UPDATED_EVENT, listener);
    try {
      writeRecentTasks(storageKey, [...entries].reverse());
      expect(setItem).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
      window.removeEventListener(RECENT_TASKS_UPDATED_EVENT, listener);
    }
  });

  it("migrates legacy tasks once and isolates subsequent old-tab writes", () => {
    const legacyKey = "paperclip.recentTasks:company-1:user-1";
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    const legacy = [{ ...issue("1"), recordedAt: 100 }];
    window.localStorage.setItem(legacyKey, JSON.stringify(legacy));
    expect(readRecentTasks(storageKey, "company-1")[0]?.id).toBe("1");
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    migrateRecentTasks(storageKey, "company-1");
    expect(window.localStorage.getItem(legacyKey)).toBe(JSON.stringify(legacy));
    // The first versioned refresh can update legacy metadata, even after a comment.
    updateRecentTaskSnapshots(storageKey, "company-1", [{ ...issue("1"), title: "Fresh", updatedAt: new Date(20) }]);
    expect(readRecentTasks(storageKey, "company-1")[0]).toMatchObject({
      title: "Fresh", snapshotUpdatedAt: 20, recordedAt: 100,
    });
    window.localStorage.setItem(legacyKey, JSON.stringify([{ ...issue("old-tab"), recordedAt: 200 }]));
    migrateRecentTasks(storageKey, "company-1");
    expect(readRecentTasks(storageKey, "company-1")[0]?.title).toBe("Fresh");
    pruneRecentTasks(storageKey, "company-1", new Set(["1"]));
    migrateRecentTasks(storageKey, "company-1");
    expect(readRecentTasks(storageKey, "company-1")).toEqual([]);
  });

  it("does not import legacy tasks that appear after an empty migration", () => {
    const storageKey = getRecentTasksStorageKey("company-1", "user-1");
    migrateRecentTasks(storageKey, "company-1");
    window.localStorage.setItem("paperclip.recentTasks:company-1:user-1", JSON.stringify([{ ...issue("1"), recordedAt: 1 }]));
    migrateRecentTasks(storageKey, "company-1");
    expect(readRecentTasks(storageKey, "company-1")).toEqual([]);
  });
});
