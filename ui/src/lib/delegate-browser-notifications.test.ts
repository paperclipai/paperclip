import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  claimDelegateNotification,
  getDueDelegateNotifications,
  isDelegateBrowserNotificationsEnabled,
  releaseDelegateNotification,
  setDelegateBrowserNotificationsEnabled,
} from "./delegate-browser-notifications";

function issue(id: string, status: Issue["status"], overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: id,
    description: null,
    status,
    statusVersion: 1,
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: 1,
    identifier: id,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-08-29T09:00:00-04:00"),
    updatedAt: new Date("2026-08-29T09:00:00-04:00"),
    ...overrides,
  };
}

describe("delegate browser notifications", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("notifies blocked work immediately and review work only when its review time arrives", () => {
    const now = new Date("2026-08-29T12:00:00-04:00");
    const candidates = getDueDelegateNotifications([
      issue("blocked", "blocked"),
      issue("due-review", "in_review", {
        reviewBy: new Date("2026-08-29T11:59:00-04:00"),
        estimatedReviewMinutes: 10,
      }),
      issue("future-review", "in_review", { reviewBy: new Date("2026-08-29T12:01:00-04:00") }),
      issue("working", "in_progress", { reviewBy: new Date("2026-08-29T11:00:00-04:00") }),
      issue("plan", "blocked", { workMode: "planning" }),
    ], "company-1", now);

    expect(candidates.map((candidate) => candidate.kind)).toEqual(["blocked", "ready"]);
    expect(candidates[1]).toMatchObject({
      title: "Ready to review",
      body: "due-review · 10 min review",
      href: "/issues/due-review",
    });
  });

  it("deduplicates a delivered status version and allows a later transition", () => {
    const now = new Date("2026-08-29T12:00:00-04:00");
    const first = getDueDelegateNotifications([issue("review", "in_review")], "company-1", now)[0];
    expect(claimDelegateNotification("company-1", first.key)).toBe(true);
    expect(claimDelegateNotification("company-1", first.key)).toBe(false);
    expect(getDueDelegateNotifications([issue("review", "in_review")], "company-1", now)).toEqual([]);

    const changed = getDueDelegateNotifications([
      issue("review", "in_review", { statusVersion: 2 }),
    ], "company-1", now);
    expect(changed).toHaveLength(1);

    releaseDelegateNotification("company-1", first.key);
    expect(getDueDelegateNotifications([issue("review", "in_review")], "company-1", now)).toHaveLength(1);
  });

  it("treats rescheduling and terminal states as cancellation of a pending review alert", () => {
    const now = new Date("2026-08-29T12:00:00-04:00");
    const rescheduled = issue("review", "in_review", {
      statusVersion: 2,
      reviewBy: new Date("2026-08-29T13:00:00-04:00"),
    });
    expect(getDueDelegateNotifications([rescheduled], "company-1", now)).toEqual([]);
    expect(getDueDelegateNotifications([
      issue("review", "done", { statusVersion: 3 }),
      issue("cancelled", "cancelled", { statusVersion: 2 }),
    ], "company-1", now)).toEqual([]);
  });

  it("stores the preference separately for each company", () => {
    const windowTarget = new EventTarget();
    vi.stubGlobal("window", Object.assign(windowTarget, { localStorage }));

    setDelegateBrowserNotificationsEnabled("company-1", true);
    expect(isDelegateBrowserNotificationsEnabled("company-1")).toBe(true);
    expect(isDelegateBrowserNotificationsEnabled("company-2")).toBe(false);

    setDelegateBrowserNotificationsEnabled("company-1", false);
    expect(isDelegateBrowserNotificationsEnabled("company-1")).toBe(false);
  });
});
