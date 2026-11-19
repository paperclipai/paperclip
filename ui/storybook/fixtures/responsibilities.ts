import {
  RESPONSIBILITY_AUTOMATION_LEVELS,
  RESPONSIBILITY_AUTOMATION_RECENT_DAYS,
  automationCandidateReason,
  automationHintForTask,
  responsibilityAutomationLevel,
  responsibilityAutomationShare,
  type AutomationCandidate,
  type AutomationStart,
  type ResponsibilityAutomation,
  type ResponsibilityAutomationItem,
  type ResponsibilityAutomationLevel,
  type ResponsibilityAutomationOverview,
  type ResponsibilityAutomationStalled,
} from "@paperclipai/shared";
import type {
  CompanyArtifact,
  Responsibility,
  ResponsibilityArea,
  ResponsibilityDetail,
  ResponsibilityHealth,
  ResponsibilityLooseWork,
  ResponsibilityMetricSummary,
  ResponsibilityOverview,
  ResponsibilityOverviewArea,
  ResponsibilityRollup,
  ResponsibilitySummary,
  ResponsibilityWithRollup,
  ResponsibilityWorkSignal,
} from "@paperclipai/shared";

/** Synthetic responsibilities, areas and work for stories and UI tests. */
export const RESPONSIBILITY_FIXTURE_COMPANY_ID = "company-storybook";
export const RESPONSIBILITY_FIXTURE_OWNER_ID = "user-storybook";
export const RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID = "agent-cto";
/** "Today" for fixtures: readings older than 14 days before this are stale. */
export const RESPONSIBILITY_FIXTURE_NOW = new Date("2026-11-13T12:00:00Z");

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export function areaFixture(overrides: Partial<ResponsibilityArea> & Pick<ResponsibilityArea, "id" | "title">): ResponsibilityArea {
  return {
    companyId: RESPONSIBILITY_FIXTURE_COMPANY_ID,
    description: null,
    status: "active",
    source: "manual",
    proposedByAgentId: null,
    sortOrder: 0,
    createdAt: new Date("2026-11-01T09:00:00Z"),
    updatedAt: new Date("2026-11-01T09:00:00Z"),
    ...overrides,
  };
}

export const areaFundraising = areaFixture({ id: "area-fundraising", title: "Fundraising", sortOrder: 0 });
export const areaPortfolio = areaFixture({ id: "area-portfolio", title: "Portfolio", sortOrder: 1 });
export const areaTeam = areaFixture({ id: "area-team", title: "Team", sortOrder: 2 });
/** Active, but this person owns nothing in it. */
export const areaLegal = areaFixture({ id: "area-legal", title: "Legal", sortOrder: 3 });
/** Proposed with the onboarding draft; confirming a responsibility in it activates it. */
export const areaDealFlow = areaFixture({
  id: "area-deal-flow",
  title: "Deal flow",
  status: "proposed",
  source: "onboarding",
  proposedByAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  sortOrder: 4,
});

// ---------------------------------------------------------------------------
// Responsibilities
// ---------------------------------------------------------------------------

export function metricFixture(overrides: Partial<ResponsibilityMetricSummary> = {}): ResponsibilityMetricSummary {
  return {
    kind: overrides.unit === "%" ? "percentage" : "volume",
    name: "Investors contacted",
    unit: null,
    target: 20,
    low: null,
    high: null,
    current: null,
    direction: "at_least",
    attainment: null,
    statusRule: null,
    updatedAt: null,
    stale: false,
    ...overrides,
  };
}

export function responsibilityRollup(overrides: Partial<ResponsibilityRollup> = {}): ResponsibilityRollup {
  return {
    health: "not_measured",
    computedHealth: overrides.health ?? "not_measured",
    healthOverridden: false,
    metric: null,
    statusSentence: "Not measured: no metric is set",
    workSummary: [],
    projects: 0,
    routines: 0,
    openTasks: 0,
    blockedTasks: 0,
    agentTasks: 0,
    userTasks: 0,
    doneTasks: 0,
    nextDueAt: null,
    overdueProjects: [],
    ...overrides,
  };
}

export function responsibilityFixture(
  overrides: Partial<Omit<ResponsibilityWithRollup, "rollup">> & { rollup?: Partial<ResponsibilityRollup> } = {},
): ResponsibilityWithRollup {
  const { rollup, ...rest } = overrides;
  return {
    id: "resp-fundraising",
    companyId: RESPONSIBILITY_FIXTURE_COMPANY_ID,
    ownerUserId: RESPONSIBILITY_FIXTURE_OWNER_ID,
    areaId: null,
    metricKind: rest.metricUnit === "%" ? "percentage" : "volume",
    metricName: null,
    metricUnit: null,
    metricTarget: null,
    metricLow: null,
    metricHigh: null,
    metricCurrent: null,
    metricDirection: "at_least",
    metricUpdatedAt: null,
    runByAgentId: null,
    title: "Seed extension",
    description: null,
    standard: null,
    status: "active",
    source: "manual",
    evidence: null,
    healthOverride: null,
    healthNote: null,
    sortOrder: 0,
    proposedByAgentId: null,
    confirmedAt: new Date("2026-11-11T09:00:00Z"),
    createdAt: new Date("2026-11-01T09:00:00Z"),
    updatedAt: new Date("2026-11-11T09:00:00Z"),
    ...rest,
    rollup: responsibilityRollup(rollup),
  };
}

/** Behind: 9 of 20 investors contacted, a late project and a blocked task; an agent runs it. */
export const fundraisingBehind = responsibilityFixture({
  areaId: areaFundraising.id,
  title: "Seed extension",
  description: "Raise the seed extension and keep investors informed.",
  standard: "Twenty qualified investors contacted before the partner meeting in December.",
  metricName: "Investors contacted",
  metricTarget: 20,
  metricCurrent: 9,
  metricUpdatedAt: new Date("2026-11-12T08:00:00Z"),
  runByAgentId: "agent-codex",
  source: "onboarding",
  proposedByAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  rollup: {
    health: "behind",
    computedHealth: "behind",
    metric: metricFixture({ current: 9, attainment: 0.45, updatedAt: new Date("2026-11-12T08:00:00Z") }),
    statusSentence: "9 of 20 investors contacted, 45% of target",
    workSummary: [
      { kind: "project_late", tone: "attention", text: "Investor update deck is 3 days past its target date", refType: "project", refId: "project-deck", count: 1 },
      { kind: "task_blocked", tone: "attention", text: "Get the cap table from counsel is blocked", refType: "issue", refId: "task-blocked", count: 1 },
      { kind: "tasks_open_agent", tone: "neutral", text: "2 open tasks with CodexCoder", refType: "agent", refId: "agent-codex", count: 2 },
      { kind: "tasks_open_person", tone: "neutral", text: "2 open tasks with Riley Board", refType: "user", refId: RESPONSIBILITY_FIXTURE_OWNER_ID, count: 2 },
      { kind: "routine_active", tone: "good", text: "Weekly investor pipeline review is active, last run succeeded on 2026-11-10, next run 2026-11-17", refType: "routine", refId: "routine-weekly", count: 1 },
    ],
    projects: 2,
    routines: 1,
    openTasks: 4,
    blockedTasks: 1,
    agentTasks: 2,
    userTasks: 2,
    doneTasks: 1,
    nextDueAt: "2026-11-10",
    overdueProjects: [{ id: "project-deck", name: "Investor update deck", targetDate: "2026-11-10", daysOverdue: 3 }],
  },
});

/** At risk and stale: a lower-is-better number nobody has updated in 19 days. */
export const lpUpdatesStale = responsibilityFixture({
  id: "resp-lp-updates",
  areaId: areaFundraising.id,
  title: "LP updates",
  standard: "Every LP hears from us at least once a month.",
  metricName: "Days since the last LP letter",
  metricUnit: "days",
  metricTarget: 30,
  metricCurrent: 36,
  metricDirection: "at_most",
  metricUpdatedAt: new Date("2026-10-25T09:00:00Z"),
  sortOrder: 1,
  rollup: {
    health: "at_risk",
    computedHealth: "at_risk",
    metric: metricFixture({
      name: "Days since the last LP letter",
      unit: "days",
      target: 30,
      current: 36,
      direction: "at_most",
      attainment: 0.8333,
      updatedAt: new Date("2026-10-25T09:00:00Z"),
      stale: true,
    }),
    statusSentence: "Days since the last LP letter: 36 days against a target of at most 30 days",
    workSummary: [
      { kind: "metric_stale", tone: "attention", text: "Days since the last LP letter was last updated 19 days ago", refType: "responsibility", refId: "resp-lp-updates", count: 1 },
      { kind: "tasks_open_unassigned", tone: "neutral", text: "1 open task not assigned to anyone", refType: null, refId: null, count: 1 },
    ],
    openTasks: 1,
    userTasks: 1,
  },
});

