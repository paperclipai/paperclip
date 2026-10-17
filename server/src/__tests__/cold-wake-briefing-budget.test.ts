import { describe, expect, it } from "vitest";
import type {
  ColdWakeBriefing,
  ColdWakeClosedIssue,
  ColdWakeRecentCommit,
  ColdWakeRelatedComment,
  ColdWakeSiblingIssue,
} from "../services/cold-wake-briefing.ts";
import {
  DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP,
  DEFAULT_HIBERNATION_THRESHOLD_HOURS,
  enforceBriefingBudget,
  estimateBriefingTokens,
  resolveColdWakeBriefingTokenCap,
} from "../services/cold-wake-briefing.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const COLD_LAST_RUN_ISO = "2026-06-08T20:00:00Z";

/** Build a small "base" briefing whose protected fields exercise the
 *  acceptance criterion that the staleness header, planDocument, and
 *  pendingRequestConfirmation are never mutated. */
function baseBriefing(): ColdWakeBriefing {
  return {
    thresholdHours: DEFAULT_HIBERNATION_THRESHOLD_HOURS,
    hoursSinceLastRun: 72,
    lastRunFinishedAt: COLD_LAST_RUN_ISO,
    recentCommits: [],
    recentCommitsTruncated: false,
    recentlyClosedReferencedIssues: [],
    siblingInProgressIssues: [],
    planDocument: {
      key: "plan",
      revisionId: "00000000-0000-0000-0000-0000000000f1",
      updatedAt: "2026-06-11T18:00:00Z",
    },
    pendingRequestConfirmation: {
      interactionId: "00000000-0000-0000-0000-00000000a111",
      revisionId: "00000000-0000-0000-0000-0000000000f1",
      createdAt: "2026-06-11T18:05:00Z",
    },
    recentRelatedComments: [],
    sourcesIncluded: ["git", "closed_issues", "siblings", "plan", "interaction", "comments"],
    budgetTokens: 0,
    budgetTokenCap: DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP,
    truncated: false,
    briefingError: null,
  };
}

/** Helper to build a commit with controllable size. `bodyChars` pads the
 *  subject so we can drive the estimator over the cap deterministically. */
function makeCommit(opts: {
  date: string;
  sha?: string;
  bodyChars?: number;
  touchedReferencedPath?: boolean;
}): ColdWakeRecentCommit {
  const pad = "x".repeat(opts.bodyChars ?? 0);
  return {
    sha: opts.sha ?? `c${opts.date.replace(/[^0-9]/g, "")}`,
    subject: `commit ${opts.date} ${pad}`,
    author: "Test Author",
    date: opts.date,
    touchedReferencedPath: opts.touchedReferencedPath ?? false,
  };
}

function makeComment(opts: {
  createdAt: string;
  id?: string;
  bodyChars?: number;
}): ColdWakeRelatedComment {
  const pad = "x".repeat(opts.bodyChars ?? 0);
  return {
    issueId: "00000000-0000-0000-0000-0000000000d1",
    issueIdentifier: "ALL-700",
    commentId: opts.id ?? `comment-${opts.createdAt}`,
    authorType: "board_user",
    createdAt: opts.createdAt,
    bodyPreview: `preview ${pad}`,
    bodyTruncated: false,
  };
}

function makeSibling(opts: { updatedAt: string; id?: string }): ColdWakeSiblingIssue {
  return {
    id: opts.id ?? `sib-${opts.updatedAt}`,
    identifier: `SIB-${opts.updatedAt}`,
    title: `Sibling ${opts.updatedAt}`,
    assigneeAgentId: "00000000-0000-0000-0000-0000000000bb",
    updatedAt: opts.updatedAt,
  };
}

function makeClosed(opts: { closedAt: string; id?: string }): ColdWakeClosedIssue {
  return {
    id: opts.id ?? `cls-${opts.closedAt}`,
    identifier: `CLS-${opts.closedAt}`,
    title: `Closed ${opts.closedAt}`,
    status: "done",
    closedAt: opts.closedAt,
  };
}

// ---------------------------------------------------------------------------
// resolveColdWakeBriefingTokenCap
// ---------------------------------------------------------------------------

