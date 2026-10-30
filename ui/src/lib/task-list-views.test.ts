// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadTaskListView, matchesTaskListView, saveTaskListView, taskListViewStorageKey } from "./task-list-views";

const task = { createdByUserId: null, assigneeUserId: null, status: "todo" } as const;

describe("task list views", () => {
  it("includes self-created OR self-assigned tasks in Inbox, without treating missing identities as a match", () => {
    expect(matchesTaskListView("inbox", { ...task, createdByUserId: "me" }, false, "me")).toBe(true);
    expect(matchesTaskListView("inbox", { ...task, createdByUserId: "other", assigneeUserId: "me" }, false, "me")).toBe(true);
    expect(matchesTaskListView("inbox", { ...task, createdByUserId: "other", assigneeUserId: "other" }, true, "me")).toBe(false);
    expect(matchesTaskListView("inbox", task, true, "me")).toBe(false);
    expect(matchesTaskListView("inbox", task, true, null)).toBe(false);
  });

  it("includes blocked and in-review tasks and excludes other statuses", () => {
    for (const status of ["blocked", "in_review", "todo", "backlog", "in_progress", "done", "cancelled"] as const) {
      expect(matchesTaskListView("blocked", { ...task, status }, false, "me")).toBe(["blocked", "in_review"].includes(status));
    }
  });

  it("uses unread state independently of ownership and status; All tasks includes both", () => {
    expect(matchesTaskListView("unread", task, true, "me")).toBe(true);
    expect(matchesTaskListView("unread", task, false, "me")).toBe(false);
    expect(matchesTaskListView("all", task, false, null)).toBe(true);
    expect(matchesTaskListView("all", { ...task, status: "done" }, true, "me")).toBe(true);
  });

  it("defaults new users to All tasks and remembers each user's choice in its own scope", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const first = taskListViewStorageKey("design-proposals", "first");
    const second = taskListViewStorageKey("design-proposals", "second");
    expect(loadTaskListView(first, storage)).toBe("all");
    saveTaskListView(first, "blocked", storage);
    expect(loadTaskListView(first, storage)).toBe("blocked");
    expect(loadTaskListView(second, storage)).toBe("all");
    expect(loadTaskListView(taskListViewStorageKey("production", "first"), storage)).toBe("all");
    storage.setItem(first, "completed");
    expect(loadTaskListView(first, storage)).toBe("all");
  });

  it("tolerates unavailable and denied storage", () => {
    const denied = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(loadTaskListView("key", null)).toBe("all");
    expect(loadTaskListView("key", denied)).toBe("all");
    expect(() => saveTaskListView("key", "inbox", denied)).not.toThrow();
  });
});
