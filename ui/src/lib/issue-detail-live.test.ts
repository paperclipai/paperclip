// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  getIssueDetailRefetchInterval,
  getUnreadIssueReadVersion,
  ISSUE_DETAIL_LIVE_RUN_POLL_INTERVAL_MS,
  ISSUE_DETAIL_POLL_INTERVAL_MS,
} from "./issue-detail-live";

describe("issue detail live helpers", () => {
  it("disables polling while the page is hidden", () => {
    expect(
      getIssueDetailRefetchInterval({
        isDocumentVisible: false,
        hasLiveRuns: true,
      }),
    ).toBe(false);
  });

  it("polls faster while an issue has live runs", () => {
    expect(
      getIssueDetailRefetchInterval({
        isDocumentVisible: true,
        hasLiveRuns: true,
      }),
    ).toBe(ISSUE_DETAIL_LIVE_RUN_POLL_INTERVAL_MS);
  });

  it("polls at the normal cadence when no live run is active", () => {
    expect(
      getIssueDetailRefetchInterval({
        isDocumentVisible: true,
        hasLiveRuns: false,
      }),
    ).toBe(ISSUE_DETAIL_POLL_INTERVAL_MS);
  });

  it("returns a stable unread version keyed by the latest external comment", () => {
    expect(
      getUnreadIssueReadVersion({
        id: "issue-1",
        isUnreadForMe: true,
        lastExternalCommentAt: new Date("2026-03-15T12:00:00.000Z"),
      }),
    ).toBe("issue-1:2026-03-15T12:00:00.000Z");
  });

  it("skips read marking when the issue is already read", () => {
    expect(
      getUnreadIssueReadVersion({
        id: "issue-1",
        isUnreadForMe: false,
        lastExternalCommentAt: new Date("2026-03-15T12:00:00.000Z"),
      }),
    ).toBeNull();
  });
});
