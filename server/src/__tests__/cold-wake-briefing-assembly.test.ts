import { describe, expect, it } from "vitest";
import type {
  ColdWakeBriefing,
  ColdWakeClosedIssue,
  ColdWakeContextSnapshot,
  ColdWakePendingRequestConfirmation,
  ColdWakePlanDocument,
  ColdWakeRelatedComment,
  ColdWakeSectionRunners,
  ColdWakeSiblingIssue,
  RawGitCommit,
} from "../services/cold-wake-briefing.ts";
import {
  DEFAULT_HIBERNATION_THRESHOLD_HOURS,
  buildColdWakeBriefing,
} from "../services/cold-wake-briefing.ts";

// Centralised deterministic values. `now` and `lastRunFinishedAt` straddle
// the default 24h threshold so the detection result is unambiguously cold
// (or warm) without depending on the real clock.
const NOW = new Date("2026-06-11T20:00:00Z");
const HOT_LAST_RUN = new Date("2026-06-11T18:00:00Z"); // 2h ago — warm
const COLD_LAST_RUN = new Date("2026-06-08T20:00:00Z"); // 72h ago — cold

const COMPANY_ID = "00000000-0000-0000-0000-0000000000aa";
const AGENT_ID = "00000000-0000-0000-0000-0000000000bb";
const ISSUE_ID = "00000000-0000-0000-0000-0000000000cc";

const FAKE_COMMITS: RawGitCommit[] = [
  {
    sha: "deadbeef1111111111111111111111111111aaaa",
    subject: "feat(harness): touched referenced path",
    author: "Harness Engineer",
    date: "2026-06-10T12:00:00Z",
    files: ["server/src/services/cold-wake-briefing.ts"],
  },
  {
    sha: "deadbeef2222222222222222222222222222bbbb",
    subject: "chore: unrelated commit",
    author: "Other Agent",
    date: "2026-06-09T12:00:00Z",
    files: ["docs/README.md"],
  },
];

const FAKE_CLOSED_ISSUE: ColdWakeClosedIssue = {
  id: "00000000-0000-0000-0000-0000000000d1",
  identifier: "ALL-700",
  title: "Closed dependency",
  status: "done",
  closedAt: "2026-06-09T10:00:00Z",
};

const FAKE_SIBLING: ColdWakeSiblingIssue = {
  id: "00000000-0000-0000-0000-0000000000e1",
  identifier: "ALL-781",
  title: "Parent tracker",
  assigneeAgentId: AGENT_ID,
  updatedAt: "2026-06-11T19:30:00Z",
};

const FAKE_PLAN: ColdWakePlanDocument = {
  key: "plan",
  revisionId: "00000000-0000-0000-0000-0000000000f1",
  updatedAt: "2026-06-11T18:00:00Z",
};

const FAKE_INTERACTION: ColdWakePendingRequestConfirmation = {
  interactionId: "00000000-0000-0000-0000-00000000a111",
  revisionId: "00000000-0000-0000-0000-0000000000f1",
  createdAt: "2026-06-11T18:05:00Z",
};

const FAKE_COMMENT: ColdWakeRelatedComment = {
  issueId: "00000000-0000-0000-0000-0000000000d1",
  issueIdentifier: "ALL-700",
  commentId: "00000000-0000-0000-0000-00000000c111",
  authorType: "board_user",
  createdAt: "2026-06-11T17:00:00Z",
  bodyPreview: "Please pick up the next step.",
  bodyTruncated: false,
};

/** Defaults that pass through the input shape but return canned populated
 *  data when arguments imply a populated case. Tests compose against this
 *  by spreading and overriding individual runners. */
function populatedRunners(): Partial<ColdWakeSectionRunners> {
  return {
    detectColdWake: () => ({
      isColdWake: true,
      hoursSinceLastRun: 72,
      lastRunFinishedAt: COLD_LAST_RUN,
      thresholdHours: DEFAULT_HIBERNATION_THRESHOLD_HOURS,
    }),
    getLastSucceededRunFinishedAt: async () => COLD_LAST_RUN,
    readRecentCommits: async () => FAKE_COMMITS,
    loadClosedReferencedIssues: async ({ issueIds }) =>
      issueIds.length === 0 ? [] : [FAKE_CLOSED_ISSUE],
    loadSiblingInProgressIssues: async ({ assigneeAgentIds }) =>
      assigneeAgentIds.length === 0 ? [] : [FAKE_SIBLING],
    loadPlanDocument: async () => FAKE_PLAN,
    loadPendingRequestConfirmation: async () => FAKE_INTERACTION,
    loadRecentRelatedComments: async ({ outbound }) =>
      outbound.length === 0 ? [] : [FAKE_COMMENT],
  };
}

