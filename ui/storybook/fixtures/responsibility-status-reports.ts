import type {
  ResponsibilityHealth,
  ResponsibilityOverview,
  ResponsibilityStatusReportCurrent,
  ResponsibilityStatusReportStatus,
  ResponsibilityStatusReportsOverview,
  ResponsibilityStatusReportSummary,
} from "@paperclipai/shared";
import {
  areaFixture,
  metricFixture,
  responsibilityFixture,
  responsibilityOverviewFixture,
  RESPONSIBILITY_FIXTURE_NOW,
  RESPONSIBILITY_FIXTURE_OWNER_ID,
} from "./responsibilities";

/**
 * Agent-written status for the Dashboard's Agent status view (experimental
 * `enableResponsibilities`): reports over the home and dense overviews, in
 * every state a row can be in: fresh, out of date, written by a person, and
 * none written (from the number), with an update asked for.
 */

const DAY_MS = 86_400_000;

function daysAgo(days: number) {
  return new Date(RESPONSIBILITY_FIXTURE_NOW.getTime() - days * DAY_MS).toISOString();
}

export function statusReportFixture(input: {
  status: ResponsibilityStatusReportStatus;
  message: string;
  agentId?: string | null;
  userId?: string | null;
  detail?: string | null;
  daysAgo?: number;
}): ResponsibilityStatusReportCurrent {
  const age = input.daysAgo ?? 1;
  return {
    status: input.status,
    message: input.message,
    detail: input.detail ?? null,
    agentId: input.userId ? null : input.agentId ?? "agent-codex",
    userId: input.userId ?? null,
    writtenAt: daysAgo(age),
    outOfDate: age > 7,
  };
}

export function statusSummaryFixture(
  responsibilityId: string,
  current: ResponsibilityStatusReportCurrent | null,
  options: Partial<Omit<ResponsibilityStatusReportSummary, "responsibilityId" | "current">> = {},
): ResponsibilityStatusReportSummary {
  return {
    responsibilityId,
    current,
    reporterAgentId: options.reporterAgentId === undefined ? "agent-codex" : options.reporterAgentId,
    reporterBasis: options.reporterBasis ?? "works_under",
    updateRequested: options.updateRequested ?? false,
  };
}

export function statusReportsOverviewFixture(reports: ResponsibilityStatusReportSummary[]): ResponsibilityStatusReportsOverview {
  return { ownerUserId: RESPONSIBILITY_FIXTURE_OWNER_ID, freshDays: 7, reports };
}

/**
 * Over the home overview: Seed extension behind by CodexCoder (fresh, with
 * detail), LP updates at risk by the CTO nine days ago (out of date), Founder
 * support on track by CodexCoder, Hiring with no report and an update asked
 * of the CTO, and Board reporting corrected by the person.
 */
export const mixedStatusReportsFixture = statusReportsOverviewFixture([
  statusSummaryFixture("resp-fundraising", statusReportFixture({
    status: "behind",
    message: "Nine of twenty contacted, and the deck the rest are waiting for is three days late.",
    detail: "Counsel still has the cap table. Once it lands the deck goes out the same day.",
    daysAgo: 1,
  })),
  statusSummaryFixture("resp-lp-updates", statusReportFixture({
    status: "at_risk",
    message: "October's letter went to half the list before the mail merge broke.",
    agentId: "agent-cto",
    daysAgo: 9,
  }), { reporterAgentId: "agent-cto" }),
  statusSummaryFixture("resp-portfolio", statusReportFixture({
    status: "on_track",
    message: "Twelve straight weeks of check-ins with every founder.",
    daysAgo: 0,
  })),
  statusSummaryFixture("resp-hiring", null, { reporterAgentId: "agent-cto", reporterBasis: "top_agent", updateRequested: true }),
  statusSummaryFixture("resp-board-reporting", statusReportFixture({
    status: "at_risk",
    message: "The deck is drafted but the numbers wait on the October close.",
    userId: RESPONSIBILITY_FIXTURE_OWNER_ID,
    daysAgo: 2,
  })),
]);

/** Over the home overview: every status written by an agent this week. */
export const allFreshStatusReportsFixture = statusReportsOverviewFixture([
  statusSummaryFixture("resp-fundraising", statusReportFixture({ status: "behind", message: "Nine of twenty contacted; the deck is three days late." })),
  statusSummaryFixture("resp-lp-updates", statusReportFixture({ status: "at_risk", message: "Half the list got October's letter; the rest go out Friday.", agentId: "agent-cto" }), { reporterAgentId: "agent-cto" }),
  statusSummaryFixture("resp-portfolio", statusReportFixture({ status: "on_track", message: "Twelve straight weeks of check-ins with every founder.", daysAgo: 0 })),
  statusSummaryFixture("resp-hiring", statusReportFixture({ status: "unknown", message: "No pipeline numbers since the recruiter changed tools; checking the new board.", agentId: "agent-cto" }), { reporterAgentId: "agent-cto" }),
  statusSummaryFixture("resp-board-reporting", statusReportFixture({ status: "on_track", message: "Deck sent nine days before the meeting.", daysAgo: 3 })),
]);

