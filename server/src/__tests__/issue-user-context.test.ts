import { describe, it, expect } from "vitest";
import { deriveIssueUserContext } from "../services/issues.js";

// Minimal issue shape matching IssueUserContextInput
function makeIssue(overrides: {
  createdByUserId?: string | null;
  assigneeUserId?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
} = {}) {
  return {
    createdByUserId: overrides.createdByUserId ?? null,
    assigneeUserId: overrides.assigneeUserId ?? null,
    createdAt: overrides.createdAt ?? new Date("2024-01-01T00:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2024-01-01T00:00:00Z"),
  };
}

describe("deriveIssueUserContext", () => {
  const USER_A = "user-a";
  const USER_B = "user-b";

  // ── null / empty stats ──────────────────────────────────────────────────

  it("returns no touch when stats is null and user has no relation to the issue", () => {
    const result = deriveIssueUserContext(makeIssue(), USER_A, null);
    expect(result.myLastTouchAt).toBeNull();
    expect(result.lastExternalCommentAt).toBeNull();
    expect(result.isUnreadForMe).toBe(false);
  });

  it("returns no touch when stats is undefined", () => {
    const result = deriveIssueUserContext(makeIssue(), USER_A, undefined);
    expect(result.myLastTouchAt).toBeNull();
  });

  // ── createdByUserId touch ───────────────────────────────────────────────

  it("sets myLastTouchAt to createdAt when user created the issue (no stats)", () => {
    const createdAt = new Date("2024-03-01T10:00:00Z");
    const result = deriveIssueUserContext(
      makeIssue({ createdByUserId: USER_A, createdAt }),
      USER_A,
      null,
    );
    expect(result.myLastTouchAt).toEqual(createdAt);
  });

  it("does NOT set createdAt touch when a different user created the issue", () => {
    const result = deriveIssueUserContext(
      makeIssue({ createdByUserId: USER_B }),
      USER_A,
      null,
    );
    expect(result.myLastTouchAt).toBeNull();
  });

  // ── assigneeUserId touch ────────────────────────────────────────────────

  it("sets myLastTouchAt to updatedAt when user is the assignee (no stats)", () => {
    const updatedAt = new Date("2024-03-15T12:00:00Z");
    const result = deriveIssueUserContext(
      makeIssue({ assigneeUserId: USER_A, updatedAt }),
      USER_A,
      null,
    );
    expect(result.myLastTouchAt).toEqual(updatedAt);
  });

  it("does NOT set updatedAt touch when a different user is the assignee", () => {
    const result = deriveIssueUserContext(
      makeIssue({ assigneeUserId: USER_B }),
      USER_A,
      null,
    );
    expect(result.myLastTouchAt).toBeNull();
  });

  // ── stats-based touches ─────────────────────────────────────────────────

  it("uses myLastCommentAt from stats as the touch timestamp", () => {
    const myLastCommentAt = new Date("2024-05-01T08:00:00Z");
    const result = deriveIssueUserContext(makeIssue(), USER_A, {
      myLastCommentAt,
      myLastReadAt: null,
      lastExternalCommentAt: null,
    });
    expect(result.myLastTouchAt).toEqual(myLastCommentAt);
  });

  it("uses myLastReadAt from stats when no comment timestamp", () => {
    const myLastReadAt = new Date("2024-05-02T09:00:00Z");
    const result = deriveIssueUserContext(makeIssue(), USER_A, {
      myLastCommentAt: null,
      myLastReadAt,
      lastExternalCommentAt: null,
    });
    expect(result.myLastTouchAt).toEqual(myLastReadAt);
  });

  it("picks the most recent among all touch timestamps", () => {
    const commentAt = new Date("2024-06-01T10:00:00Z");
    const readAt = new Date("2024-05-01T10:00:00Z");
    const createdAt = new Date("2024-04-01T10:00:00Z");
    const result = deriveIssueUserContext(
      makeIssue({ createdByUserId: USER_A, createdAt }),
      USER_A,
      { myLastCommentAt: commentAt, myLastReadAt: readAt, lastExternalCommentAt: null },
    );
    expect(result.myLastTouchAt).toEqual(commentAt);
  });

  it("picks createdAt as most recent touch when it is the latest", () => {
    const createdAt = new Date("2024-07-01T10:00:00Z");
    const readAt = new Date("2024-06-01T10:00:00Z");
    const result = deriveIssueUserContext(
      makeIssue({ createdByUserId: USER_A, createdAt }),
      USER_A,
      { myLastCommentAt: null, myLastReadAt: readAt, lastExternalCommentAt: null },
    );
    expect(result.myLastTouchAt).toEqual(createdAt);
  });

  // ── isUnreadForMe ───────────────────────────────────────────────────────

  it("marks issue as unread when external comment is newer than last touch", () => {
    const touchAt = new Date("2024-04-01T00:00:00Z");
    const externalAt = new Date("2024-04-02T00:00:00Z"); // after touch
    const result = deriveIssueUserContext(makeIssue(), USER_A, {
      myLastCommentAt: touchAt,
      myLastReadAt: null,
      lastExternalCommentAt: externalAt,
    });
    expect(result.isUnreadForMe).toBe(true);
  });

  it("marks issue as read when external comment is older than last touch", () => {
    const touchAt = new Date("2024-04-02T00:00:00Z");
    const externalAt = new Date("2024-04-01T00:00:00Z"); // before touch
    const result = deriveIssueUserContext(makeIssue(), USER_A, {
      myLastCommentAt: touchAt,
      myLastReadAt: null,
      lastExternalCommentAt: externalAt,
    });
    expect(result.isUnreadForMe).toBe(false);
  });

  it("is NOT unread when there is no external comment", () => {
    const result = deriveIssueUserContext(makeIssue(), USER_A, {
      myLastCommentAt: new Date("2024-04-01T00:00:00Z"),
      myLastReadAt: null,
      lastExternalCommentAt: null,
    });
    expect(result.isUnreadForMe).toBe(false);
  });

  it("is NOT unread when there is no last touch (user has no relation and no stats)", () => {
    const result = deriveIssueUserContext(makeIssue(), USER_A, {
      myLastCommentAt: null,
      myLastReadAt: null,
      lastExternalCommentAt: new Date("2024-04-01T00:00:00Z"),
    });
    expect(result.isUnreadForMe).toBe(false);
  });

  // ── ISO string dates ────────────────────────────────────────────────────

  it("handles ISO string dates from stats", () => {
    const touchStr = "2024-04-01T00:00:00Z";
    const externalStr = "2024-04-02T00:00:00Z";
    const result = deriveIssueUserContext(makeIssue(), USER_A, {
      myLastCommentAt: touchStr,
      myLastReadAt: null,
      lastExternalCommentAt: externalStr,
    });
    expect(result.isUnreadForMe).toBe(true);
    expect(result.myLastTouchAt).toEqual(new Date(touchStr));
    expect(result.lastExternalCommentAt).toEqual(new Date(externalStr));
  });

  it("handles ISO string dates for issue createdAt", () => {
    const createdAtStr = "2024-03-01T10:00:00Z";
    const result = deriveIssueUserContext(
      makeIssue({ createdByUserId: USER_A, createdAt: createdAtStr }),
      USER_A,
      null,
    );
    expect(result.myLastTouchAt).toEqual(new Date(createdAtStr));
  });

  // ── combined creator + assignee ─────────────────────────────────────────

  it("uses updatedAt when user is both creator and assignee and updatedAt is later", () => {
    const createdAt = new Date("2024-02-01T00:00:00Z");
    const updatedAt = new Date("2024-03-01T00:00:00Z");
    const result = deriveIssueUserContext(
      makeIssue({ createdByUserId: USER_A, assigneeUserId: USER_A, createdAt, updatedAt }),
      USER_A,
      null,
    );
    expect(result.myLastTouchAt).toEqual(updatedAt);
  });

  it("uses createdAt when user is both creator and assignee and createdAt is later", () => {
    const updatedAt = new Date("2024-01-01T00:00:00Z");
    const createdAt = new Date("2024-03-01T00:00:00Z");
    const result = deriveIssueUserContext(
      makeIssue({ createdByUserId: USER_A, assigneeUserId: USER_A, createdAt, updatedAt }),
      USER_A,
      null,
    );
    expect(result.myLastTouchAt).toEqual(createdAt);
  });
});
