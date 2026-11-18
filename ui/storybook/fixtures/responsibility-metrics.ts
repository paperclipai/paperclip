import type {
  ProposeResponsibilityBarInteraction,
  ResponsibilityMetricPoint,
  ResponsibilityMetricSet,
  ResponsibilityMetricView,
  ResponsibilityStatusReportState,
} from "@paperclipai/shared";
import { RESPONSIBILITY_FIXTURE_NOW } from "./responsibilities";
import { BAR_FIXTURE_AGENT_ID, barProposalFixture } from "./responsibility-bars";

/**
 * Synthetic metric sets for a responsibility's bar module, for stories and UI
 * tests: the bar's own metric and supporting ones in every display form,
 * starters, sparse histories (none, one), a stale reading, and the
 * agent-written status the bar card leads with.
 */

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
export const METRIC_FIXTURE_AGENT_ID = "agent-codex";

/** Weekly readings ending `endDaysAgo` days before the fixture's now, oldest first. */
export function weeklyReadings(values: readonly number[], endDaysAgo = 1, id = "reading"): ResponsibilityMetricPoint[] {
  const end = RESPONSIBILITY_FIXTURE_NOW.getTime() - endDaysAgo * DAY_MS;
  return values.map((value, index) => ({
    id: `${id}-${index}`,
    value,
    recordedAt: new Date(end - (values.length - 1 - index) * WEEK_MS).toISOString(),
    recordedByAgentId: METRIC_FIXTURE_AGENT_ID,
    recordedByUserId: null,
  }));
}

function view(overrides: Partial<ResponsibilityMetricView> & Pick<ResponsibilityMetricView, "key" | "title" | "display">): ResponsibilityMetricView {
  const readings = overrides.readings ?? [];
  return {
    id: null,
    role: "supporting",
    starter: null,
    description: null,
    unit: null,
    target: null,
    direction: null,
    kind: null,
    low: null,
    high: null,
    period: overrides.display === "bar" ? "week" : null,
    stale: false,
    note: null,
    health: null,
    ...overrides,
    // The newest reading always follows the readings.
    readings,
    latest: readings.at(-1) ?? null,
  };
}

/** The bar's own metric for "Seed extension": investors contacted, 9 of 20, climbing. */
export const primaryLine = view({
  key: "primary",
  role: "primary",
  title: "Investors contacted",
  description: "On track at 20 or more; at risk from 15",
  display: "line",
  target: 20,
  direction: "at_least",
  kind: "volume",
  health: "behind",
  readings: weeklyReadings([2, 3, 3, 4, 6, 7, 8, 9], 1, "primary"),
});

export const primaryNumber = view({ ...primaryLine, key: "primary", display: "number", readings: weeklyReadings([9], 1, "primary") });

export const meetingsBar = view({
  key: "metric-meetings",
  id: "metric-meetings",
  title: "Intro meetings booked per week",
  description: "Calendar events with a prospective investor booked that week, from the shared calendar.",
  display: "bar",
  target: 3,
  direction: "at_least",
  readings: weeklyReadings([1, 2, 0, 3, 2, 4, 3, 5], 1, "meetings"),
});

export const repliesPercent = view({
  key: "metric-replies",
  id: "metric-replies",
  title: "Investor emails answered within a day",
  description: "Share of inbound investor emails with a reply inside 24 hours, counted each Friday.",
  display: "percent",
  unit: "%",
  target: 90,
  direction: "at_least",
  readings: weeklyReadings([71, 75, 78, 80, 82], 2, "replies"),
});

export const pipelineNumber = view({
  key: "metric-pipeline",
  id: "metric-pipeline",
  title: "Committed so far",
  description: "Signed commitments in the data room, summed.",
  display: "number",
  unit: "$",
  target: 1_500_000,
  direction: "at_least",
  readings: weeklyReadings([400_000, 650_000, 900_000], 3, "pipeline"),
});

export const replyTimeLine = view({
  key: "metric-reply-time",
  id: "metric-reply-time",
  title: "Average reply time",
  description: "Hours from an investor's email to our first reply, averaged over the week.",
  display: "line",
  unit: "hours",
  target: 24,
  direction: "at_most",
  readings: weeklyReadings([30, 28, 31, 29, 30, 32, 31, 33, 34, 35], 1, "reply-time"),
});

/** Read 20 days ago: the stale flag shows. */
export const staleBar = view({
  ...meetingsBar,
  key: "metric-meetings-stale",
  id: "metric-meetings-stale",
  readings: weeklyReadings([2, 3, 1, 2], 20, "stale"),
  stale: true,
});

export const noReadingsLine = view({
  key: "metric-empty-line",
  id: "metric-empty-line",
  title: "Follow-ups sent within two days",
  description: "Follow-up emails sent within 48 hours of a first meeting.",
  display: "line",
  target: 10,
  direction: "at_least",
});