describe("resolveColdWakeBriefingTokenCap", () => {
  it("falls back to the default when the env var is unset", () => {
    expect(resolveColdWakeBriefingTokenCap({})).toBe(
      DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP,
    );
  });

  it("respects a valid numeric override", () => {
    expect(
      resolveColdWakeBriefingTokenCap({
        PAPERCLIP_COLD_WAKE_BRIEFING_TOKEN_CAP: "12345",
      }),
    ).toBe(12345);
  });

  it("falls back to the default when the env var is non-numeric", () => {
    expect(
      resolveColdWakeBriefingTokenCap({
        PAPERCLIP_COLD_WAKE_BRIEFING_TOKEN_CAP: "not-a-number",
      }),
    ).toBe(DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP);
  });

  it("falls back to the default when the env var is zero or negative", () => {
    expect(
      resolveColdWakeBriefingTokenCap({
        PAPERCLIP_COLD_WAKE_BRIEFING_TOKEN_CAP: "0",
      }),
    ).toBe(DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP);
    expect(
      resolveColdWakeBriefingTokenCap({
        PAPERCLIP_COLD_WAKE_BRIEFING_TOKEN_CAP: "-500",
      }),
    ).toBe(DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP);
  });
});

// ---------------------------------------------------------------------------
// estimateBriefingTokens
// ---------------------------------------------------------------------------

describe("estimateBriefingTokens", () => {
  it("returns a deterministic, positive token count for a fixture briefing", () => {
    const b = baseBriefing();
    const first = estimateBriefingTokens(b);
    const second = estimateBriefingTokens(b);
    expect(first).toBe(second);
    expect(first).toBeGreaterThan(0);
  });

  it("is monotonic in section size — adding content never lowers the estimate", () => {
    const small = baseBriefing();
    const big: ColdWakeBriefing = {
      ...small,
      recentRelatedComments: [
        makeComment({ createdAt: "2026-06-10T10:00:00Z", bodyChars: 200 }),
        makeComment({ createdAt: "2026-06-10T11:00:00Z", bodyChars: 200 }),
      ],
    };
    expect(estimateBriefingTokens(big)).toBeGreaterThan(
      estimateBriefingTokens(small),
    );
  });
});

// ---------------------------------------------------------------------------
// enforceBriefingBudget
// ---------------------------------------------------------------------------

describe("enforceBriefingBudget — under cap", () => {
  it("does not evict and reports truncated:false when the briefing already fits", () => {
    const briefing = baseBriefing();
    const sourcesBefore = [...briefing.sourcesIncluded];

    const out = enforceBriefingBudget(briefing);

    expect(out.truncated).toBe(false);
    expect(out.recentRelatedComments).toEqual(briefing.recentRelatedComments);
    expect(out.recentCommits).toEqual(briefing.recentCommits);
    expect(out.siblingInProgressIssues).toEqual(briefing.siblingInProgressIssues);
    expect(out.recentlyClosedReferencedIssues).toEqual(
      briefing.recentlyClosedReferencedIssues,
    );
    expect(out.sourcesIncluded).toEqual(sourcesBefore);
    expect(out.budgetTokenCap).toBe(DEFAULT_COLD_WAKE_BRIEFING_TOKEN_CAP);
    expect(out.budgetTokens).toBeGreaterThan(0);
    expect(out.budgetTokens).toBeLessThanOrEqual(out.budgetTokenCap);
  });
});

