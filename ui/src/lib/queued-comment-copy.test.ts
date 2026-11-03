import { describe, expect, it } from "vitest";
import { decideQueuedCommentWakeLookup } from "../../../server/src/modules/wake-queue/domain/policy";
import {
  QUEUED_CANCEL_REQUESTED,
  QUEUED_CANCEL_REQUESTED_TOAST,
  QUEUED_LATE_DISCARD,
  QUEUED_LATE_DISCARD_TOAST,
  QUEUED_ROW_HEADER_LEAD_SAVING,
} from "./queued-comment-copy";

const STARTED_OR_CONSUMED = /started|already has|has (read|seen)|was read|delivered|being sent/i;

describe("queued comment copy", () => {
  it("does not infer a started or consuming turn from a late-delete error", () => {
    expect(
      decideQueuedCommentWakeLookup({
        wakePresent: true,
        wakeIssueIdMatches: true,
        hasQueuedCommentIds: true,
        wakeStatus: "claimed",
        wakeHasRunId: false,
      }),
    ).toEqual({ kind: "already_dispatching" });
    for (const text of [QUEUED_LATE_DISCARD, QUEUED_LATE_DISCARD_TOAST.body]) {
      expect(text).not.toMatch(STARTED_OR_CONSUMED);
      expect(text).toContain("stays in the thread");
    }
  });

  it("keeps unsaved and requested-cancel copy short of confirmed visibility or deletion", () => {
    expect(QUEUED_ROW_HEADER_LEAD_SAVING).not.toMatch(/visible now/i);
    for (const text of [
      QUEUED_CANCEL_REQUESTED,
      QUEUED_CANCEL_REQUESTED_TOAST.title,
      QUEUED_CANCEL_REQUESTED_TOAST.body,
    ]) {
      expect(text).not.toMatch(/\b(deleted|canceled|cancelled)\b|Removed from the thread/i);
    }
    expect(QUEUED_CANCEL_REQUESTED_TOAST.body).toContain("Earlier reads or actions can’t be undone.");
  });
});
