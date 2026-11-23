import type {
  ProposeResponsibilityBarInteraction,
  ProposeResponsibilityBarPayload,
  ResponsibilityMetricKind,
  ResponsibilityMetricSummary,
} from "@paperclipai/shared";
import { metricFixture, RESPONSIBILITY_FIXTURE_COMPANY_ID } from "./responsibilities";

/** Synthetic bar proposals and one metric of each bar template, for stories and UI tests. */
export const BAR_FIXTURE_AGENT_ID = "agent-cto";
export const BAR_FIXTURE_ISSUE_ID = "issue-bar-conversation";
export const BAR_FIXTURE_RESPONSIBILITY_ID = "resp-fundraising";

const PAYLOADS: Record<ResponsibilityMetricKind, ProposeResponsibilityBarPayload> = {
  volume: {
    version: 1,
    responsibilityId: BAR_FIXTURE_RESPONSIBILITY_ID,
    responsibilityTitle: "Escalated support",
    bar: {
      standard: "No escalated ticket waits a full day for a first reply.",
      metricKind: "volume",
      metricName: "Escalated tickets waiting over a day",
      metricUnit: null,
      metricDirection: "at_most",
      metricTarget: 0,
      metricLow: null,
      metricHigh: null,
    },
    metricCurrent: 3,
    currentEvidence: "3 of the 11 open escalations in the support inbox are older than a day",
    message: "You said a day is the line customers notice, so I counted what crosses it.",
    templateLabel: "Volume",
    targetLabel: "At most 0",
    readingLabel: "3",
    statusRule: "On track at 0 or less; behind above that",
    preview: { health: "behind", statusSentence: "Escalated tickets waiting over a day: 3 against a target of at most 0" },
  },
  percentage: {
    version: 1,
    responsibilityId: BAR_FIXTURE_RESPONSIBILITY_ID,
    responsibilityTitle: "LP relationships",
    bar: {
      standard: "Every prospective LP hears from us at least every two weeks.",
      metricKind: "percentage",
      metricName: "Prospective LPs contacted in the last 14 days",
      metricUnit: "%",
      metricDirection: "at_least",
      metricTarget: 90,
      metricLow: null,
      metricHigh: null,
    },
    metricCurrent: 79,
    currentEvidence: "11 of your 14 prospective LPs heard from you in the last two weeks",
    message: null,
    templateLabel: "Percentage",
    targetLabel: "At least 90%",
    readingLabel: "79%",
    statusRule: "On track at 90% or more; at risk from 68%",
    preview: { health: "at_risk", statusSentence: "Prospective LPs contacted in the last 14 days: 79% against a target of at least 90%" },
  },
  yes_no: {
    version: 1,
    responsibilityId: BAR_FIXTURE_RESPONSIBILITY_ID,
    responsibilityTitle: "Board meetings",
    bar: {
      standard: "Directors get the board pack a full week before every meeting.",
      metricKind: "yes_no",
      metricName: "Board pack sent a week before the next meeting",
      metricUnit: null,
      metricDirection: null,
      metricTarget: null,
      metricLow: null,
      metricHigh: null,
    },
    metricCurrent: null,
    currentEvidence: null,
    message: "There is nothing to count here; it either went out on time or it did not.",
    templateLabel: "Yes or no",
    targetLabel: "Yes",
    readingLabel: null,
    statusRule: "On track when the answer is yes; behind when it is no",
    preview: null,
  },
  range: {
    version: 1,
    responsibilityId: BAR_FIXTURE_RESPONSIBILITY_ID,
    responsibilityTitle: "Runway",
    bar: {
      standard: "We always have between 12 and 24 months of runway.",
      metricKind: "range",
      metricName: "Runway",
      metricUnit: "months",
      metricDirection: null,
      metricTarget: null,
      metricLow: 12,
      metricHigh: 24,
    },
    metricCurrent: 10,
    currentEvidence: "Cash on hand over the last three months' average burn",
    message: "Too little runway is a risk, and so is sitting on too much cash, so this is a range.",
    templateLabel: "Range",
    targetLabel: "Between 12 and 24 months",
    readingLabel: "10 months",
    statusRule: "On track between 12 and 24 months; at risk up to 3 months outside it; behind further out",
    preview: { health: "at_risk", statusSentence: "Runway: 10 months, 2 months below the range of 12 to 24 months" },
  },
};

export function barProposalFixture(
  kind: ResponsibilityMetricKind,
  overrides: Partial<ProposeResponsibilityBarInteraction> = {},
): ProposeResponsibilityBarInteraction {
  return {
    id: `bar-proposal-${kind}`,
    companyId: RESPONSIBILITY_FIXTURE_COMPANY_ID,
    issueId: BAR_FIXTURE_ISSUE_ID,
    kind: "propose_responsibility_bar",
    status: "pending",
    continuationPolicy: "none",
    createdByAgentId: BAR_FIXTURE_AGENT_ID,
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    title: "Proposed bar",
    summary: PAYLOADS[kind].bar.standard,
    resolverPolicy: "human_only",
    requestedResolverPolicy: "human_only",
    effectiveResolverPolicy: "human_only",
    resolverPolicyProvenance: "explicit",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: "board_only", effective: "board_only" },
    createdAt: new Date("2026-11-13T10:00:00.000Z"),
    updatedAt: new Date("2026-11-13T10:00:00.000Z"),
    payload: PAYLOADS[kind],
    result: null,
    ...overrides,
  } as ProposeResponsibilityBarInteraction;
}

/** One metric of each template, as the rollup reports it. */
export const METRIC_OF_EACH_TEMPLATE: Record<ResponsibilityMetricKind, ResponsibilityMetricSummary> = {
  volume: metricFixture({
    name: "Replies owed for more than a week", target: 5, current: 9, direction: "at_most", attainment: 0.5556,
    statusRule: "On track at 5 or less; at risk up to 6.67", updatedAt: new Date("2026-11-12T09:00:00Z"),
  }),
  percentage: metricFixture({
    kind: "percentage", name: "Invoices paid on time", unit: "%", target: 95, current: 82, attainment: 0.8632,
    statusRule: "On track at 95% or more; at risk from 72%", updatedAt: new Date("2026-11-12T09:00:00Z"),
  }),
  yes_no: metricFixture({
    kind: "yes_no", name: "Board pack sent a week before the meeting", target: null, direction: null, current: 1, attainment: 1,
    statusRule: "On track when the answer is yes; behind when it is no", updatedAt: new Date("2026-11-12T09:00:00Z"),
  }),
  range: metricFixture({
    kind: "range", name: "Runway", unit: "months", target: null, direction: null, low: 12, high: 24, current: 26, attainment: 0.8333,
    statusRule: "On track between 12 and 24 months; at risk up to 3 months outside it; behind further out",
    updatedAt: new Date("2026-11-12T09:00:00Z"),
  }),
};
