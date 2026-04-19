import { describe, expect, it, vi } from "vitest";
import {
  deriveIssueUserContext,
  issueService,
  normalizeAgentMentionToken,
} from "../services/issues.js";

describe("services/issues.ts", () => {
  it("normalizes encoded @mention tokens from HTML entities", () => {
    expect(normalizeAgentMentionToken("  R&amp;D&#32;Lead&#x21;  ")).toBe("R&D Lead!");
  });

  it("derives unread context when external comments are newer than user touch time", () => {
    const context = deriveIssueUserContext(
      {
        createdByUserId: "user-1",
        assigneeUserId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      "user-1",
      {
        myLastCommentAt: "2026-01-01T01:00:00.000Z",
        myLastReadAt: "2026-01-01T01:30:00.000Z",
        lastExternalCommentAt: "2026-01-01T02:00:00.000Z",
      },
    );

    expect(context.isUnreadForMe).toBe(true);
    expect(context.myLastTouchAt?.toISOString()).toBe("2026-01-01T01:30:00.000Z");
  });

  it("returns not unread when there is no external comment after touch", () => {
    const context = deriveIssueUserContext(
      {
        createdByUserId: null,
        assigneeUserId: "user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T02:00:00.000Z",
      },
      "user-1",
      {
        myLastCommentAt: null,
        myLastReadAt: "2026-01-01T03:00:00.000Z",
        lastExternalCommentAt: "2026-01-01T01:00:00.000Z",
      },
    );

    expect(context.isUnreadForMe).toBe(false);
  });

  it("returns null immediately for non-identifier and non-uuid lookups", async () => {
    const db = { select: vi.fn() };
    const service = issueService(db as any);

    await expect(service.getById("not a valid issue id")).resolves.toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });
});