/** On track, run by an agent, with a routine doing the work. */
export const portfolioOnTrack = responsibilityFixture({
  id: "resp-portfolio",
  areaId: areaPortfolio.id,
  title: "Founder support",
  description: "Support the companies we have invested in.",
  standard: "Every portfolio founder gets a check-in each month.",
  metricName: "Founder check-ins this month",
  metricTarget: 8,
  metricCurrent: 9,
  metricUpdatedAt: new Date("2026-11-12T16:00:00Z"),
  runByAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  source: "onboarding",
  proposedByAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  sortOrder: 2,
  rollup: {
    health: "on_track",
    computedHealth: "on_track",
    metric: metricFixture({ name: "Founder check-ins this month", target: 8, current: 9, attainment: 1.125, updatedAt: new Date("2026-11-12T16:00:00Z") }),
    statusSentence: "9 of 8 founder check-ins this month, 113% of target",
    workSummary: [
      { kind: "tasks_open_agent", tone: "neutral", text: "3 open tasks with CTO", refType: "agent", refId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, count: 3 },
      { kind: "tasks_completed_recently", tone: "good", text: "5 tasks completed in the last 7 days", refType: null, refId: null, count: 5 },
      { kind: "routine_active", tone: "good", text: "Monthly founder check-in is active, next run 2026-12-01", refType: "routine", refId: "routine-checkin", count: 1 },
    ],
    projects: 1,
    routines: 1,
    openTasks: 3,
    agentTasks: 3,
    doneTasks: 12,
    nextDueAt: "2026-12-02",
  },
});

/** Not measured: the bar and target are set, but nobody has reported a reading yet. */
export const hiringNotMeasured = responsibilityFixture({
  id: "resp-hiring",
  areaId: areaTeam.id,
  title: "Hiring",
  standard: "Two senior engineers have accepted offers by the end of the quarter.",
  metricName: "Offers accepted",
  metricTarget: 2,
  sortOrder: 3,
  rollup: {
    health: "not_measured",
    computedHealth: "not_measured",
    metric: metricFixture({ name: "Offers accepted", target: 2 }),
    statusSentence: "Not measured yet: no reading of offers accepted against a target of 2",
  },
});

/** The number says on track, but the owner marked it at risk with a note. No area. */
export const boardReportingOverridden = responsibilityFixture({
  id: "resp-board-reporting",
  areaId: null,
  title: "Board reporting",
  standard: "The board gets its deck a week before every meeting.",
  metricName: "Decks sent on time this year",
  metricTarget: 4,
  metricCurrent: 4,
  metricUpdatedAt: new Date("2026-11-03T10:00:00Z"),
  healthOverride: "at_risk",
  healthNote: "The Q4 deck depends on numbers finance has not closed yet.",
  sortOrder: 4,
  rollup: {
    health: "at_risk",
    computedHealth: "on_track",
    healthOverridden: true,
    metric: metricFixture({ name: "Decks sent on time this year", target: 4, current: 4, attainment: 1, updatedAt: new Date("2026-11-03T10:00:00Z") }),
    statusSentence: "4 of 4 decks sent on time this year, 100% of target",
    workSummary: [
      { kind: "project_due_soon", tone: "neutral", text: "Q4 board deck is due in 5 days", refType: "project", refId: "project-q4-deck", count: 1 },
    ],
    projects: 1,
    openTasks: 2,
    userTasks: 2,
    nextDueAt: "2026-11-18",
  },
});

/** Kept as a name older tests use: the not-measured responsibility. */
export const hiringEmpty = hiringNotMeasured;

export const proposedDealFlow = responsibilityFixture({
  id: "resp-deal-flow",
  areaId: areaDealFlow.id,
  title: "Sourcing",
  description: "Source and screen new investments.",
  standard: "Every promising founder gets a first meeting within two weeks.",
  metricName: "First meetings booked",
  metricTarget: 12,
  status: "proposed",
  source: "onboarding",
  evidence: "Most of your recent email threads are first meetings with founders.",
  proposedByAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  confirmedAt: null,
  rollup: {
    metric: metricFixture({ name: "First meetings booked", target: 12 }),
    statusSentence: "Not measured yet: no reading of first meetings booked against a target of 12",
  },
});

export const proposedLpRelations = responsibilityFixture({
  id: "resp-lp-relations",
  areaId: areaFundraising.id,
  title: "LP relations",
  description: "Quarterly letters and LP questions.",
  standard: "LP questions get an answer within two working days.",
  metricName: "Reply time",
  metricUnit: "days",
  metricTarget: 2,
  metricCurrent: 3,
  metricDirection: "at_most",
  status: "proposed",
  source: "onboarding",
  evidence: "You send a quarterly letter and answer LP questions in a shared inbox.",
  proposedByAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  confirmedAt: null,
  rollup: {
    health: "at_risk",
    computedHealth: "at_risk",
    metric: metricFixture({ name: "Reply time", unit: "days", target: 2, current: 3, direction: "at_most", attainment: 0.6667 }),
    statusSentence: "Reply time: 3 days against a target of at most 2 days",
  },
});

/** A proposal from before metrics existed: no bar, no metric, no target. */
export const proposedWithoutBar = responsibilityFixture({
  id: "resp-brand",
  areaId: null,
  title: "Brand",
  status: "proposed",
  source: "onboarding",
  evidence: "You approve every post on the company accounts.",
  proposedByAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  confirmedAt: null,
});

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export const looseWorkFixture: ResponsibilityLooseWork = {
  projectCount: 1,
  openTaskCount: 57,
  routineCount: 1,
  projects: [
    { id: "project-offsite", name: "Team offsite", status: "planned", targetDate: "2026-12-04", leadAgentId: null, archivedAt: null },
  ],
  tasks: [
    { id: "task-expenses", identifier: "PAP-88", title: "Submit October expenses", status: "todo", assigneeAgentId: null, assigneeUserId: RESPONSIBILITY_FIXTURE_OWNER_ID, projectId: null, updatedAt: new Date("2026-11-12T10:00:00Z") },
    { id: "task-laptop", identifier: "PAP-87", title: "Order a laptop for the new designer", status: "in_progress", assigneeAgentId: "agent-qa", assigneeUserId: null, projectId: null, updatedAt: new Date("2026-11-11T10:00:00Z") },
    { id: "task-visa", identifier: "PAP-85", title: "Renew the conference visa letter", status: "todo", assigneeAgentId: null, assigneeUserId: null, projectId: null, updatedAt: new Date("2026-11-08T10:00:00Z") },
  ],
  routines: [
    { id: "routine-standup", title: "Daily standup notes", status: "active", assigneeAgentId: "agent-qa", projectId: null },
  ],
};

export const EMPTY_LOOSE_WORK: ResponsibilityLooseWork = {
  projectCount: 0,
  openTaskCount: 0,
  routineCount: 0,
  projects: [],
  tasks: [],
  routines: [],
};

export const ALL_FIXTURE_AREAS: readonly ResponsibilityArea[] = [areaFundraising, areaPortfolio, areaTeam, areaLegal, areaDealFlow];

/**
 * An overview as the server returns it: every active area, plus any other
 * area a listed responsibility is filed under, with per-area counts.
 */
export function responsibilityOverviewFixture(
  responsibilities: ResponsibilityWithRollup[],
  proposed: ResponsibilityWithRollup[] = [],
  options: { loose?: ResponsibilityLooseWork; areas?: readonly ResponsibilityArea[] } = {},
): ResponsibilityOverview {
  const emptyByHealth = (): Record<ResponsibilityHealth, number> => ({ behind: 0, at_risk: 0, on_track: 0, not_measured: 0 });
  const byHealth = emptyByHealth();
  let openTasks = 0;
  let agentTasks = 0;
  let userTasks = 0;
  let blockedTasks = 0;
  let projects = 0;
  let lateProjects = 0;
  const perArea = new Map<string, { activeResponsibilities: number; byHealth: Record<ResponsibilityHealth, number> }>();
  for (const item of responsibilities) {
    if (item.status !== "active") continue;
    byHealth[item.rollup.health] += 1;
    openTasks += item.rollup.openTasks;
    agentTasks += item.rollup.agentTasks;
    userTasks += item.rollup.userTasks;
    blockedTasks += item.rollup.blockedTasks;
    projects += item.rollup.projects;
    lateProjects += item.rollup.overdueProjects.length;
    if (item.areaId) {
      const entry = perArea.get(item.areaId) ?? { activeResponsibilities: 0, byHealth: emptyByHealth() };
      entry.activeResponsibilities += 1;
      entry.byHealth[item.rollup.health] += 1;
      perArea.set(item.areaId, entry);
    }
  }
  const referenced = new Set([...responsibilities, ...proposed].map((item) => item.areaId).filter(Boolean));
  const areas: ResponsibilityOverviewArea[] = (options.areas ?? ALL_FIXTURE_AREAS)
    .filter((area) => area.status === "active" || referenced.has(area.id))
    .map((area) => ({ ...area, ...(perArea.get(area.id) ?? { activeResponsibilities: 0, byHealth: emptyByHealth() }) }));
  return {
    ownerUserId: RESPONSIBILITY_FIXTURE_OWNER_ID,
    areas,
    responsibilities,
    proposed,
    totals: { byHealth, openTasks, agentTasks, userTasks, blockedTasks, projects, lateProjects },
    loose: options.loose ?? EMPTY_LOOSE_WORK,
  };
}