describe("enforceBriefingBudget — eviction order", () => {
  it("drops oldest comments first when only comments push us over cap", () => {
    // 5 comments × ~1100 chars body each (~ 1375 tokens of comments at /4) —
    // pushing the JSON over a small 600-token cap. Other sections stay tiny.
    const comments: ColdWakeRelatedComment[] = [
      makeComment({ createdAt: "2026-06-08T10:00:00Z", id: "oldest", bodyChars: 1100 }),
      makeComment({ createdAt: "2026-06-09T10:00:00Z", id: "older", bodyChars: 1100 }),
      makeComment({ createdAt: "2026-06-10T10:00:00Z", id: "mid", bodyChars: 1100 }),
      makeComment({ createdAt: "2026-06-11T10:00:00Z", id: "newer", bodyChars: 1100 }),
      makeComment({ createdAt: "2026-06-11T18:00:00Z", id: "newest", bodyChars: 1100 }),
    ];
    const briefing: ColdWakeBriefing = {
      ...baseBriefing(),
      recentRelatedComments: comments,
    };

    const cap = 600;
    const out = enforceBriefingBudget(briefing, { tokenCap: cap });

    expect(out.truncated).toBe(true);
    // The newest comment must still be present; the oldest must be gone.
    const survivingIds = out.recentRelatedComments.map((c) => c.commentId);
    expect(survivingIds).toContain("newest");
    expect(survivingIds).not.toContain("oldest");
    // sourcesIncluded marks comments as truncated; other sections untouched.
    expect(out.sourcesIncluded).toContain("comments:truncated");
    expect(out.sourcesIncluded).toContain("git");
    expect(out.sourcesIncluded).toContain("siblings");
    expect(out.sourcesIncluded).toContain("plan");
    expect(out.sourcesIncluded).toContain("interaction");
    expect(out.sourcesIncluded).toContain("closed_issues");
    // Protected fields untouched.
    expect(out.planDocument).toEqual(briefing.planDocument);
    expect(out.pendingRequestConfirmation).toEqual(briefing.pendingRequestConfirmation);
    expect(out.thresholdHours).toBe(briefing.thresholdHours);
    expect(out.hoursSinceLastRun).toBe(briefing.hoursSinceLastRun);
    expect(out.lastRunFinishedAt).toBe(briefing.lastRunFinishedAt);
    // Other content sections are untouched.
    expect(out.recentCommits).toEqual(briefing.recentCommits);
    expect(out.siblingInProgressIssues).toEqual(briefing.siblingInProgressIssues);
    expect(out.recentlyClosedReferencedIssues).toEqual(
      briefing.recentlyClosedReferencedIssues,
    );
  });

  it("cascades comments → commits → siblings → closed-issues in order", () => {
    // Roughly 10× cap: ~700 chars of padding per item across many items in
    // every section. Cap is tiny so even after evicting comments+commits we
    // still drop siblings down to top-3 and then closed-issues down to top-3.
    const comments: ColdWakeRelatedComment[] = Array.from({ length: 6 }, (_, i) =>
      makeComment({
        createdAt: `2026-06-0${i + 1}T10:00:00Z`,
        id: `cmt-${i}`,
        bodyChars: 600,
      }),
    );
    const commits: ColdWakeRecentCommit[] = Array.from({ length: 6 }, (_, i) =>
      makeCommit({
        date: `2026-06-0${i + 1}T12:00:00Z`,
        sha: `commit-${i}`,
        bodyChars: 600,
      }),
    );
    // 7 siblings — we expect 4 to be dropped down to top-3 by updatedAt DESC.
    const siblings: ColdWakeSiblingIssue[] = Array.from({ length: 7 }, (_, i) =>
      makeSibling({
        updatedAt: `2026-06-0${i + 1}T15:00:00Z`,
        id: `sib-${i}`,
      }),
    );
    // 7 closed — top 3 by closedAt DESC must survive.
    const closed: ColdWakeClosedIssue[] = Array.from({ length: 7 }, (_, i) =>
      makeClosed({
        closedAt: `2026-06-0${i + 1}T20:00:00Z`,
        id: `cls-${i}`,
      }),
    );

    const briefing: ColdWakeBriefing = {
      ...baseBriefing(),
      recentRelatedComments: comments,
      recentCommits: commits,
      siblingInProgressIssues: siblings,
      recentlyClosedReferencedIssues: closed,
    };

    // Aggressive cap — small enough that the cascade fully exhausts comments
    // and commits, and trims siblings + closed-issues down to top-3.
    const cap = 100;
    const out = enforceBriefingBudget(briefing, { tokenCap: cap });

    expect(out.truncated).toBe(true);

    // Comments and commits drain entirely; siblings and closed land on their
    // top-3 floor with the newest entries (sort by *At DESC) surviving.
    expect(out.recentRelatedComments).toEqual([]);
    expect(out.recentCommits).toEqual([]);

    expect(out.siblingInProgressIssues).toHaveLength(3);
    const siblingUpdates = out.siblingInProgressIssues
      .map((s) => s.updatedAt)
      .sort();
    // Top-3 by updatedAt DESC are 06-07, 06-06, 06-05; sorted ASC the first
    // entry is exactly the 3rd-newest input.
    expect(siblingUpdates[0]).toBe("2026-06-05T15:00:00Z");
    expect(siblingUpdates[2]).toBe("2026-06-07T15:00:00Z");

    expect(out.recentlyClosedReferencedIssues).toHaveLength(3);
    const closedAts = out.recentlyClosedReferencedIssues
      .map((c) => c.closedAt)
      .sort();
    expect(closedAts[0]).toBe("2026-06-05T20:00:00Z");
    expect(closedAts[2]).toBe("2026-06-07T20:00:00Z");

    // sourcesIncluded gets `:truncated` markers on every reduced section.
    const sources = new Set(out.sourcesIncluded);
    expect(sources.has("comments:truncated")).toBe(true);
    expect(sources.has("git:truncated")).toBe(true);
    expect(sources.has("siblings:truncated")).toBe(true);
    expect(sources.has("closed_issues:truncated")).toBe(true);
    // Protected sections are still listed plainly.
    expect(sources.has("plan")).toBe(true);
    expect(sources.has("interaction")).toBe(true);

    // Protected fields are byte-identical to input.
    expect(out.planDocument).toEqual(briefing.planDocument);
    expect(out.pendingRequestConfirmation).toEqual(briefing.pendingRequestConfirmation);
    expect(out.thresholdHours).toBe(briefing.thresholdHours);
    expect(out.hoursSinceLastRun).toBe(briefing.hoursSinceLastRun);
    expect(out.lastRunFinishedAt).toBe(briefing.lastRunFinishedAt);
  });
});