const REFERENCED_PATH = "server/src/services/cold-wake-briefing.ts";

const FULL_SNAPSHOT: ColdWakeContextSnapshot = {
  referencedIssueIdentifiers: [REFERENCED_PATH],
  relatedWork: {
    outbound: [
      { issue: { id: FAKE_CLOSED_ISSUE.id, identifier: FAKE_CLOSED_ISSUE.identifier } },
    ],
  },
  issueAncestry: {
    chainOfCommand: ["00000000-0000-0000-0000-000000000099"],
    ancestorIssueIds: ["00000000-0000-0000-0000-0000000000aa"],
  },
};

// The `db` field is unused when every section runner is overridden — pass a
// typed sentinel so the test does not have to spin up an embedded Postgres.
const FAKE_DB = {} as unknown as Parameters<typeof buildColdWakeBriefing>[0]["db"];

async function callBuild(
  overrides: Partial<ColdWakeSectionRunners>,
  opts: { snapshot?: ColdWakeContextSnapshot; workspaceCwd?: string | null } = {},
): Promise<ColdWakeBriefing | null> {
  return buildColdWakeBriefing({
    db: FAKE_DB,
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    issueId: ISSUE_ID,
    contextSnapshot: opts.snapshot ?? FULL_SNAPSHOT,
    workspaceCwd: opts.workspaceCwd === undefined ? "/tmp/workspace" : opts.workspaceCwd,
    now: NOW,
    __overrides: overrides,
  });
}