export const noReadingPercent = view({
  key: "metric-empty-percent",
  id: "metric-empty-percent",
  title: "Data room complete",
  description: "Share of the diligence checklist with a document in the data room.",
  display: "percent",
  unit: "%",
  target: 100,
  direction: "at_least",
});

export const oneReadingLine = view({ ...noReadingsLine, key: "metric-one-line", id: "metric-one-line", readings: weeklyReadings([4], 2, "one") });

export function metricSetFixture(
  metrics: ResponsibilityMetricView[],
  overrides: Partial<ResponsibilityMetricSet> = {},
): ResponsibilityMetricSet {
  return {
    responsibilityId: "resp-fundraising",
    source: "chosen",
    chosenBy: { agentId: METRIC_FIXTURE_AGENT_ID, userId: null },
    metrics,
    historyLimit: 12,
    ...overrides,
  };
}

/** The agent's set for "Seed extension": a line, bars per week and a share. */
export const chosenMetricSet = metricSetFixture([primaryLine, meetingsBar, repliesPercent]);

/** What a responsibility nobody chose metrics for shows: computed from its work. */
export const starterMetricSet = metricSetFixture([
  view({ ...primaryNumber, key: "starter:bar_metric", starter: "bar_metric" }),
  view({
    key: "starter:tasks_finished",
    starter: "tasks_finished",
    title: "Tasks finished per week",
    description: "Tasks under this responsibility marked done, per week, over the last 6 weeks.",
    display: "bar",
    readings: weeklyReadings([1, 0, 2, 3, 1, 2], 0, "finished").map((point) => ({ ...point, id: null, recordedByAgentId: null })),
  }),
  view({
    key: "starter:open_tasks",
    starter: "open_tasks",
    title: "Open tasks",
    description: "Tasks under this responsibility that are not done or cancelled, counted now.",
    display: "number",
    note: "1 blocked",
    readings: weeklyReadings([4], 0, "open").map((point) => ({ ...point, id: null, recordedByAgentId: null })),
  }),
], { source: "starter", chosenBy: null });

export const METRIC_SET_FIXTURES = {
  chosen: chosenMetricSet,
  starter: starterMetricSet,
  one: metricSetFixture([primaryNumber]),
  two: metricSetFixture([primaryLine, replyTimeLine]),
  forms: metricSetFixture([pipelineNumber, repliesPercent, meetingsBar]),
  stale: metricSetFixture([primaryLine, staleBar, replyTimeLine]),
  empty: metricSetFixture([view({ ...primaryLine, readings: [] }), noReadingsLine, noReadingPercent]),
  sparse: metricSetFixture([primaryNumber, oneReadingLine, noReadingsLine]),
} satisfies Record<string, ResponsibilityMetricSet>;

/** The agent-written status a bar card leads with. */
export function statusReportFixture(overrides: Partial<NonNullable<ResponsibilityStatusReportState["current"]>> = {}, state: Partial<ResponsibilityStatusReportState> = {}): ResponsibilityStatusReportState {
  const current = {
    status: "at_risk" as const,
    message: "Meetings are up, but replies are slipping and the deck is late, so the December target is at risk.",
    detail: null,
    agentId: METRIC_FIXTURE_AGENT_ID,
    userId: null,
    writtenAt: new Date(RESPONSIBILITY_FIXTURE_NOW.getTime() - 2 * DAY_MS).toISOString(),
    outOfDate: false,
    ...overrides,
  };
  return {
    current,
    reporterAgentId: METRIC_FIXTURE_AGENT_ID,
    updateRequested: false,
    history: [{ status: current.status, message: current.message, agentId: current.agentId, userId: current.userId, writtenAt: current.writtenAt }],
    ...state,
  };
}

/** A bar proposal carrying a metric set: the bar's metric as a line, plus bars per week and a share with starting readings. */
export function barProposalWithMetricsFixture(overrides: Partial<ProposeResponsibilityBarInteraction> = {}): ProposeResponsibilityBarInteraction {
  const base = barProposalFixture("percentage");
  return {
    ...base,
    id: "bar-proposal-with-metrics",
    ...overrides,
    payload: {
      ...base.payload,
      primaryDisplay: "line",
      metrics: [
        {
          title: "Intro calls booked per week",
          description: "Calls with a prospective LP booked that week, from the shared calendar.",
          display: "bar",
          unit: null,
          target: 3,
          direction: "at_least",
          readings: weeklyReadings([1, 2, 2, 4, 3], 1, "calls").map(({ value, recordedAt }) => ({ value, recordedAt })),
          readingsEvidence: "Counted from the last five weeks of the shared calendar.",
        },
        {
          title: "LP emails answered within a day",
          description: "Share of inbound LP emails with a reply inside 24 hours, counted each Friday.",
          display: "percent",
          unit: "%",
          target: 90,
          direction: "at_least",
          readings: [],
          readingsEvidence: null,
        },
      ],
    },
    createdByAgentId: BAR_FIXTURE_AGENT_ID,
  };
}
