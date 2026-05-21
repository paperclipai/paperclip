import { describe, expect, it } from "vitest";
import {
  compareSweepWakeFrame,
  composeSweepWakeFramePage,
  detectSweepWakeRace,
  parseSweepWakeFramePage,
  shouldForceSoftTtlRefresh,
  type SweepWakeFrame,
  type SweepWakeFrameIdentity,
  type SweepWakeIssueSnapshot,
} from "./sweep-wake-preflight.js";

const baseFrame = {
  schemaVersion: 1,
  companyId: "company-1",
  agentId: "agent-1",
  agentName: "Staff Engineer",
  issueIdentifier: "BLO-6347",
  issueId: "issue-1",
  issueLastActivityAt: "2026-05-21T07:00:00.000Z",
  updatedAt: "2026-05-21T07:01:00.000Z",
  status: "blocked",
  blockedByIssueIds: ["blocker-a", "blocker-b"],
  disposition: "blocked_waiting_for_child",
  nextRefreshTriggers: ["blockers resolve"],
  consecutiveSkips: 0,
  body: "# Stable decision\nBody stays unchanged.",
} satisfies SweepWakeFrame;

const baseIssue: SweepWakeIssueSnapshot = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "BLO-6347",
  status: "blocked",
  lastActivityAt: new Date("2026-05-21T07:00:00.000Z"),
  blockedByIssueIds: ["blocker-b", "blocker-a"],
  blockersResolvedSince: null,
};

const baseIdentity: SweepWakeFrameIdentity = {
  companyId: "company-1",
  agentId: "agent-1",
  issueId: "issue-1",
  issueIdentifier: "BLO-6347",
};

describe("compareSweepWakeFrame", () => {
  it("skips a stable schema-v1 frame", () => {
    const decision = compareSweepWakeFrame({
      frame: baseFrame,
      issue: baseIssue,
      recentComments: [],
      expectedIdentity: baseIdentity,
    });

    expect(decision).toEqual({ skip: true, verdict: "skip", frame: baseFrame });
  });

  it("falls open when the frame is missing or invalid", () => {
    expect(compareSweepWakeFrame({
      frame: null,
      issue: baseIssue,
      recentComments: [],
      expectedIdentity: baseIdentity,
    })).toMatchObject({ skip: false, verdict: "missing_or_invalid_frame" });
    expect(compareSweepWakeFrame({
      frame: { ...baseFrame, schemaVersion: 2 },
      issue: baseIssue,
      recentComments: [],
      expectedIdentity: baseIdentity,
    })).toMatchObject({ skip: false, verdict: "missing_or_invalid_frame" });
  });

  it("accepts ISO timestamps without millisecond precision", () => {
    expect(compareSweepWakeFrame({
      frame: {
        ...baseFrame,
        issueLastActivityAt: "2026-05-21T07:00:00Z",
        updatedAt: "2026-05-21T07:01:00Z",
      },
      issue: baseIssue,
      recentComments: [],
      expectedIdentity: baseIdentity,
    })).toMatchObject({ skip: true, verdict: "skip" });
  });

  it("falls open when issue activity is newer than the frame", () => {
    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: { ...baseIssue, lastActivityAt: new Date("2026-05-21T07:00:01.000Z") },
      recentComments: [],
      expectedIdentity: baseIdentity,
    })).toMatchObject({ skip: false, verdict: "new_activity" });
  });

  it("ignores marker comments but falls open for newer non-marker comments", () => {
    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: baseIssue,
      recentComments: [
        { body: "[gstack-preflight] frame stable", createdAt: new Date("2026-05-21T07:02:00.000Z") },
      ],
      expectedIdentity: baseIdentity,
    })).toMatchObject({ skip: true, verdict: "skip" });

    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: baseIssue,
      recentComments: [
        { body: "please re-check this", createdAt: new Date("2026-05-21T07:02:00.000Z") },
      ],
      expectedIdentity: baseIdentity,
    })).toMatchObject({ skip: false, verdict: "new_comment" });
  });

  it("falls open for status or blocker-list drift", () => {
    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: { ...baseIssue, status: "todo" },
      recentComments: [],
      expectedIdentity: baseIdentity,
    })).toMatchObject({ skip: false, verdict: "status_changed" });

    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: { ...baseIssue, blockedByIssueIds: ["blocker-a"] },
      recentComments: [],
      expectedIdentity: baseIdentity,
    })).toMatchObject({ skip: false, verdict: "blocked_by_changed" });
  });

  // Regression: an `issue_blockers_resolved_sweep` wake must not be suppressed when the
  // dependent's own lastActivityAt/status/blocker-list are stable but at least one
  // blocker has been completed after the frame was written. Without this check the
  // server-side gate silently swallows the wake (BLO-6347 review finding #1).
  it("falls open when a blocker has been resolved since the frame was written", () => {
    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: {
        ...baseIssue,
        // Frame.updatedAt is 2026-05-21T07:01:00Z; blocker resolution is 30s later.
        blockersResolvedSince: new Date("2026-05-21T07:01:30.000Z"),
      },
      recentComments: [],
      expectedIdentity: baseIdentity,
    })).toMatchObject({ skip: false, verdict: "blocker_resolved" });
  });

  it("ignores blocker completedAt that pre-dates the frame", () => {
    expect(compareSweepWakeFrame({
      frame: baseFrame,
      issue: {
        ...baseIssue,
        // Blocker was already resolved before the frame was last written; this is the
        // normal stable case and must still skip.
        blockersResolvedSince: new Date("2026-05-21T06:50:00.000Z"),
      },
      recentComments: [],
      expectedIdentity: baseIdentity,
    })).toMatchObject({ skip: true, verdict: "skip" });
  });

  // Regression: a stale or cross-wired gbrain page must not be allowed to suppress a
  // wake for a different company/agent/issue tuple. Frame-shape validation alone is
  // insufficient (BLO-6347 review finding #2).
  it("falls open when the frame identity does not match the DB context", () => {
    const wrongCompany = compareSweepWakeFrame({
      frame: { ...baseFrame, companyId: "company-other" },
      issue: baseIssue,
      recentComments: [],
      expectedIdentity: baseIdentity,
    });
    expect(wrongCompany).toMatchObject({ skip: false, verdict: "identity_mismatch" });

    const wrongAgent = compareSweepWakeFrame({
      frame: { ...baseFrame, agentId: "agent-other" },
      issue: baseIssue,
      recentComments: [],
      expectedIdentity: baseIdentity,
    });
    expect(wrongAgent).toMatchObject({ skip: false, verdict: "identity_mismatch" });

    const wrongIssueId = compareSweepWakeFrame({
      frame: { ...baseFrame, issueId: "issue-other" },
      issue: baseIssue,
      recentComments: [],
      expectedIdentity: baseIdentity,
    });
    expect(wrongIssueId).toMatchObject({ skip: false, verdict: "identity_mismatch" });

    const wrongIdentifier = compareSweepWakeFrame({
      frame: { ...baseFrame, issueIdentifier: "BLO-9999" },
      issue: baseIssue,
      recentComments: [],
      expectedIdentity: baseIdentity,
    });
    expect(wrongIdentifier).toMatchObject({ skip: false, verdict: "identity_mismatch" });
  });
});