/** The home page with one responsibility in each status, an override and a stale number. */
export const homeOverviewFixture = responsibilityOverviewFixture(
  [fundraisingBehind, lpUpdatesStale, portfolioOnTrack, hiringNotMeasured, boardReportingOverridden],
  [],
  { loose: looseWorkFixture },
);

// ---------------------------------------------------------------------------
// Responsibility detail
// ---------------------------------------------------------------------------

function artifactFixture(overrides: Partial<CompanyArtifact> & Pick<CompanyArtifact, "id" | "title">): CompanyArtifact {
  return {
    source: "document",
    mediaKind: "document",
    previewText: null,
    contentType: "text/markdown",
    contentPath: null,
    openPath: null,
    downloadPath: null,
    issue: { id: "task-draft", identifier: "PAP-42", title: "Draft the November investor update" },
    project: null,
    createdByAgent: { id: "agent-codex", name: "CodexCoder" },
    updatedAt: "2026-11-12T09:00:00.000Z",
    href: "/issues/PAP-42#document-update",
    ...overrides,
  };
}

/** Wraps a responsibility as its detail, with no work, skills or artifacts unless given. */
export function responsibilityDetailFixture(
  base: ResponsibilityWithRollup,
  overrides: Partial<Omit<ResponsibilityDetail, keyof ResponsibilityWithRollup>> = {},
): ResponsibilityDetail {
  const area = ALL_FIXTURE_AREAS.find((candidate) => candidate.id === base.areaId);
  return {
    ...base,
    area: area ? { id: area.id, title: area.title, status: area.status } : null,
    skills: [],
    artifacts: [],
    artifactsTotal: 0,
    artifactsTruncated: false,
    projects: [],
    tasks: [],
    tasksTruncated: false,
    routines: [],
    ...overrides,
  };
}

export const fundraisingDetail: ResponsibilityDetail = responsibilityDetailFixture(fundraisingBehind, {
  skills: [
    {
      id: "skill-investor-research",
      key: "paperclip/investor-research",
      slug: "investor-research",
      name: "Investor research",
      description: "Finds and qualifies investors that match a round.",
      tagline: "Qualify investors for a round",
      iconUrl: null,
      color: null,
      agentIds: ["agent-codex", RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID],
    },
    {
      id: "skill-deck-builder",
      key: "paperclip/deck-builder",
      slug: "deck-builder",
      name: "Deck builder",
      description: "Drafts and updates slide decks from a brief.",
      tagline: null,
      iconUrl: null,
      color: null,
      agentIds: ["agent-codex"],
    },
  ],
  artifacts: [
    artifactFixture({ id: "artifact-update", title: "November investor update", previewText: "Highlights: two new design partners, runway to Q3…" }),
    artifactFixture({
      id: "artifact-pipeline",
      title: "investor-pipeline.csv",
      source: "attachment",
      mediaKind: "file",
      contentType: "text/csv",
      issue: { id: "task-intro", identifier: "PAP-43", title: "Ask Dana for an intro to the lead" },
      href: "/issues/PAP-43#attachment-pipeline",
      updatedAt: "2026-11-10T09:00:00.000Z",
    }),
    artifactFixture({
      id: "artifact-memo",
      title: "Round terms memo",
      issue: { id: "task-done", identifier: "PAP-30", title: "Send the October update" },
      href: "/issues/PAP-30#document-terms",
      updatedAt: "2026-10-31T09:00:00.000Z",
    }),
  ],
  artifactsTotal: 63,
  artifactsTruncated: true,
  projects: [
    { linkId: "link-project-deck", id: "project-deck", name: "Investor update deck", status: "in_progress", targetDate: "2026-11-10", leadAgentId: "agent-codex", archivedAt: null, progress: { done: 2, total: 5 } },
    { linkId: "link-project-pipeline", id: "project-pipeline", name: "Lead investor pipeline", status: "planned", targetDate: "2026-12-15", leadAgentId: null, archivedAt: null, progress: null },
  ],
  tasks: [
    { id: "task-blocked", identifier: "PAP-41", title: "Get the cap table from counsel", status: "blocked", assigneeAgentId: null, assigneeUserId: RESPONSIBILITY_FIXTURE_OWNER_ID, projectId: "project-deck", membership: "project", linkId: null, updatedAt: new Date("2026-11-10T12:00:00Z") },
    { id: "task-draft", identifier: "PAP-42", title: "Draft the November investor update", status: "in_progress", assigneeAgentId: "agent-codex", assigneeUserId: null, projectId: null, membership: "direct", linkId: "link-task-draft", updatedAt: new Date("2026-11-11T08:00:00Z") },
    { id: "task-intro", identifier: "PAP-43", title: "Ask Dana for an intro to the lead", status: "todo", assigneeAgentId: null, assigneeUserId: RESPONSIBILITY_FIXTURE_OWNER_ID, projectId: null, membership: "direct", linkId: "link-task-intro", updatedAt: new Date("2026-11-09T08:00:00Z") },
    { id: "task-done", identifier: "PAP-30", title: "Send the October update", status: "done", assigneeAgentId: "agent-codex", assigneeUserId: null, projectId: null, membership: "direct", linkId: "link-task-done", updatedAt: new Date("2026-10-31T08:00:00Z") },
  ],
  routines: [
    { linkId: "link-routine-weekly", membership: "direct", id: "routine-weekly", title: "Weekly investor pipeline review", status: "active", assigneeAgentId: "agent-codex", projectId: null, lastRun: { outcome: "succeeded", at: new Date("2026-11-13T04:00:00Z") } },
  ],
});

export const lpUpdatesDetail = responsibilityDetailFixture(lpUpdatesStale, {
  tasks: [
    { id: "task-letter", identifier: "PAP-50", title: "Write the November LP letter", status: "todo", assigneeAgentId: null, assigneeUserId: null, projectId: null, membership: "direct", linkId: "link-task-letter", updatedAt: new Date("2026-11-01T08:00:00Z") },
  ],
});

export const portfolioDetail = responsibilityDetailFixture(portfolioOnTrack, {
  routines: [
    { linkId: "link-routine-checkin", membership: "direct", id: "routine-checkin", title: "Monthly founder check-in", status: "active", assigneeAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, projectId: null, lastRun: null },
  ],
});

/** Nothing under it yet: every section shows what belongs there. */
export const hiringDetail = responsibilityDetailFixture(hiringNotMeasured);

export const boardReportingDetail = responsibilityDetailFixture(boardReportingOverridden, {
  projects: [
    { linkId: "link-project-q4", id: "project-q4-deck", name: "Q4 board deck", status: "in_progress", targetDate: "2026-11-18", leadAgentId: null, archivedAt: null, progress: null },
  ],
});

export const RESPONSIBILITY_DETAIL_FIXTURES: Record<string, ResponsibilityDetail> = {
  [fundraisingDetail.id]: fundraisingDetail,
  [lpUpdatesDetail.id]: lpUpdatesDetail,
  [portfolioDetail.id]: portfolioDetail,
  [hiringDetail.id]: hiringDetail,
  [boardReportingDetail.id]: boardReportingDetail,
};

// ---------------------------------------------------------------------------
// States for the simpler views: everything on track, nothing measured
// ---------------------------------------------------------------------------

/** On track in Fundraising, with a current number and work moving. */
export const seedOnTrack = responsibilityFixture({
  id: "resp-seed-on-track",
  areaId: areaFundraising.id,
  title: "Seed extension",
  standard: "Twenty qualified investors contacted before the partner meeting in December.",
  metricName: "Investors contacted",
  metricTarget: 20,
  metricCurrent: 21,
  metricUpdatedAt: new Date("2026-11-12T08:00:00Z"),
  rollup: {
    health: "on_track",
    computedHealth: "on_track",
    metric: metricFixture({ current: 21, attainment: 1.05, updatedAt: new Date("2026-11-12T08:00:00Z") }),
    statusSentence: "21 of 20 investors contacted, 105% of target",
    workSummary: [
      { kind: "tasks_open_agent", tone: "neutral", text: "1 open task with CodexCoder", refType: "agent", refId: "agent-codex", count: 1 },
      { kind: "tasks_completed_recently", tone: "good", text: "4 tasks completed in the last 7 days", refType: null, refId: null, count: 4 },
    ],
    projects: 1,
    openTasks: 1,
    agentTasks: 1,
    doneTasks: 6,
  },
});