/** Over the home overview: nothing written yet; every row falls back to its number. */
export const noneWrittenStatusReportsFixture = statusReportsOverviewFixture(
  ["resp-fundraising", "resp-lp-updates", "resp-portfolio", "resp-hiring", "resp-board-reporting"].map((id) =>
    statusSummaryFixture(id, null, { reporterAgentId: id === "resp-hiring" ? "agent-cto" : "agent-codex" })),
);

// ---------------------------------------------------------------------------
// Dense: 46 responsibilities across 22 areas, as one of the demo dashboards has.
// ---------------------------------------------------------------------------

const DENSE_AREAS = [
  "Onboarding", "Information architecture", "Design system", "Navigation", "Chat", "Tasks", "Inbox", "Agents",
  "Routines", "Responsibilities", "Mobile", "Accessibility", "Performance", "Reliability", "Security", "Pricing",
  "Growth", "Docs", "Support", "Research", "Hiring", "Brand",
];

const DENSE_STATUSES: ResponsibilityHealth[] = ["on_track", "at_risk", "behind", "on_track", "not_measured", "on_track", "at_risk"];
const DENSE_MESSAGES: Record<ResponsibilityStatusReportStatus, string[]> = {
  on_track: ["Twelve straight weeks of improvement.", "Holding at 1.3 MB with the font cleanup still to land.", "Every request answered inside a day this month."],
  at_risk: ["Drifted from 2.1 s to 2.4 s as the catalogue grew.", "Two of five reviews slipped past their date this week.", "The new flow ships Friday if QA clears it Thursday."],
  behind: ["Stuck at 47% since the wizard change; the fix is blocked on design.", "Three weeks without a release while the migration is stuck."],
  unknown: ["No reading since the analytics source changed; checking the new one."],
};

const denseAreas = DENSE_AREAS.map((title, index) => areaFixture({ id: `area-dense-${index}`, title, sortOrder: index }));

const denseResponsibilities = Array.from({ length: 46 }, (_, index) => {
  const area = denseAreas[index % denseAreas.length]!;
  const health = DENSE_STATUSES[index % DENSE_STATUSES.length]!;
  const percent = index % 3 === 0;
  return responsibilityFixture({
    id: `resp-dense-${index}`,
    areaId: area.id,
    title: `${area.title} ${index < 22 ? "quality" : "speed"}`,
    standard: index % 9 === 4 ? null : `${area.title} stays good enough that nobody has to ask about it (${index + 1}).`,
    metricName: "Measure",
    sortOrder: index,
    rollup: {
      health,
      computedHealth: health,
      statusSentence: health === "not_measured" ? "Not measured: no reading yet" : `${60 + (index % 40)}% of target`,
      metric: health === "not_measured" && index % 2 === 0
        ? null
        : metricFixture(percent
          ? { name: "Signups who finish", unit: "%", kind: "percentage", target: 60, current: 40 + (index % 25), attainment: 0.8 }
          : { name: "Page weight", unit: "MB", target: 1.5, current: 1.3 + (index % 5) / 10, direction: "at_most", attainment: 0.9 }),
    },
  });
});

export const denseAgentStatusOverviewFixture: ResponsibilityOverview = responsibilityOverviewFixture(denseResponsibilities, [], { areas: denseAreas });

const DENSE_AGENTS = ["agent-codex", "agent-cto", "agent-qa"];

export const denseStatusReportsFixture = statusReportsOverviewFixture(denseResponsibilities.map((item, index) => {
  const agentId = DENSE_AGENTS[index % DENSE_AGENTS.length]!;
  // About two in three are written; a few of those are out of date.
  if (index % 3 === 2) return statusSummaryFixture(item.id, null, { reporterAgentId: agentId, updateRequested: index % 6 === 5 });
  const status: ResponsibilityStatusReportStatus = item.rollup.health === "not_measured" ? "unknown" : item.rollup.health;
  const messages = DENSE_MESSAGES[status];
  return statusSummaryFixture(item.id, statusReportFixture({
    status,
    message: messages[index % messages.length]!,
    agentId,
    daysAgo: index % 5 === 0 ? 11 : index % 4,
  }), { reporterAgentId: agentId });
}));
