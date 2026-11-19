import type {
  ResponsibilityBarConversation,
  ResponsibilityDetail,
  ResponsibilityRecentRun,
  ResponsibilityRecentRuns,
} from "@paperclipai/shared";
import {
  areaFundraising,
  fundraisingDetail,
  hiringNotMeasured,
  RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  RESPONSIBILITY_FIXTURE_NOW,
  responsibilityDetailFixture,
  responsibilityFixture,
} from "./responsibilities";
import { BAR_FIXTURE_ISSUE_ID } from "./responsibility-bars";
import { barProposalWithMetricsFixture } from "./responsibility-metrics";

/**
 * Synthetic data for the "One screen v2" responsibility layout: a
 * responsibility with only its sentence (no bar yet), one with nothing under
 * it, its recent runs, and each state of the bar conversation.
 */

const MINUTE_MS = 60_000;
const ago = (minutes: number) => new Date(RESPONSIBILITY_FIXTURE_NOW.getTime() - minutes * MINUTE_MS).toISOString();

/** Only its sentence: no metric at all, so the bar is the empty state. */
export const sentenceOnlyDetail: ResponsibilityDetail = responsibilityDetailFixture(responsibilityFixture({
  id: "resp-investor-relations",
  areaId: areaFundraising.id,
  title: "Investor relations",
  standard: "Every investor always knows where we stand.",
  metricDirection: null,
}));

/** A bar, and nothing filed under it: every section shows only its heading and "+". */
export const nothingUnderDetail: ResponsibilityDetail = responsibilityDetailFixture({ ...hiringNotMeasured, id: "resp-hiring-empty" });

function runFixture(overrides: Partial<ResponsibilityRecentRun> & Pick<ResponsibilityRecentRun, "id">): ResponsibilityRecentRun {
  return {
    agentId: "agent-codex",
    status: "succeeded",
    createdAt: ago(30),
    startedAt: ago(30),
    finishedAt: ago(26),
    issue: { id: "task-draft", identifier: "PAP-42", title: "Draft the November investor update" },
    routineId: null,
    ...overrides,
  };
}

export const recentRunsFixture: ResponsibilityRecentRuns = {
  responsibilityId: fundraisingDetail.id,
  limit: 8,
  runs: [
    runFixture({ id: "run-live", status: "running", createdAt: ago(3), startedAt: ago(3), finishedAt: null }),
    runFixture({
      id: "run-routine",
      createdAt: ago(60 * 26),
      startedAt: ago(60 * 26),
      finishedAt: ago(60 * 26 - 6),
      issue: { id: "task-weekly-review", identifier: "PAP-61", title: "Weekly investor pipeline review" },
      routineId: "routine-weekly",
    }),
    runFixture({
      id: "run-failed",
      agentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
      status: "failed",
      createdAt: ago(60 * 50),
      startedAt: ago(60 * 50),
      finishedAt: ago(60 * 50 - 2),
      issue: { id: "task-blocked", identifier: "PAP-41", title: "Get the cap table from counsel" },
    }),
    runFixture({ id: "run-older", createdAt: ago(60 * 24 * 4), startedAt: ago(60 * 24 * 4), finishedAt: ago(60 * 24 * 4 - 9) }),
  ],
};

export const noRunsFixture = (responsibilityId: string): ResponsibilityRecentRuns => ({ responsibilityId, limit: 8, runs: [] });

// ---------------------------------------------------------------------------
// The section tables: every case each row's stat covers, and long content
// ---------------------------------------------------------------------------

const HOUR = 60;
const DAY = 24 * HOUR;
const agoDate = (minutes: number) => new Date(ago(minutes));
const [docArtifact, csvArtifact] = fundraisingDetail.artifacts;

/**
 * Every case the tables' stats cover: routines that succeeded, failed, never
 * ran, are paused and are running; projects due, late and with no date (two
 * with progress); open tasks and two done ones to reveal; a skill held by more
 * agents than a row shows; artifacts of different kinds.
 */