/** On track in Fundraising, lower is better, read this week. */
export const lpUpdatesOnTrack = responsibilityFixture({
  id: "resp-lp-updates-on-track",
  areaId: areaFundraising.id,
  title: "LP updates",
  standard: "Every LP hears from us at least once a month.",
  metricName: "Days since the last LP letter",
  metricUnit: "days",
  metricTarget: 30,
  metricCurrent: 12,
  metricDirection: "at_most",
  metricUpdatedAt: new Date("2026-11-10T09:00:00Z"),
  sortOrder: 1,
  rollup: {
    health: "on_track",
    computedHealth: "on_track",
    metric: metricFixture({
      name: "Days since the last LP letter",
      unit: "days",
      target: 30,
      current: 12,
      direction: "at_most",
      attainment: 1,
      updatedAt: new Date("2026-11-10T09:00:00Z"),
    }),
    statusSentence: "Days since the last LP letter: 12 days against a target of at most 30 days",
  },
});

/** Every responsibility on track with a current number. */
export const allOnTrackOverviewFixture = responsibilityOverviewFixture([seedOnTrack, lpUpdatesOnTrack, portfolioOnTrack], [], {
  loose: EMPTY_LOOSE_WORK,
});

/** Not measured: a bar and a target, no reading yet. */
export const onboardingNotMeasured = responsibilityFixture({
  id: "resp-onboarding",
  areaId: areaTeam.id,
  title: "Onboarding",
  standard: "Every new hire ships something in their first week.",
  metricName: "New hires who shipped in week one",
  metricUnit: "%",
  metricTarget: 100,
  sortOrder: 5,
  rollup: {
    health: "not_measured",
    computedHealth: "not_measured",
    metric: metricFixture({ name: "New hires who shipped in week one", unit: "%", target: 100 }),
    statusSentence: "Not measured yet: no reading of new hires who shipped in week one against a target of 100%",
  },
});

/** Bars and targets set, but nothing has been reported yet. */
export const nothingMeasuredOverviewFixture = responsibilityOverviewFixture([hiringNotMeasured, onboardingNotMeasured], [], {
  loose: EMPTY_LOOSE_WORK,
});

// ---------------------------------------------------------------------------
// A dense Board: four areas, 6 to 9 responsibilities each, every status
// ---------------------------------------------------------------------------

type DenseSignal = Pick<ResponsibilityWorkSignal, "kind" | "text"> & Partial<Pick<ResponsibilityWorkSignal, "refType" | "refId" | "count">>;

const SIGNAL_TONE: Record<ResponsibilityWorkSignal["kind"], ResponsibilityWorkSignal["tone"]> = {
  metric_stale: "attention",
  project_late: "attention",
  routine_failed: "attention",
  task_blocked: "attention",
  project_due_soon: "neutral",
  routine_paused: "neutral",
  tasks_open_agent: "neutral",
  tasks_open_person: "neutral",
  tasks_open_unassigned: "neutral",
  tasks_completed_recently: "good",
  routine_active: "good",
};

interface DenseSpec {
  id: string;
  areaId: string;
  title: string;
  standard: string;
  health: ResponsibilityHealth;
  metric: Partial<ResponsibilityMetricSummary> & Pick<ResponsibilityMetricSummary, "name">;
  statusSentence: string;
  signals?: DenseSignal[];
  /** Open tasks, projects and routines under it (zero for "nothing filed"). */
  work?: Partial<Pick<ResponsibilityRollup, "openTasks" | "projects" | "routines" | "doneTasks" | "agentTasks" | "userTasks" | "blockedTasks">>;
  override?: { note: string; computed: ResponsibilityHealth };
}

function denseResponsibility(spec: DenseSpec, sortOrder: number): ResponsibilityWithRollup {
  const metric = metricFixture({ updatedAt: new Date("2026-11-11T09:00:00Z"), ...spec.metric });
  return responsibilityFixture({
    id: spec.id,
    areaId: spec.areaId,
    title: spec.title,
    standard: spec.standard,
    metricKind: metric.kind,
    metricName: metric.name,
    metricUnit: metric.unit,
    metricTarget: metric.target,
    metricLow: metric.low,
    metricHigh: metric.high,
    metricCurrent: metric.current,
    metricDirection: metric.direction,
    metricUpdatedAt: metric.current === null ? null : metric.updatedAt,
    healthOverride: spec.override ? (spec.health as Responsibility["healthOverride"]) : null,
    healthNote: spec.override?.note ?? null,
    sortOrder,
    rollup: {
      health: spec.health,
      computedHealth: spec.override?.computed ?? spec.health,
      healthOverridden: !!spec.override,
      metric,
      statusSentence: spec.statusSentence,
      workSummary: (spec.signals ?? []).map((signal) => ({
        refType: null,
        refId: null,
        count: 1,
        ...signal,
        tone: SIGNAL_TONE[signal.kind],
      })),
      ...(spec.work ?? { openTasks: 2, agentTasks: 1, userTasks: 1, projects: 1 }),
    },
  });
}

export const areaProduct = areaFixture({ id: "area-product", title: "Product", sortOrder: 5 });
export const areaCustomers = areaFixture({ id: "area-customers", title: "Customers", sortOrder: 6 });
export const areaPeople = areaFixture({ id: "area-people", title: "People and hiring", sortOrder: 7 });
const DENSE_AREAS: readonly ResponsibilityArea[] = [areaFundraising, areaProduct, areaCustomers, areaPeople];

const NOTHING_FILED = { openTasks: 0, projects: 0, routines: 0, doneTasks: 0 };