describe("enforceBriefingBudget — protected fields", () => {
  it("never mutates the staleness header, planDocument, or pendingRequestConfirmation", () => {
    // Pump the briefing past cap with a single huge comment so the eviction
    // loops have somewhere to chew, then verify the protected fields are
    // untouched.
    const briefing: ColdWakeBriefing = {
      ...baseBriefing(),
      recentRelatedComments: [
        makeComment({ createdAt: "2026-06-08T10:00:00Z", bodyChars: 10_000 }),
      ],
    };
    const out = enforceBriefingBudget(briefing, { tokenCap: 200 });

    expect(out.thresholdHours).toBe(briefing.thresholdHours);
    expect(out.hoursSinceLastRun).toBe(briefing.hoursSinceLastRun);
    expect(out.lastRunFinishedAt).toBe(briefing.lastRunFinishedAt);
    expect(out.planDocument).toEqual(briefing.planDocument);
    expect(out.pendingRequestConfirmation).toEqual(briefing.pendingRequestConfirmation);
    expect(out.truncated).toBe(true);
  });

  it("returns the briefing (not null) and sets truncated:true when only protected fields remain", () => {
    // Cap is impossibly small (10 tokens ≈ 40 chars) — well under even the
    // bare protected fields. Eviction empties every droppable section and we
    // still cannot fit; the guard must flag truncated:true but not throw.
    const briefing: ColdWakeBriefing = {
      ...baseBriefing(),
      recentRelatedComments: [
        makeComment({ createdAt: "2026-06-09T10:00:00Z", bodyChars: 50 }),
      ],
      recentCommits: [makeCommit({ date: "2026-06-09T12:00:00Z", bodyChars: 50 })],
      siblingInProgressIssues: [makeSibling({ updatedAt: "2026-06-10T15:00:00Z" })],
      recentlyClosedReferencedIssues: [makeClosed({ closedAt: "2026-06-10T20:00:00Z" })],
    };

    const out = enforceBriefingBudget(briefing, { tokenCap: 10 });

    expect(out).not.toBeNull();
    expect(out.truncated).toBe(true);
    // Protected fields survive.
    expect(out.planDocument).toEqual(briefing.planDocument);
    expect(out.pendingRequestConfirmation).toEqual(briefing.pendingRequestConfirmation);
    expect(out.thresholdHours).toBe(briefing.thresholdHours);
    expect(out.hoursSinceLastRun).toBe(briefing.hoursSinceLastRun);
    expect(out.lastRunFinishedAt).toBe(briefing.lastRunFinishedAt);
    // Comments and commits drained entirely; siblings/closed kept top-3 floor
    // (which equals the 1 input each, so they survive). The budget is still
    // over cap, but the briefing is returned intact.
    expect(out.recentRelatedComments).toEqual([]);
    expect(out.recentCommits).toEqual([]);
    expect(out.budgetTokens).toBeGreaterThan(out.budgetTokenCap);
  });
});
