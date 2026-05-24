import type { BriefCard, BriefCardState, BriefSummaryStatus, BriefTaskRow, BriefCardSource, BriefSnapshot } from "../../src/contracts.js";

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString(16).padStart(8, "0")}`;
}

export function resetFixtureIds(): void {
  counter = 0;
}

export function makeTaskRow(overrides: Partial<BriefTaskRow> = {}): BriefTaskRow {
  return {
    kind: "issue",
    sourceId: id("source"),
    issueId: id("issue"),
    identifier: "PAP-9963",
    titleLine: "Wire briefing page UI",
    rightTag: "in_progress",
    linkPath: "/PAP/issues/PAP-9963",
    isIntraTreeBlocked: null,
    eventAt: "2026-05-22T10:00:00.000Z",
    ...overrides,
  };
}

export function makeSource(overrides: Partial<BriefCardSource> = {}): BriefCardSource {
  return {
    id: id("src"),
    companyId: "company-1",
    userId: "user-1",
    cardId: "card-x",
    sourceKind: "issue",
    sourceId: id("source"),
    issueId: id("issue"),
    identifier: "PAP-9963",
    titleLine: "Wire briefing page UI",
    rightTag: "in_progress",
    linkPath: "/PAP/issues/PAP-9963",
    isIntraTreeBlocked: null,
    eventAt: "2026-05-22T10:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<BriefSnapshot> = {}): BriefSnapshot {
  return {
    id: id("snap"),
    companyId: "company-1",
    userId: "user-1",
    cardId: "card-x",
    summaryParagraph: "Briefing UI work is in flight; pin/unpin works and source rows link back to issues.",
    summaryStatus: "ok",
    summaryModel: "cheap-model",
    summaryTokensIn: 1200,
    summaryTokensOut: 220,
    summaryFailureReason: null,
    taskRows: [
      makeTaskRow({ identifier: "PAP-9963", titleLine: "Wire briefing page UI", rightTag: "in_progress" }),
      makeTaskRow({ identifier: "PAP-9961", titleLine: "Deterministic card service", rightTag: "done" }),
    ],
    evidenceSourceIds: [],
    generatedByAgentId: null,
    generatedByRunId: null,
    deterministicStateInputs: {},
    createdAt: "2026-05-22T10:00:00.000Z",
    ...overrides,
  };
}

export function makeCard(overrides: Partial<BriefCard> = {}): BriefCard {
  const snapshot = overrides.snapshot ?? makeSnapshot();
  const cardId = overrides.id ?? id("card");
  return {
    id: cardId,
    companyId: "company-1",
    userId: "user-1",
    slug: `card-${cardId}`,
    title: "Briefs plugin planning",
    groupingDescription: "Briefs plugin planning tree",
    rootIssueId: id("root"),
    state: "live" as BriefCardState,
    summaryStatus: "ok" as BriefSummaryStatus,
    pinned: false,
    hidden: false,
    staleAt: "2026-05-29T10:00:00.000Z",
    expiresAt: null,
    latestSnapshotId: snapshot.id,
    lastMeaningfulEventAt: "2026-05-22T10:00:00.000Z",
    snapshot: { ...snapshot, cardId },
    sources: [makeSource({ cardId }), makeSource({ cardId, identifier: "PAP-9961", titleLine: "Deterministic card service", rightTag: "done", linkPath: "/PAP/issues/PAP-9961" })],
    moreSourceCount: 0,
    ...overrides,
  };
}

export function gallery(): BriefCard[] {
  resetFixtureIds();
  const baseEvent = "2026-05-22T10:00:00.000Z";
  return [
    makeCard({
      title: "Briefs plugin planning",
      state: "live",
      pinned: true,
      lastMeaningfulEventAt: baseEvent,
      snapshot: makeSnapshot({
        summaryParagraph: "Phase 5 page UI in flight on PAP-9963; deterministic data is done and routines are paused for board approval.",
        taskRows: [
          makeTaskRow({ identifier: "PAP-9963", titleLine: "Wire briefing page UI", rightTag: "in_progress" }),
          makeTaskRow({ identifier: "PAP-9961", titleLine: "Deterministic card service", rightTag: "done" }),
          makeTaskRow({ identifier: "PAP-9962", titleLine: "Managed agent + routines", rightTag: "paused" }),
        ],
      }),
      moreSourceCount: 3,
    }),
    makeCard({
      title: "External-adapter plugin: spec review",
      state: "waiting-user",
      pinned: true,
      lastMeaningfulEventAt: "2026-05-21T13:00:00.000Z",
      snapshot: makeSnapshot({
        summaryParagraph: "External-adapter sandbox spec is waiting on your reply about credential scoping before publish.",
        taskRows: [
          makeTaskRow({ identifier: "PAP-9020", titleLine: "Confirm credential scoping", rightTag: "asked you", kind: "interaction", linkPath: "/PAP/issues/PAP-9020#interaction-1" }),
          makeTaskRow({ identifier: "PAP-9001", titleLine: "Adapter spec draft", rightTag: "in_review" }),
        ],
      }),
    }),
    makeCard({
      title: "Onboarding flow fixes",
      state: "blocked",
      lastMeaningfulEventAt: "2026-05-21T08:00:00.000Z",
      snapshot: makeSnapshot({
        summaryParagraph: "CEO copy decision is blocking the onboarding sign-up rewrite. No engineering action queued.",
        taskRows: [
          makeTaskRow({ identifier: "PAP-7710", titleLine: "Wait for CEO copy decision", rightTag: "blocked", isIntraTreeBlocked: false }),
          makeTaskRow({ identifier: "PAP-7702", titleLine: "Sign-up endpoint rewrite", rightTag: "todo" }),
        ],
      }),
      moreSourceCount: 2,
    }),
    makeCard({
      title: "Sandbox runner crash loop",
      state: "error",
      lastMeaningfulEventAt: "2026-05-22T09:48:00.000Z",
      snapshot: makeSnapshot({
        summaryParagraph: "Sandbox runner restarted 4× in the last hour; recovery action queued and the worker is paused.",
        taskRows: [
          makeTaskRow({ identifier: "PAP-8201", titleLine: "Recovery action: restart_clean", rightTag: "recovery", kind: "run", linkPath: "/PAP/runs/run-x" }),
          makeTaskRow({ identifier: "PAP-8201", titleLine: "Worker auto-paused", rightTag: "failed" }),
        ],
      }),
    }),
    makeCard({
      title: "Release readiness",
      state: "waiting-reviewer",
      lastMeaningfulEventAt: "2026-05-22T07:00:00.000Z",
      snapshot: makeSnapshot({
        summaryParagraph: "Release notes drafted; CTO review queued. CI is green and QA validation is done.",
        taskRows: [
          makeTaskRow({ identifier: "PAP-9410", titleLine: "Release sign-off", rightTag: "in_review", kind: "approval" }),
          makeTaskRow({ identifier: "PAP-9408", titleLine: "QA validation", rightTag: "done" }),
        ],
      }),
    }),
    makeCard({
      title: "Cost dashboard improvements",
      state: "live",
      summaryStatus: "fallback",
      lastMeaningfulEventAt: "2026-05-22T09:00:00.000Z",
      snapshot: makeSnapshot({
        summaryParagraph: null,
        summaryStatus: "fallback",
        summaryFailureReason: "budget_capped",
        taskRows: [
          makeTaskRow({ identifier: "PAP-8500", titleLine: "Wire cost chart filters", rightTag: "in_progress" }),
          makeTaskRow({ identifier: "PAP-8501", titleLine: "Cost CSV export", rightTag: "todo" }),
        ],
      }),
    }),
    makeCard({
      title: "Sidebar plugin slot hardening",
      state: "done",
      lastMeaningfulEventAt: "2026-05-21T22:00:00.000Z",
      snapshot: makeSnapshot({
        summaryParagraph: "Plugin sidebar slot order locked in; rolling tests green.",
        taskRows: [makeTaskRow({ identifier: "PAP-8990", titleLine: "Sidebar plugin slot hardening", rightTag: "done" })],
      }),
    }),
    makeCard({
      title: "GA migration spike",
      state: "stale",
      lastMeaningfulEventAt: "2026-05-11T08:00:00.000Z",
      snapshot: makeSnapshot({
        summaryParagraph: "Spike paused 11 days; reviewer paged but no follow-up activity.",
        taskRows: [makeTaskRow({ identifier: "PAP-7000", titleLine: "Investigate GA path", rightTag: "todo" })],
      }),
    }),
  ];
}