const DENSE_SPECS: DenseSpec[] = [
  // Fundraising: 8
  { id: "dense-seed", areaId: areaFundraising.id, title: "Seed extension", standard: "Twenty qualified investors contacted before the partner meeting in December.", health: "behind",
    metric: { name: "Investors contacted", target: 20, current: 9, attainment: 0.45 }, statusSentence: "9 of 20 investors contacted, 45% of target",
    signals: [
      { kind: "project_late", text: "Investor update deck is 3 days past its target date", refType: "project", refId: "project-deck" },
      { kind: "task_blocked", text: "Get the cap table from counsel is blocked", refType: "issue", refId: "task-blocked" },
      { kind: "routine_failed", text: "Weekly investor pipeline review failed on its last run (2026-11-12)", refType: "routine", refId: "routine-weekly" },
      { kind: "tasks_open_agent", text: "3 open tasks with Chief of staff", refType: "agent", refId: "agent-cos", count: 3 },
    ] },
  { id: "dense-lp-letters", areaId: areaFundraising.id, title: "LP letters", standard: "Every LP hears from us at least once a month.", health: "at_risk",
    metric: { name: "Days since the last LP letter", unit: "days", target: 30, current: 36, direction: "at_most", attainment: 0.8333, stale: true },
    statusSentence: "Days since the last LP letter: 36 days against a target of at most 30 days",
    signals: [{ kind: "metric_stale", text: "Days since the last LP letter was last updated 19 days ago", refType: "responsibility", refId: "dense-lp-letters" }] },
  { id: "dense-reply", areaId: areaFundraising.id, title: "Investor questions answered quickly", standard: "Every investor question gets an answer within a working day.", health: "on_track",
    metric: { name: "Reply time", unit: "hours", target: 24, current: 20, direction: "at_most", attainment: 1 }, statusSentence: "Reply time: 20 hours against a target of at most 24 hours",
    signals: [{ kind: "tasks_completed_recently", text: "6 tasks completed in the last 7 days", count: 6 }] },
  { id: "dense-data-room", areaId: areaFundraising.id, title: "Data room kept current for diligence requests from every lead investor", standard: "Every document a lead asks for is in the data room within two days.", health: "at_risk",
    metric: { name: "Requests filled within two days", unit: "%", target: 90, current: 72, attainment: 0.8, kind: "percentage" }, statusSentence: "72% of requests filled within two days, against a target of 90%",
    signals: [{ kind: "tasks_open_unassigned", text: "2 open tasks not assigned to anyone", count: 2 }] },
  { id: "dense-pipeline", areaId: areaFundraising.id, title: "Lead pipeline", standard: "At least five warm leads in active conversation at all times.", health: "behind",
    metric: { name: "Warm leads in conversation", target: 5, current: 2, attainment: 0.4 }, statusSentence: "2 of 5 warm leads in conversation, 40% of target",
    signals: [{ kind: "tasks_open_agent", text: "2 open tasks with Chief of staff", refType: "agent", refId: "agent-cos", count: 2 }], work: { openTasks: 2, agentTasks: 2 } },
  { id: "dense-runway", areaId: areaFundraising.id, title: "Runway", standard: "Runway stays between 18 and 24 months.", health: "on_track",
    metric: { name: "Months of runway", unit: "months", kind: "range", target: null, low: 18, high: 24, direction: null, current: 21, attainment: 1 }, statusSentence: "21 months of runway, inside 18–24 months",
    signals: [{ kind: "routine_active", text: "Monthly runway check is active, last run completed on 2026-11-01", refType: "routine", refId: "routine-runway" }] },
  { id: "dense-board-deck", areaId: areaFundraising.id, title: "Board reporting", standard: "The board gets its deck a week before every meeting.", health: "at_risk",
    metric: { name: "Decks sent on time this year", target: 4, current: 4, attainment: 1 }, statusSentence: "4 of 4 decks sent on time this year, 100% of target",
    override: { note: "The Q4 deck depends on numbers finance has not closed yet.", computed: "on_track" },
    signals: [{ kind: "project_due_soon", text: "Q4 board deck is due in 5 days", refType: "project", refId: "project-q4" }] },
  { id: "dense-terms", areaId: areaFundraising.id, title: "Term sheet ready", standard: "A signed term sheet from a lead investor.", health: "not_measured",
    metric: { name: "A lead has signed a term sheet", kind: "yes_no", target: null, unit: null, direction: null, current: null }, statusSentence: "Not measured yet: no answer to whether a lead has signed a term sheet",
    work: NOTHING_FILED },
  // Product: 7
  { id: "dense-uptime", areaId: areaProduct.id, title: "Uptime", standard: "The app is up 99.9% of every month.", health: "on_track",
    metric: { name: "Uptime this month", unit: "%", target: 99.9, current: 99.95, attainment: 1, kind: "percentage" }, statusSentence: "99.95% uptime this month, against a target of 99.9%",
    signals: [{ kind: "routine_active", text: "Hourly health check is active, last run completed on 2026-11-13", refType: "routine", refId: "routine-health" }] },
  { id: "dense-release", areaId: areaProduct.id, title: "Release cadence", standard: "We ship to customers every week.", health: "behind",
    metric: { name: "Releases this month", target: 4, current: 1, attainment: 0.25 }, statusSentence: "1 of 4 releases this month, 25% of target",
    signals: [
      { kind: "task_blocked", text: "Fix the flaky checkout test is blocked", refType: "issue", refId: "task-flaky" },
      { kind: "task_blocked", text: "Migrate the billing tables is blocked", refType: "issue", refId: "task-billing" },
      { kind: "project_late", text: "Mobile beta is 9 days past its target date", refType: "project", refId: "project-mobile" },
    ] },
  { id: "dense-bugs", areaId: areaProduct.id, title: "Open customer-facing bugs kept under control", standard: "No more than ten customer-facing bugs are open at once.", health: "at_risk",
    metric: { name: "Open customer-facing bugs", target: 10, current: 12, direction: "at_most", attainment: 0.8333 }, statusSentence: "Open customer-facing bugs: 12 against a target of at most 10",
    signals: [{ kind: "routine_paused", text: "Nightly triage is paused", refType: "routine", refId: "routine-triage" }] },
  { id: "dense-onboarding-time", areaId: areaProduct.id, title: "Time to first value", standard: "A new account sees its first report within ten minutes.", health: "not_measured",
    metric: { name: "Minutes to first report", unit: "minutes", target: 10, current: null, direction: "at_most" }, statusSentence: "Not measured yet: no reading of minutes to first report against a target of at most 10 minutes",
    signals: [{ kind: "tasks_open_agent", text: "1 open task with Analyst", refType: "agent", refId: "agent-analyst" }] },
  { id: "dense-roadmap", areaId: areaProduct.id, title: "Roadmap commitments", standard: "Every quarter's committed roadmap items ship that quarter.", health: "on_track",
    metric: { name: "Committed items shipped", unit: "%", target: 80, current: 85, attainment: 1, kind: "percentage" }, statusSentence: "85% of committed items shipped, against a target of 80%",
    signals: [{ kind: "tasks_open_agent", text: "4 open tasks with Engineer", refType: "agent", refId: "agent-eng", count: 4 }] },
  { id: "dense-security", areaId: areaProduct.id, title: "Security review", standard: "The yearly penetration test is done and every finding is closed.", health: "behind",
    metric: { name: "Findings closed", target: 14, current: 3, attainment: 0.2143 }, statusSentence: "3 of 14 findings closed, 21% of target", work: NOTHING_FILED },
  { id: "dense-docs", areaId: areaProduct.id, title: "Docs", standard: "Every public feature has a docs page.", health: "not_measured",
    metric: { name: "Features with docs", target: null, current: null }, statusSentence: "Not measured: no target is set" },
  // Customers: 9
  { id: "dense-nps", areaId: areaCustomers.id, title: "Customer satisfaction", standard: "Net promoter score stays above 50.", health: "on_track",
    metric: { name: "Net promoter score", target: 50, current: 58, attainment: 1 }, statusSentence: "Net promoter score 58 against a target of 50",
    signals: [{ kind: "tasks_completed_recently", text: "3 tasks completed in the last 7 days", count: 3 }] },
  { id: "dense-churn", areaId: areaCustomers.id, title: "Churn", standard: "Fewer than 2% of accounts leave in a month.", health: "behind",
    metric: { name: "Monthly churn", unit: "%", target: 2, current: 3.4, direction: "at_most", attainment: 0.5882, kind: "percentage" }, statusSentence: "Monthly churn: 3.4% against a target of at most 2%",
    signals: [{ kind: "project_late", text: "Win-back campaign is 2 days past its target date", refType: "project", refId: "project-winback" }] },
  { id: "dense-renewals", areaId: areaCustomers.id, title: "Renewals", standard: "Every renewal is signed before the contract ends.", health: "at_risk",
    metric: { name: "Renewals signed on time", target: 12, current: 10, attainment: 0.8333 }, statusSentence: "10 of 12 renewals signed on time, 83% of target",
    signals: [{ kind: "tasks_open_person", text: "2 open tasks with Riley Board", refType: "user", refId: RESPONSIBILITY_FIXTURE_OWNER_ID, count: 2 }] },
  { id: "dense-support", areaId: areaCustomers.id, title: "Support response time", standard: "A first reply to every ticket within four hours.", health: "on_track",
    metric: { name: "First reply time", unit: "hours", target: 4, current: 1.5, direction: "at_most", attainment: 1 }, statusSentence: "First reply time: 1.5 hours against a target of at most 4 hours",
    signals: [{ kind: "tasks_open_agent", text: "7 open tasks with Support agent", refType: "agent", refId: "agent-support", count: 7 }] },
  { id: "dense-expansion", areaId: areaCustomers.id, title: "Expansion revenue from existing accounts this quarter", standard: "Existing accounts add $20,000 of new annual revenue this quarter.", health: "behind",
    metric: { name: "Expansion revenue", unit: "$", target: 20000, current: 12000, attainment: 0.6 }, statusSentence: "$12,000 of $20,000 expansion revenue, 60% of target",
    signals: [
      { kind: "routine_failed", text: "Usage report to account owners failed on its last run (2026-11-11)", refType: "routine", refId: "routine-usage" },
      { kind: "tasks_open_unassigned", text: "3 open tasks not assigned to anyone", count: 3 },
    ] },
  { id: "dense-case-studies", areaId: areaCustomers.id, title: "Case studies", standard: "One published case study a month.", health: "not_measured",
    metric: { name: "Case studies published", target: 3, current: null }, statusSentence: "Not measured yet: no reading of case studies published against a target of 3", work: NOTHING_FILED },
  { id: "dense-qbr", areaId: areaCustomers.id, title: "Quarterly business reviews", standard: "Every top-twenty account gets a business review each quarter.", health: "on_track",
    metric: { name: "Reviews held", target: 20, current: 20, attainment: 1 }, statusSentence: "20 of 20 reviews held, 100% of target",
    signals: [{ kind: "tasks_completed_recently", text: "5 tasks completed in the last 7 days", count: 5 }] },
  { id: "dense-onboard-accounts", areaId: areaCustomers.id, title: "New account onboarding", standard: "Every new account is live within a week.", health: "at_risk",
    metric: { name: "Accounts live within a week", unit: "%", target: 95, current: 80, attainment: 0.8421, kind: "percentage" }, statusSentence: "80% of accounts live within a week, against a target of 95%",
    signals: [{ kind: "task_blocked", text: "Set up SSO for Northwind is blocked", refType: "issue", refId: "task-sso" }] },
  { id: "dense-community", areaId: areaCustomers.id, title: "Community", standard: "The community forum answers every question within a day.", health: "on_track",
    metric: { name: "Questions answered within a day", unit: "%", target: 90, current: 93, attainment: 1, kind: "percentage" }, statusSentence: "93% of questions answered within a day, against a target of 90%" },
  // People and hiring: 6
  { id: "dense-hiring", areaId: areaPeople.id, title: "Hiring", standard: "Two senior engineers have accepted offers by the end of the quarter.", health: "not_measured",
    metric: { name: "Offers accepted", target: 2, current: null }, statusSentence: "Not measured yet: no reading of offers accepted against a target of 2",
    signals: [{ kind: "project_late", text: "Senior engineer search is 4 days past its target date", refType: "project", refId: "project-search" }] },
  { id: "dense-retention", areaId: areaPeople.id, title: "Retention", standard: "Nobody leaves in their first year.", health: "on_track",
    metric: { name: "First-year departures", target: 0, current: 0, direction: "at_most", attainment: 1 }, statusSentence: "First-year departures: 0 against a target of at most 0" },
  { id: "dense-reviews", areaId: areaPeople.id, title: "Performance reviews", standard: "Every person has a review this half.", health: "behind",
    metric: { name: "Reviews done", target: 12, current: 4, attainment: 0.3333 }, statusSentence: "4 of 12 reviews done, 33% of target",
    signals: [{ kind: "tasks_open_person", text: "8 open tasks with Riley Board", refType: "user", refId: RESPONSIBILITY_FIXTURE_OWNER_ID, count: 8 }] },
  { id: "dense-onboarding-people", areaId: areaPeople.id, title: "New hire onboarding", standard: "Every new hire ships something in their first week.", health: "at_risk",
    metric: { name: "New hires who shipped in week one", unit: "%", target: 100, current: 80, attainment: 0.8, kind: "percentage" }, statusSentence: "80% of new hires shipped in week one, against a target of 100%",
    signals: [{ kind: "routine_paused", text: "First-week checklist is paused", refType: "routine", refId: "routine-checklist" }] },
  { id: "dense-offsite", areaId: areaPeople.id, title: "Team offsite", standard: "The whole team meets in person twice a year.", health: "on_track",
    metric: { name: "Offsites held this year", target: 2, current: 2, attainment: 1 }, statusSentence: "2 of 2 offsites held this year, 100% of target" },
  { id: "dense-handbook", areaId: areaPeople.id, title: "Handbook", standard: "The handbook answers every policy question people ask.", health: "not_measured", metric: { name: "Policy questions the handbook answered" , target: null, current: null },
    statusSentence: "Not measured: no target is set", work: NOTHING_FILED },
];