// Regression: state captured before the advisory lock can be invalidated by activity
// that lands between the read and the lock acquisition. The race detector must flag
// every such case so the caller falls open without rewriting the frame
// (BLO-6347 review finding #3).
describe("detectSweepWakeRace", () => {
  const frameIssueLastActivityAt = new Date(baseFrame.issueLastActivityAt);
  const previousIssue = {
    lastActivityAt: new Date("2026-05-21T07:00:00.000Z"),
    status: "blocked",
  };

  it("returns raced=false when nothing moved under the lock", () => {
    expect(detectSweepWakeRace({
      previousIssue,
      currentIssue: previousIssue,
      frameIssueLastActivityAt,
      hasNewNonMarkerCommentSinceFrame: false,
    })).toEqual({ raced: false });
  });

  it("flags issue_vanished when the issue cannot be re-read under the lock", () => {
    expect(detectSweepWakeRace({
      previousIssue,
      currentIssue: null,
      frameIssueLastActivityAt,
      hasNewNonMarkerCommentSinceFrame: false,
    })).toEqual({ raced: true, reason: "issue_vanished" });
  });

  it("flags activity_advanced when lastActivityAt moves past the frame snapshot", () => {
    expect(detectSweepWakeRace({
      previousIssue,
      currentIssue: { ...previousIssue, lastActivityAt: new Date("2026-05-21T07:00:30.000Z") },
      frameIssueLastActivityAt,
      hasNewNonMarkerCommentSinceFrame: false,
    })).toEqual({ raced: true, reason: "activity_advanced" });
  });

  it("flags status_changed when the issue status moved under the lock", () => {
    expect(detectSweepWakeRace({
      previousIssue,
      currentIssue: { ...previousIssue, status: "in_progress" },
      frameIssueLastActivityAt,
      hasNewNonMarkerCommentSinceFrame: false,
    })).toEqual({ raced: true, reason: "status_changed" });
  });

  it("flags new_non_marker_comment when a non-marker comment landed since the frame", () => {
    expect(detectSweepWakeRace({
      previousIssue,
      currentIssue: previousIssue,
      frameIssueLastActivityAt,
      hasNewNonMarkerCommentSinceFrame: true,
    })).toEqual({ raced: true, reason: "new_non_marker_comment" });
  });
});

describe("sweep wake frame pages", () => {
  it("round-trips schema version, consecutive skips, arrays, and body", () => {
    const page = composeSweepWakeFramePage({
      ...baseFrame,
      consecutiveSkips: 5,
      body: "# Kept\nThe prose section is unchanged.",
    });

    expect(parseSweepWakeFramePage(page)).toEqual({
      ...baseFrame,
      consecutiveSkips: 5,
      body: "# Kept\nThe prose section is unchanged.",
    });
  });
});

describe("shouldForceSoftTtlRefresh", () => {
  it("forces every twenty-fourth consecutive skip", () => {
    expect(shouldForceSoftTtlRefresh({ ...baseFrame, consecutiveSkips: 23 })).toBe(true);
    expect(shouldForceSoftTtlRefresh({ ...baseFrame, consecutiveSkips: 22 })).toBe(false);
  });
});