export const everyCaseDetail: ResponsibilityDetail = responsibilityDetailFixture({ ...fundraisingDetail, id: "resp-every-case" }, {
  skills: [
    ...fundraisingDetail.skills,
    {
      linkId: null,
      computed: true,
      id: "skill-market-scan",
      key: "paperclip/market-scan",
      slug: "market-scan",
      name: "Market scan",
      description: "Watches competitors' prices and launches.",
      tagline: null,
      iconUrl: null,
      color: null,
      agentIds: ["agent-codex", RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, "agent-analyst", "agent-scout", "agent-writer"],
    },
  ],
  artifacts: [
    ...fundraisingDetail.artifacts,
    {
      ...docArtifact!,
      id: "artifact-terms-pdf",
      title: "term-sheet-draft.pdf",
      source: "attachment",
      mediaKind: "file",
      contentType: "application/pdf",
      issue: { id: "task-scan", identifier: "PAP-12", title: "Fix the scan that timed out on Nov 4" },
      href: "/issues/PAP-12#attachment-terms",
      updatedAt: ago(5 * DAY),
    },
  ],
  projects: [
    { linkId: "link-project-room", id: "project-room", name: "Data room", status: "in_progress", targetDate: "2026-11-27", leadAgentId: "agent-codex", archivedAt: null, progress: { done: 4, total: 10 } },
    { linkId: "link-project-deck", id: "project-deck", name: "Investor update deck", status: "in_progress", targetDate: "2026-11-08", leadAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, archivedAt: null, progress: { done: 2, total: 5 } },
    { linkId: "link-project-pipeline", id: "project-pipeline", name: "Lead investor pipeline", status: "planned", targetDate: null, leadAgentId: null, archivedAt: null, progress: null },
  ],
  tasks: [
    { id: "task-summary", identifier: "PAP-10", title: "Summarise October price changes", status: "in_review", assigneeAgentId: "agent-codex", assigneeUserId: null, projectId: null, membership: "direct", linkId: "link-task-summary", updatedAt: agoDate(DAY) },
    { id: "task-collab", identifier: "PAP-11", title: "Add creator-collab tracking", status: "in_progress", assigneeAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, assigneeUserId: null, projectId: null, membership: "direct", linkId: "link-task-collab", updatedAt: agoDate(2 * DAY) },
    { id: "task-scan", identifier: "PAP-12", title: "Fix the scan that timed out on Nov 4", status: "todo", assigneeAgentId: null, assigneeUserId: "user-storybook", projectId: "project-room", membership: "project", linkId: null, updatedAt: agoDate(3 * DAY) },
    { id: "task-october", identifier: "PAP-8", title: "Send the October update", status: "done", assigneeAgentId: "agent-codex", assigneeUserId: null, projectId: null, membership: "direct", linkId: "link-task-october", updatedAt: agoDate(9 * DAY) },
    { id: "task-list", identifier: "PAP-9", title: "Build the first investor list", status: "done", assigneeAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, assigneeUserId: null, projectId: null, membership: "direct", linkId: "link-task-list", updatedAt: agoDate(12 * DAY) },
  ],
  routines: [
    { linkId: "link-routine-board", membership: "direct", id: "routine-board", title: "Board prep digest", status: "active", assigneeAgentId: "agent-codex", projectId: null, lastRun: null },
    { linkId: "link-routine-crm", membership: "direct", id: "routine-crm", title: "CRM sync", status: "active", assigneeAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, projectId: null, lastRun: { outcome: "failed", at: agoDate(2 * DAY) } },
    { linkId: "link-routine-inbox", membership: "direct", id: "routine-inbox", title: "Daily inbox sweep", status: "active", assigneeAgentId: "agent-codex", projectId: null, lastRun: { outcome: "running", at: agoDate(3 * HOUR) } },
    { linkId: null, membership: "project", id: "routine-letter", title: "Monthly LP letter", status: "paused", assigneeAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, projectId: "project-deck", lastRun: { outcome: "succeeded", at: agoDate(20 * DAY) } },
    { linkId: "link-routine-weekly", membership: "direct", id: "routine-weekly", title: "Weekly investor pipeline review", status: "active", assigneeAgentId: "agent-codex", projectId: null, lastRun: { outcome: "succeeded", at: agoDate(8 * HOUR) } },
  ],
});