/** Four areas with 6 to 9 responsibilities each, across every status, with varied reasons and long titles. */
export const denseBoardOverviewFixture = responsibilityOverviewFixture(
  DENSE_SPECS.map((spec, index) => denseResponsibility(spec, index)),
  [],
  { loose: EMPTY_LOOSE_WORK, areas: DENSE_AREAS },
);

// ---------------------------------------------------------------------------
// Outline v2: many areas, each responsibility one sentence
// ---------------------------------------------------------------------------

/** [title, bar sentence or null (the row falls back to the title)] */
type OutlineSpec = readonly [string, string | null];

const OUTLINE_DENSE_AREAS: ReadonlyArray<readonly [string, readonly OutlineSpec[]]> = [
  ["Design system", [
    ["Token coverage", "Every screen is built from tokens, with no one-off colors, sizes, or shadows."],
    ["Reskin direction", "The team has one approved visual direction and builds toward it."],
    ["Shadcn conversion", "100% shadcn components"],
    ["Component reuse", "We extend a shared component before we build a new one."],
  ]],
  ["Information architecture", [
    ["Navigation", "Anyone can reach any page in three clicks or fewer from the sidebar."],
    ["Naming", "Every concept has one name, used the same way on every screen, in every email and in the docs, so nobody has to learn two words for the same thing."],
    ["Settings layout", null],
  ]],
  ["Plain language", [
    ["Copy review", "Every new string is read by a person before it ships."],
    ["Error messages", "Every error says what happened and what to do next."],
  ]],
  ["Onboarding", [
    ["First task", "A new company finishes its first task within ten minutes."],
    ["Guide drafts", "The onboarding guide drafts responsibilities the person keeps."],
    ["Activation", null],
  ]],
  ["Accessibility", [
    ["Keyboard", "Every action can be done with the keyboard alone."],
    ["Contrast", "All text meets WCAG AA contrast in both themes."],
  ]],
  ["Performance", [
    ["Page load", "The dashboard is usable within one second on a laptop."],
    ["Bundle size", null],
  ]],
  ["Mobile", [
    ["Task chat", "Task conversations work one-handed on a phone."],
    ["Bottom navigation", "The bottom navigation never covers what someone is reading."],
  ]],
  ["Research", [
    ["Interviews", "We talk to five customers every month."],
    ["Insight log", "Every interview leaves one insight in the shared log."],
  ]],
  ["Pricing", [
    ["Plans page", "A visitor can tell which plan fits them without asking."],
    ["Usage limits", null],
  ]],
  ["Roadmap", [
    ["Quarterly plan", "Each quarter starts with a plan the whole team has read."],
    ["Commitments", "What we commit to in a quarter ships in that quarter."],
  ]],
  ["Analytics", [
    ["Dashboards", "Every launch has a dashboard before it ships."],
    ["Event naming", "Events follow one naming scheme."],
  ]],
  ["Hiring", [
    ["Design hires", "Two senior designers have accepted offers by spring."],
    ["Interview loop", "Every candidate hears back within a week."],
  ]],
  ["Team rituals", [
    ["Critique", "Design critique happens every week, and nobody skips it twice in a row."],
    ["Demo day", null],
  ]],
  ["Docs", [
    ["Feature docs", "Every public feature has a docs page."],
    ["Changelog", "The changelog goes out with every release."],
  ]],
  ["Support", [
    ["First reply", "Every support question gets a first reply within four hours."],
    ["Known issues", "Known problems are listed where customers look first."],
  ]],
  ["Security", [
    ["Access reviews", "Access is reviewed every quarter."],
    ["Pen test findings", "Every finding from the yearly test is closed."],
  ]],
  ["Partnerships", [
    ["Integrations", "Our top three integrations stay working after every release."],
    ["Partner calls", null],
  ]],
  ["Brand", [
    ["Voice", "Everything we publish sounds like one company."],
    ["Logo use", "Partners use the current logo."],
  ]],
  ["Community", [
    ["Forum answers", "Every forum question is answered within a day."],
    ["Showcase", "We feature one customer project a month."],
  ]],
  ["Quality", [
    ["Bug backlog", "No more than ten customer-facing bugs are open at once."],
    ["Regression tests", "Every fixed bug gets a test that would have caught it."],
  ]],
  ["Releases", [
    ["Weekly release", "We ship to customers every week."],
    ["Release notes", null],
  ]],
  // An area with nothing filed under it yet.
  ["Legal", []],
];

const OUTLINE_HEALTH_CYCLE: readonly ResponsibilityHealth[] = ["behind", "at_risk", "on_track", "not_measured", "on_track"];

const outlineDenseAreas: ResponsibilityArea[] = OUTLINE_DENSE_AREAS.map(([title], index) =>
  areaFixture({ id: `outline-area-${index + 1}`, title, sortOrder: index }));

const outlineDenseResponsibilities: ResponsibilityWithRollup[] = OUTLINE_DENSE_AREAS.flatMap(([, specs], areaIndex) =>
  specs.map(([title, standard], index) => {
    // Statuses are there (the view must not show them).
    const health = OUTLINE_HEALTH_CYCLE[(areaIndex + index) % OUTLINE_HEALTH_CYCLE.length]!;
    return responsibilityFixture({
      id: `outline-resp-${areaIndex + 1}-${index + 1}`,
      areaId: outlineDenseAreas[areaIndex]!.id,
      title,
      standard,
      sortOrder: index,
      rollup: { health, computedHealth: health },
    });
  }));

/** Outline v2, dense: 46 responsibilities in 21 areas, plus one area with nothing in it yet (22 areas). */
export const outlineDenseOverviewFixture = responsibilityOverviewFixture(outlineDenseResponsibilities, [], {
  loose: EMPTY_LOOSE_WORK,
  areas: outlineDenseAreas,
});

/** The dense fixture's area ids, in order, for stories that fold some of them. */
export const OUTLINE_DENSE_AREA_IDS: readonly string[] = outlineDenseAreas.map((area) => area.id);

