import { describe, expect, it } from "vitest";
import { deriveIssueUserContext } from "../services/issues.ts";

function makeIssue(overrides?: Partial<{
  createdByUserId: string | null;
  assigneeUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}>) {
  return {
    createdByUserId: null,
    assigneeUserId: null,
    createdAt: new Date("2026-03-06T10:00:00.000Z"),
    updatedAt: new Date("2026-03-06T11:00:00.000Z"),
    ...overrides,
  };
}

describe("deriveIssueUserContext", () => {
  it("marks issue unread when external comments are newer than my latest comment", () => {
    const context = deriveIssueUserContext(
      makeIssue({ createdByUserId: "user-1" }),
      "user-1",
      {
        myLastCommentAt: new Date("2026-03-06T12:00:00.000Z"),
        myLastReadAt: null,
        lastExternalCommentAt: new Date("2026-03-06T13:00:00.000Z"),
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T12:00:00.000Z");
    expect(context.lastExternalCommentAt?.toISOString()).toBe("2026-03-06T13:00:00.000Z");
    expect(context.isUnreadForMe).toBe(true);
  });

  it("marks issue read when my latest comment is newest", () => {
    const context = deriveIssueUserContext(
      makeIssue({ createdByUserId: "user-1" }),
      "user-1",
      {
        myLastCommentAt: new Date("2026-03-06T14:00:00.000Z"),
        myLastReadAt: null,
        lastExternalCommentAt: new Date("2026-03-06T13:00:00.000Z"),
      },
    );

    expect(context.isUnreadForMe).toBe(false);
  });

  it("uses issue creation time as fallback touch point for creator", () => {
    const context = deriveIssueUserContext(
      makeIssue({ createdByUserId: "user-1", createdAt: new Date("2026-03-06T09:00:00.000Z") }),
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: null,
        lastExternalCommentAt: new Date("2026-03-06T10:00:00.000Z"),
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T09:00:00.000Z");
    expect(context.isUnreadForMe).toBe(true);
  });

  it("uses issue updated time as fallback touch point for assignee", () => {
    const context = deriveIssueUserContext(
      makeIssue({ assigneeUserId: "user-1", updatedAt: new Date("2026-03-06T15:00:00.000Z") }),
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: null,
        lastExternalCommentAt: new Date("2026-03-06T14:59:00.000Z"),
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T15:00:00.000Z");
    expect(context.isUnreadForMe).toBe(false);
  });

  it("uses latest read timestamp to clear unread without requiring a comment", () => {
    const context = deriveIssueUserContext(
      makeIssue({ createdByUserId: "user-1", createdAt: new Date("2026-03-06T09:00:00.000Z") }),
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: new Date("2026-03-06T11:30:00.000Z"),
        lastExternalCommentAt: new Date("2026-03-06T11:00:00.000Z"),
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T11:30:00.000Z");
    expect(context.isUnreadForMe).toBe(false);
  });

  it("agent-created issue with no user interaction returns myLastTouchAt null and not unread", () => {
    const context = deriveIssueUserContext(
      makeIssue(), // createdByUserId=null, assigneeUserId=null
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: null,
        lastExternalCommentAt: new Date("2026-03-06T12:00:00.000Z"),
      },
    );

    expect(context.myLastTouchAt).toBeNull();
    expect(context.isUnreadForMe).toBe(false);
  });

  it("agent-created issue marked as read clears unread state", () => {
    const context = deriveIssueUserContext(
      makeIssue(), // createdByUserId=null, assigneeUserId=null
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: new Date("2026-03-06T14:00:00.000Z"),
        lastExternalCommentAt: new Date("2026-03-06T12:00:00.000Z"),
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T14:00:00.000Z");
    expect(context.isUnreadForMe).toBe(false);
  });

  it("agent-created issue with new comment after mark-read shows unread", () => {
    const context = deriveIssueUserContext(
      makeIssue(), // createdByUserId=null, assigneeUserId=null
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: new Date("2026-03-06T14:00:00.000Z"),
        lastExternalCommentAt: new Date("2026-03-06T15:00:00.000Z"),
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T14:00:00.000Z");
    expect(context.isUnreadForMe).toBe(true);
  });

  it("handles SQL timestamp strings without throwing", () => {
    const context = deriveIssueUserContext(
      makeIssue({
        createdByUserId: "user-1",
        createdAt: new Date("2026-03-06T09:00:00.000Z"),
      }),
      "user-1",
      {
        myLastCommentAt: "2026-03-06T10:00:00.000Z",
        myLastReadAt: null,
        lastExternalCommentAt: "2026-03-06T11:00:00.000Z",
      },
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T10:00:00.000Z");
    expect(context.lastExternalCommentAt?.toISOString()).toBe("2026-03-06T11:00:00.000Z");
    expect(context.isUnreadForMe).toBe(true);
  });

  it("agent-created issue: mark-read then new comment during viewing makes it unread again", () => {
    // Simulates: user views issue (mark-read), agent posts while user is reading
    const context = deriveIssueUserContext(
      makeIssue(), // agent-created: createdByUserId=null, assigneeUserId=null
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: new Date("2026-03-06T14:00:00.000Z"), // marked on mount
        lastExternalCommentAt: new Date("2026-03-06T14:05:00.000Z"), // agent comment arrived while viewing
      },
    );

    expect(context.isUnreadForMe).toBe(true);

    // After unmount mark-read fires with a later timestamp, issue becomes read
    const contextAfterUnmount = deriveIssueUserContext(
      makeIssue(),
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: new Date("2026-03-06T14:10:00.000Z"), // marked on unmount
        lastExternalCommentAt: new Date("2026-03-06T14:05:00.000Z"),
      },
    );

    expect(contextAfterUnmount.isUnreadForMe).toBe(false);
  });

  it("null stats returns not unread", () => {
    const context = deriveIssueUserContext(
      makeIssue({ createdByUserId: "user-1" }),
      "user-1",
      null,
    );

    expect(context.myLastTouchAt?.toISOString()).toBe("2026-03-06T10:00:00.000Z");
    expect(context.isUnreadForMe).toBe(false);
  });
});