const LONG = "so that every prospective limited partner in the December close hears from us with a specific next step at least every two weeks";

/** Long names everywhere, to show truncation and that the stat and avatar columns hold their place. */
export const longContentDetail: ResponsibilityDetail = responsibilityDetailFixture({ ...fundraisingDetail, id: "resp-long-content" }, {
  skills: [{ ...fundraisingDetail.skills[0]!, id: "skill-long", name: `Investor research and qualification ${LONG}` }],
  artifacts: [
    { ...csvArtifact!, id: "artifact-long", title: `investor-pipeline-with-every-qualified-lead-and-their-last-contact-date-${"and-notes-".repeat(6)}final.csv` },
  ],
  projects: [
    { linkId: "link-project-long", id: "project-long", name: `Investor update deck ${LONG}`, status: "in_progress", targetDate: "2026-11-27", leadAgentId: "agent-codex", archivedAt: null, progress: { done: 7, total: 9 } },
  ],
  tasks: [
    { id: "task-long", identifier: "PAP-1042", title: `Draft the November investor update ${LONG}`, status: "in_progress", assigneeAgentId: "agent-codex", assigneeUserId: null, projectId: null, membership: "direct", linkId: "link-task-long", updatedAt: agoDate(12 * HOUR) },
  ],
  routines: [
    { linkId: "link-routine-long", membership: "direct", id: "routine-long", title: `Weekly investor pipeline review ${LONG}`, status: "active", assigneeAgentId: "agent-codex", projectId: null, lastRun: { outcome: "succeeded", at: agoDate(14 * DAY) } },
  ],
});

/** Runs for the long-content responsibility: one, on a task with a long title. */
export const longRunsFixture: ResponsibilityRecentRuns = {
  responsibilityId: longContentDetail.id,
  limit: 8,
  runs: [runFixture({ id: "run-long", issue: { id: "task-long", identifier: "PAP-1042", title: `Draft the November investor update ${LONG}` } })],
};

/** The runs read for a responsibility in these fixtures. */
export function runsFixtureFor(responsibilityId: string): ResponsibilityRecentRuns {
  if (responsibilityId === fundraisingDetail.id || responsibilityId === everyCaseDetail.id) return { ...recentRunsFixture, responsibilityId };
  if (responsibilityId === longContentDetail.id) return longRunsFixture;
  return noRunsFixture(responsibilityId);
}

const conversationTask = {
  issueId: BAR_FIXTURE_ISSUE_ID,
  identifier: "PAP-90",
  title: "Set the bar for Investor relations",
  status: "todo",
  agentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
  createdAt: new Date("2026-11-13T10:00:00Z"),
};

export type BarConversationFixtureState = "none" | "no_agent" | "discussing" | "proposal";

/** Where the bar conversation stands, for each state the module shows. */
export function barConversationFixture(responsibilityId: string, state: BarConversationFixtureState): ResponsibilityBarConversation {
  switch (state) {
    case "none":
      return { responsibilityId, state: "none", defaultAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, conversation: null, proposal: null };
    case "no_agent":
      return { responsibilityId, state: "none", defaultAgentId: null, conversation: null, proposal: null };
    case "discussing":
      return { responsibilityId, state: "discussing", defaultAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, conversation: conversationTask, proposal: null };
    case "proposal":
      return {
        responsibilityId,
        state: "proposal_waiting",
        defaultAgentId: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID,
        conversation: conversationTask,
        proposal: barProposalWithMetricsFixture(),
      };
  }
}