/** Responsibilities and no areas at all: everything sits in the last group. */
export const outlineNoAreasOverviewFixture = responsibilityOverviewFixture(
  outlineDenseResponsibilities.slice(0, 5).map((item) => ({ ...item, areaId: null })),
  [],
  { loose: EMPTY_LOOSE_WORK, areas: [] },
);

// ---------------------------------------------------------------------------
// Written summaries ("Where things stand", "What is affecting the number")
// ---------------------------------------------------------------------------

export type SummaryFixtureState = "computed" | "refreshing" | "model";

const COMPUTED_DASHBOARD_TEXT =
  "1 of your 5 responsibilities is behind and 2 are at risk. Seed extension is 11 investors short of 20, held back by a late investor update deck and a blocked cap table task. LP updates is 6 days over its 30-day limit on a reading 19 days old.";
const MODEL_DASHBOARD_TEXT =
  "Fundraising needs you most this week. Seed extension is less than halfway to its 20 investors, and the two things in the way are yours to unblock: the investor update deck is three days late and the cap table is waiting on counsel. Portfolio is in good shape, and Hiring has no number yet, so it is worth asking for a first reading.";
const COMPUTED_DETAIL_TEXT =
  "9 of 20 investors contacted. Two items are holding the number back: Investor update deck is 3 days past its target date, and Get the cap table from counsel is blocked. CodexCoder has 2 open tasks under it.";
const MODEL_DETAIL_TEXT =
  "The number is stuck because the outreach depends on the investor update deck, which is three days late, and the cap table that counsel has not sent. CodexCoder's draft of the November update is the work most likely to move it next.";

/**
 * A summary response in one of its states. "refreshing" answers with the
 * computed paragraph and `refreshing: true` the first time, then with the
 * model-written one, as the server does once a model has written it.
 */
export function summaryFixture(state: SummaryFixtureState, scope: "dashboard" | "detail", read = 0): ResponsibilitySummary {
  const computed = scope === "dashboard" ? COMPUTED_DASHBOARD_TEXT : COMPUTED_DETAIL_TEXT;
  const model = scope === "dashboard" ? MODEL_DASHBOARD_TEXT : MODEL_DETAIL_TEXT;
  const written = new Date(RESPONSIBILITY_FIXTURE_NOW.getTime() - 4 * 60_000).toISOString();
  if (state === "model" || (state === "refreshing" && read > 0)) {
    return { text: model, source: "model", generatedAt: written, refreshing: false };
  }
  return { text: computed, source: "computed", generatedAt: new Date().toISOString(), refreshing: state === "refreshing" };
}

// ---------------------------------------------------------------------------
// How automated (the Dashboard's Automation view)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const daysBefore = (days: number) => new Date(RESPONSIBILITY_FIXTURE_NOW.getTime() - days * DAY_MS).toISOString();

const SCHEDULE_START: AutomationStart = { kind: "schedule", cadenceLabel: "Every Monday at 9 AM", timezone: "America/Chicago", nextRunAt: daysBefore(-3) };

/** A running automation; by default a schedule every Monday. */
export function automationItemFixture(overrides: Partial<ResponsibilityAutomationItem> & Pick<ResponsibilityAutomationItem, "id" | "title">): ResponsibilityAutomationItem {
  return {
    assigneeAgentId: "agent-codex",
    start: SCHEDULE_START,
    otherStarts: 0,
    lastRunAt: daysBefore(4),
    ...overrides,
  };
}

/** A manual task; its hint and reason follow the shared rule from its title, status and agent. */
export function candidateFixture(overrides: Partial<AutomationCandidate> & Pick<AutomationCandidate, "issueId" | "title">): AutomationCandidate {
  const base = {
    identifier: null,
    status: "todo" as const,
    assigneeAgentId: null,
    assigneeUserId: RESPONSIBILITY_FIXTURE_OWNER_ID,
    completedAt: null,
    updatedAt: daysBefore(2),
    pendingOffer: null,
    conversation: null,
    ...overrides,
  };
  const hint = overrides.hint !== undefined ? overrides.hint : automationHintForTask({ title: base.title });
  return {
    ...base,
    hint,
    reason: overrides.reason ?? automationCandidateReason({ ...base, id: base.issueId, hasPendingOffer: base.pendingOffer !== null && base.status === "done" }),
    suggestedCadence: overrides.suggestedCadence ?? base.pendingOffer?.cadence ?? hint?.cadence ?? { frequency: "weekly", dayOfWeek: "monday", dayOfMonth: null, time: "09:00" },
    cadenceSource: overrides.cadenceSource ?? (base.pendingOffer ? "offer" : hint?.cadence ? "title" : "default"),
    responsibleAgentId: overrides.responsibleAgentId !== undefined ? overrides.responsibleAgentId : base.assigneeAgentId ?? "agent-codex",
  };
}

/** One responsibility's automation; level and share follow the shared rule from the counts. */
export function automationFixture(input: {
  responsibilityId: string;
  areaId: string | null;
  running?: ResponsibilityAutomationItem[];
  runningCount?: number;
  stalled?: ResponsibilityAutomationStalled[];
  candidates?: AutomationCandidate[];
  manual?: number;
  openManual?: number;
  nothingFiled?: boolean;
}): ResponsibilityAutomation {
  const running = input.running ?? [];
  const runningCount = input.runningCount ?? running.length;
  const candidates = input.candidates ?? [];
  const manual = input.manual ?? candidates.length;
  return {
    responsibilityId: input.responsibilityId,
    areaId: input.areaId,
    level: responsibilityAutomationLevel(runningCount, manual),
    share: responsibilityAutomationShare(runningCount, manual),
    automationCount: runningCount,
    manualTaskCount: manual,
    openManualTaskCount: input.openManual ?? candidates.filter((candidate) => candidate.status !== "done").length,
    nothingFiled: input.nothingFiled ?? false,
    automations: running,
    stalledAutomations: input.stalled ?? [],
    candidates,
    candidateTotal: manual,
    manualTaskIds: [
      ...candidates.map((candidate) => candidate.issueId),
      ...Array.from({ length: Math.max(0, manual - candidates.length) }, (_, index) => `${input.responsibilityId}-task-${index}`),
    ],
  };
}

/** The read as the server returns it; areas and totals sum the items (fixtures share no work between responsibilities). */
export function automationOverviewFixture(items: ResponsibilityAutomation[]): ResponsibilityAutomationOverview {
  const byLevel = Object.fromEntries(RESPONSIBILITY_AUTOMATION_LEVELS.map((level) => [level, 0])) as Record<ResponsibilityAutomationLevel, number>;
  const areas = new Map<string | null, { automations: number; manualTasks: number }>();
  let automations = 0;
  let manualTasks = 0;
  for (const item of items) {
    byLevel[item.level] += 1;
    automations += item.automationCount;
    manualTasks += item.manualTaskCount;
    const area = areas.get(item.areaId) ?? { automations: 0, manualTasks: 0 };
    area.automations += item.automationCount;
    area.manualTasks += item.manualTaskCount;
    areas.set(item.areaId, area);
  }
  return {
    ownerUserId: RESPONSIBILITY_FIXTURE_OWNER_ID,
    recentDays: RESPONSIBILITY_AUTOMATION_RECENT_DAYS,
    responsibilities: items,
    areas: [...areas.entries()].map(([areaId, area]) => ({ areaId, ...area, share: responsibilityAutomationShare(area.automations, area.manualTasks) })),
    totals: { responsibilities: items.length, byLevel, automations, manualTasks, share: responsibilityAutomationShare(automations, manualTasks) },
  };
}

/** A webhook automation, as the read reports it. */
export const webhookStartFixture: AutomationStart = {
  kind: "webhook",
  webhookUrl: "https://paperclip.example/api/routine-triggers/public/7f3a9c21d4e5b6a8c0d1e2f3/fire",
  signingMode: "bearer",
  lastDeliveryAt: daysBefore(1),
};

/**
 * The home overview's five responsibilities, one at each level, with every
 * way an automation starts: Seed extension has a schedule and five manual
 * tasks (an agent's pending offer, a webhook hint with a conversation open, a
 * standing-check hint, and two with no hint); LP updates is manual with a
 * paused routine; Portfolio is automated by a schedule, a webhook and a
 * standing check that acted; Hiring has nothing filed; Board reporting is
 * mostly automated, with a routine that runs on request, a standing check
 * whose agent never wakes up, and a task whose proposal is waiting.
 */
