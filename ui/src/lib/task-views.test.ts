import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_VIEW,
  TASK_VIEW_GROUPS,
  TASK_VIEW_KEYS,
  isTaskViewKey,
  normalizeTaskViewKey,
  resolveInitialTaskView,
  taskView,
  taskViewForInboxTab,
  taskViewPath,
} from "./task-views";

describe("task views registry (PAP-670)", () => {
  it("covers every legacy Inbox tab and task status preset exactly once", () => {
    const keys = TASK_VIEW_GROUPS.flatMap((group) => group.views.map((view) => view.key));
    expect(keys).toEqual([...TASK_VIEW_KEYS]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("routes My-work views to the inbox surface with a tab, and organization views to the task list with statuses", () => {
    const [myWork, organization] = TASK_VIEW_GROUPS;

    expect(myWork.views.map((view) => view.inboxTab)).toEqual(["mine", "unread", "blocked", "recent", "all"]);
    for (const view of myWork.views) {
      expect(view.surface).toBe("inbox");
      expect(view.statuses).toBeUndefined();
    }

    for (const view of organization.views) {
      expect(view.surface).toBe("issues");
      expect(view.inboxTab).toBeUndefined();
      expect(Array.isArray(view.statuses)).toBe(true);
    }
    expect(taskView("all").statuses).toEqual([]);
    expect(taskView("active").statuses).toEqual(["todo", "in_progress", "in_review", "blocked"]);
    expect(taskView("backlog").statuses).toEqual(["backlog"]);
    expect(taskView("done").statuses).toEqual(["done", "cancelled"]);
  });

  it("every view carries a label and a hint for the Views menu", () => {
    for (const key of TASK_VIEW_KEYS) {
      expect(taskView(key).label.length).toBeGreaterThan(0);
      expect(taskView(key).hint.length).toBeGreaterThan(0);
    }
  });

  it("normalizes unknown view keys to null rather than guessing", () => {
    expect(normalizeTaskViewKey("blocked")).toBe("blocked");
    expect(normalizeTaskViewKey("everything")).toBe("everything");
    expect(normalizeTaskViewKey("nonsense")).toBeNull();
    expect(normalizeTaskViewKey(null)).toBeNull();
    expect(normalizeTaskViewKey("")).toBeNull();
    expect(isTaskViewKey("mine")).toBe(true);
    expect(isTaskViewKey("Mine")).toBe(false);
  });

  it("maps the retired /inbox/* tabs onto views — /inbox/all becomes Everything, not All tasks", () => {
    expect(taskViewForInboxTab("mine")).toBe("mine");
    expect(taskViewForInboxTab("recent")).toBe("recent");
    expect(taskViewForInboxTab("unread")).toBe("unread");
    expect(taskViewForInboxTab("blocked")).toBe("blocked");
    expect(taskViewForInboxTab("all")).toBe("everything");
    expect(taskViewForInboxTab("requests")).toBe(DEFAULT_TASK_VIEW);
    expect(taskViewForInboxTab(null)).toBe(DEFAULT_TASK_VIEW);
  });

  it("addresses views on the Tasks route", () => {
    expect(taskViewPath("everything")).toBe("/issues?view=everything");
  });
});

describe("resolveInitialTaskView", () => {
  it("prefers an explicit ?view=", () => {
    expect(resolveInitialTaskView("blocked", false, "done")).toBe("blocked");
    expect(resolveInitialTaskView("backlog", true, "done")).toBe("backlog");
  });

  it("falls back to the last-used view on a bare /issues", () => {
    expect(resolveInitialTaskView(null, false, "backlog")).toBe("backlog");
    expect(resolveInitialTaskView("nonsense", false, "backlog")).toBe("backlog");
    expect(resolveInitialTaskView(null, false, DEFAULT_TASK_VIEW)).toBe("mine");
  });

  it("opens All tasks when an explicit inbox view carries an organization filter", () => {
    // Inbox views can't apply ?participantAgentId= and friends.
    expect(resolveInitialTaskView("mine", true, "mine")).toBe("all");
    expect(resolveInitialTaskView("everything", true, "mine")).toBe("all");
  });

  it("opens All tasks for an organization-scoped deep link so its filter is not silently dropped", () => {
    // /issues?assignee=… and friends mean the org task list; landing them on a
    // My-work view would drop the filter they carry.
    expect(resolveInitialTaskView(null, true, "mine")).toBe("all");
    expect(resolveInitialTaskView(null, true, "blocked")).toBe("all");
  });
});