describe("buildColdWakeBriefing", () => {
  it("returns null on a warm wake (detectColdWake → isColdWake: false)", async () => {
    const result = await callBuild({
      // Warm — the assembler should short-circuit before any section runs.
      detectColdWake: () => ({
        isColdWake: false,
        hoursSinceLastRun: 2,
        lastRunFinishedAt: HOT_LAST_RUN,
        thresholdHours: DEFAULT_HIBERNATION_THRESHOLD_HOURS,
      }),
      getLastSucceededRunFinishedAt: async () => HOT_LAST_RUN,
      // If any of the section runners were invoked, the test would fail at
      // this rejection; their non-invocation proves the short-circuit.
      readRecentCommits: async () => {
        throw new Error("section ran on warm wake");
      },
      loadClosedReferencedIssues: async () => {
        throw new Error("section ran on warm wake");
      },
      loadSiblingInProgressIssues: async () => {
        throw new Error("section ran on warm wake");
      },
      loadPlanDocument: async () => {
        throw new Error("section ran on warm wake");
      },
      loadPendingRequestConfirmation: async () => {
        throw new Error("section ran on warm wake");
      },
      loadRecentRelatedComments: async () => {
        throw new Error("section ran on warm wake");
      },
    });

    expect(result).toBeNull();
  });

  it("populates all five sections on a cold wake with every source present", async () => {
    const briefing = await callBuild(populatedRunners());

    expect(briefing).not.toBeNull();
    const b = briefing as ColdWakeBriefing;

    // Detection metadata round-trips through the briefing.
    expect(b.thresholdHours).toBe(DEFAULT_HIBERNATION_THRESHOLD_HOURS);
    expect(b.hoursSinceLastRun).toBe(72);
    expect(b.lastRunFinishedAt).toBe(COLD_LAST_RUN.toISOString());

    // Section 1 — recent commits, with touchedReferencedPath set on the
    // commit that touched the referenced path.
    expect(b.recentCommits).toHaveLength(2);
    expect(b.recentCommits[0]).toMatchObject({
      sha: FAKE_COMMITS[0]!.sha,
      touchedReferencedPath: true,
    });
    expect(b.recentCommits[1]).toMatchObject({
      sha: FAKE_COMMITS[1]!.sha,
      touchedReferencedPath: false,
    });
    expect(b.recentCommitsTruncated).toBe(false);

    // Sections 2–5 round-trip the canned values.
    expect(b.recentlyClosedReferencedIssues).toEqual([FAKE_CLOSED_ISSUE]);
    expect(b.siblingInProgressIssues).toEqual([FAKE_SIBLING]);
    expect(b.planDocument).toEqual(FAKE_PLAN);
    expect(b.pendingRequestConfirmation).toEqual(FAKE_INTERACTION);
    expect(b.recentRelatedComments).toEqual([FAKE_COMMENT]);

    // sourcesIncluded covers all six keys (six because plan + interaction
    // are tracked separately even though §3.2 groups them under "section 4").
    expect(new Set(b.sourcesIncluded)).toEqual(
      new Set(["git", "closed_issues", "siblings", "plan", "interaction", "comments"]),
    );

    expect(b.briefingError).toBeNull();
    // Step 4's budget guard runs at the end of buildColdWakeBriefing — the
    // populated briefing is well under the default 8000-token cap so it
    // round-trips unmodified, but `budgetTokens` now reflects the real
    // estimate rather than the step-3 placeholder zero.
    expect(b.budgetTokens).toBeGreaterThan(0);
    expect(b.budgetTokenCap).toBeGreaterThan(0);
    expect(b.budgetTokens).toBeLessThanOrEqual(b.budgetTokenCap);
    expect(b.truncated).toBe(false);
  });

  it("degrades the git section when simpleGit throws (workspace not cloned)", async () => {
    const briefing = await callBuild({
      ...populatedRunners(),
      readRecentCommits: async () => {
        throw new Error("ENOENT: no .git directory");
      },
    });

    expect(briefing).not.toBeNull();
    const b = briefing as ColdWakeBriefing;

    expect(b.recentCommits).toEqual([]);
    expect(b.recentCommitsTruncated).toBe(false);
    expect(b.sourcesIncluded).not.toContain("git");
    // The other sections still populated normally.
    expect(b.sourcesIncluded).toEqual(
      expect.arrayContaining([
        "closed_issues",
        "siblings",
        "plan",
        "interaction",
        "comments",
      ]),
    );
    expect(b.recentlyClosedReferencedIssues).toEqual([FAKE_CLOSED_ISSUE]);
    expect(b.recentRelatedComments).toEqual([FAKE_COMMENT]);
    // Per-section catch absorbs the failure — top-level error stays null.
    expect(b.briefingError).toBeNull();
  });

  it("returns empty section 2 and 5 when contextSnapshot has no relatedWork.outbound", async () => {
    const snapshot: ColdWakeContextSnapshot = {
      referencedIssueIdentifiers: [REFERENCED_PATH],
      relatedWork: { outbound: [] },
      issueAncestry: { chainOfCommand: [], ancestorIssueIds: [] },
    };

    const briefing = await callBuild(populatedRunners(), { snapshot });

    expect(briefing).not.toBeNull();
    const b = briefing as ColdWakeBriefing;

    expect(b.recentlyClosedReferencedIssues).toEqual([]);
    expect(b.recentRelatedComments).toEqual([]);
    // Both sections succeeded with empty output — keep them in sourcesIncluded
    // so downstream renderers can distinguish "no data" from "errored".
    expect(b.sourcesIncluded).toEqual(
      expect.arrayContaining(["closed_issues", "comments"]),
    );
    // Sections 1, 3, 4 unaffected.
    expect(b.recentCommits).toHaveLength(2);
    expect(b.siblingInProgressIssues).toEqual([FAKE_SIBLING]);
    expect(b.planDocument).toEqual(FAKE_PLAN);
    expect(b.pendingRequestConfirmation).toEqual(FAKE_INTERACTION);
    expect(b.briefingError).toBeNull();
  });

  it("marks briefingError.code='all_sections_failed' when every section throws", async () => {
    const throwingRunners: Partial<ColdWakeSectionRunners> = {
      detectColdWake: populatedRunners().detectColdWake,
      getLastSucceededRunFinishedAt: populatedRunners().getLastSucceededRunFinishedAt,
      readRecentCommits: async () => {
        throw new Error("git boom");
      },
      loadClosedReferencedIssues: async () => {
        throw new Error("closed boom");
      },
      loadSiblingInProgressIssues: async () => {
        throw new Error("siblings boom");
      },
      loadPlanDocument: async () => {
        throw new Error("plan boom");
      },
      loadPendingRequestConfirmation: async () => {
        throw new Error("interaction boom");
      },
      loadRecentRelatedComments: async () => {
        throw new Error("comments boom");
      },
    };

    const briefing = await callBuild(throwingRunners);

    expect(briefing).not.toBeNull();
    const b = briefing as ColdWakeBriefing;

    // Every section degrades to its empty default.
    expect(b.recentCommits).toEqual([]);
    expect(b.recentlyClosedReferencedIssues).toEqual([]);
    expect(b.siblingInProgressIssues).toEqual([]);
    expect(b.planDocument).toBeNull();
    expect(b.pendingRequestConfirmation).toBeNull();
    expect(b.recentRelatedComments).toEqual([]);
    expect(b.sourcesIncluded).toEqual([]);

    expect(b.briefingError).not.toBeNull();
    expect(b.briefingError?.code).toBe("all_sections_failed");
    expect(b.briefingError?.message.length).toBeGreaterThan(0);
    // The aggregated message should reference each failing section by key
    // so the operator can trace which section blew up.
    expect(b.briefingError?.message).toContain("git");
    expect(b.briefingError?.message).toContain("comments");
  });
});