export const homeAutomationFixture = automationOverviewFixture([
  automationFixture({
    responsibilityId: fundraisingBehind.id,
    areaId: areaFundraising.id,
    running: [automationItemFixture({ id: "routine-weekly", title: "Weekly investor pipeline review" })],
    candidates: [
      candidateFixture({
        issueId: "task-done", identifier: "PAP-30", title: "Send the October update",
        status: "done", assigneeAgentId: "agent-codex", assigneeUserId: null, completedAt: daysBefore(13),
        pendingOffer: {
          interactionId: "interaction-offer-update",
          agentId: "agent-codex",
          title: "Monthly investor update",
          cadence: { frequency: "monthly", dayOfWeek: null, dayOfMonth: 1, time: "09:00" },
          cadenceLabel: "On the 1st of every month at 9 AM",
        },
      }),
      candidateFixture({
        issueId: "task-inbound", identifier: "PAP-42", title: "Reply to inbound investor emails",
        status: "in_progress", assigneeAgentId: "agent-codex", assigneeUserId: null,
        conversation: { issueId: "conversation-inbound", identifier: "PAP-70", agentId: "agent-codex", state: "discussing" },
      }),
      candidateFixture({ issueId: "task-chase", identifier: "PAP-44", title: "Chase LPs who have waited more than a week" }),
      candidateFixture({ issueId: "task-blocked", identifier: "PAP-41", title: "Get the cap table from counsel", status: "blocked" }),
      candidateFixture({ issueId: "task-intro", identifier: "PAP-43", title: "Ask Dana for an intro to the lead" }),
    ],
  }),
  automationFixture({
    responsibilityId: lpUpdatesStale.id,
    areaId: areaFundraising.id,
    stalled: [{ id: "routine-lp-letter", title: "Monthly LP letter", status: "paused", assigneeAgentId: "agent-codex", startKind: "schedule", reason: "paused" }],
    candidates: [candidateFixture({ issueId: "task-letter", identifier: "PAP-50", title: "Write the November LP letter", assigneeUserId: null })],
  }),
  automationFixture({
    responsibilityId: portfolioOnTrack.id,
    areaId: areaPortfolio.id,
    running: [
      automationItemFixture({
        id: "routine-checkin", title: "Monthly founder check-in", assigneeAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
        start: { kind: "schedule", cadenceLabel: "On the 1st of every month at 10 AM", timezone: "America/Chicago", nextRunAt: daysBefore(-9) },
      }),
      automationItemFixture({ id: "routine-founder-requests", title: "Answer new founder requests", start: webhookStartFixture }),
      automationItemFixture({
        id: "routine-board-decks", title: "Follow up on overdue board decks", assigneeAgentId: "agent-qa",
        start: {
          kind: "standing_check",
          lastResult: {
            checkedAt: new Date(RESPONSIBILITY_FIXTURE_NOW.getTime() - 2 * 3_600_000).toISOString(),
            outcome: "acted",
            note: "Reminded two founders",
            issue: { id: "task-deck-reminder", identifier: "PAP-88", title: "Board decks overdue at two companies" },
          },
        },
      }),
    ],
  }),
  automationFixture({ responsibilityId: hiringNotMeasured.id, areaId: areaTeam.id, nothingFiled: true }),
  automationFixture({
    responsibilityId: boardReportingOverridden.id,
    areaId: null,
    running: [
      automationItemFixture({
        id: "routine-board-metrics", title: "Weekly board metrics digest", assigneeAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
        start: { kind: "schedule", cadenceLabel: "Every Friday at 4 PM", timezone: "America/Chicago", nextRunAt: daysBefore(-2) },
      }),
      automationItemFixture({ id: "routine-board-reminder", title: "Board pack reminder", assigneeAgentId: "agent-qa", start: { kind: "on_request" } }),
    ],
    stalled: [{ id: "routine-pack-check", title: "Make sure directors have the pack", status: "active", assigneeAgentId: "agent-qa", startKind: "standing_check", reason: "no_wakeups" }],
    candidates: [candidateFixture({
      issueId: "task-board-deck", identifier: "PAP-61", title: "Prepare the Q4 board report",
      conversation: { issueId: "conversation-board-report", identifier: "PAP-71", agentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, state: "proposal_waiting" },
      responsibleAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
    })],
  }),
]);

const DENSE_CANDIDATE_TITLES = [
  "Send the weekly status report to the leadership team and the board observers",
  "Reconcile the payouts",
  "Draft the follow-up plan",
  "Triage new bug reports from the community forum",
  "Clean up the shared drive",
  "Make sure every open contract has an owner",
];

/**
 * Every dense Board responsibility at a level, cycling through all four (and a
 * paused or unassigned routine now and then); "nothing filed" stays that way.
 */
export const denseAutomationFixture = automationOverviewFixture(
  denseBoardOverviewFixture.responsibilities.map((item, index) => {
    const nothingFiled = item.rollup.openTasks + item.rollup.projects + item.rollup.routines + item.rollup.doneTasks === 0;
    if (nothingFiled) return automationFixture({ responsibilityId: item.id, areaId: item.areaId, nothingFiled: true });
    const pattern = index % 5;
    const routineCount = [0, 1, 3, 2, 0][pattern]!;
    const manual = [6, 4, 1, 0, 2][pattern]!;
    const starts: AutomationStart[] = [SCHEDULE_START, webhookStartFixture, { kind: "standing_check", lastResult: null }];
    const running = Array.from({ length: Math.min(routineCount, 4) }, (_, routineIndex) => automationItemFixture({
      id: `${item.id}-routine-${routineIndex}`,
      title: routineIndex === 0 ? `${item.title} weekly check` : `${item.title} digest ${routineIndex + 1}`,
      assigneeAgentId: routineIndex % 2 === 0 ? "agent-codex" : RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
      start: starts[(index + routineIndex) % starts.length]!,
    }));
    const candidates = Array.from({ length: Math.min(manual, 5) }, (_, taskIndex) => {
      const title = DENSE_CANDIDATE_TITLES[(index + taskIndex) % DENSE_CANDIDATE_TITLES.length]!;
      const done = taskIndex % 2 === 0;
      return candidateFixture({
        issueId: `${item.id}-task-${taskIndex}`,
        title,
        status: done ? "done" : "todo",
        assigneeAgentId: done ? "agent-codex" : null,
        completedAt: done ? daysBefore(taskIndex + 1) : null,
      });
    });
    const stalled: ResponsibilityAutomationStalled[] = pattern === 4
      ? [{ id: `${item.id}-paused`, title: `${item.title} reminder`, status: "paused", assigneeAgentId: "agent-codex", startKind: "schedule", reason: "paused" }]
      : pattern === 1 && index % 2 === 0
        ? [{ id: `${item.id}-unassigned`, title: `${item.title} sweep`, status: "active", assigneeAgentId: null, startKind: "on_request", reason: "no_agent" }]
        : [];
    return automationFixture({ responsibilityId: item.id, areaId: item.areaId, running, runningCount: routineCount, candidates, manual, stalled });
  }),
);

/**
 * Standing checks in every state, on one responsibility (Portfolio): not
 * checked yet, nothing needed, acted with a task, paused (with Resume), and
 * one whose agent never wakes up on its own; plus a manual task whose hint is
 * a standing check.
 */
export const standingCheckAutomationFixture = automationOverviewFixture([
  automationFixture({
    responsibilityId: portfolioOnTrack.id,
    areaId: areaPortfolio.id,
    running: [
      automationItemFixture({ id: "check-new", title: "Watch for founders asking for intros", start: { kind: "standing_check", lastResult: null } }),
      automationItemFixture({
        id: "check-quiet", title: "Make sure every board deck arrives", assigneeAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
        start: { kind: "standing_check", lastResult: { checkedAt: new Date(RESPONSIBILITY_FIXTURE_NOW.getTime() - 25 * 60_000).toISOString(), outcome: "nothing_needed", note: null, issue: null } },
      }),
      automationItemFixture({
        id: "check-acted", title: "Follow up on overdue board decks", assigneeAgentId: "agent-qa",
        start: {
          kind: "standing_check",
          lastResult: {
            checkedAt: new Date(RESPONSIBILITY_FIXTURE_NOW.getTime() - 2 * 3_600_000).toISOString(),
            outcome: "acted",
            note: "Reminded two founders",
            issue: { id: "task-deck-reminder", identifier: "PAP-88", title: "Board decks overdue at two companies" },
          },
        },
      }),
    ],
    stalled: [
      { id: "check-paused", title: "Chase unsigned side letters", status: "paused", assigneeAgentId: "agent-codex", startKind: "standing_check", reason: "paused" },
      { id: "check-asleep", title: "Keep an eye on runway updates", status: "active", assigneeAgentId: "agent-qa", startKind: "standing_check", reason: "no_wakeups" },
    ],
    candidates: [candidateFixture({ issueId: "task-stale", identifier: "PAP-95", title: "Follow up on stale data-room requests" })],
  }),
]);
