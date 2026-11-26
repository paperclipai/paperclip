import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  issueThreadInteractions,
  responsibilities,
  responsibilityAreas,
  responsibilityMetricReadings,
} from "@paperclipai/db";
import {
  RESPONSIBILITY_BAR_ORIGIN_KIND,
  RESPONSIBILITY_BAR_TEMPLATES,
  RESPONSIBILITY_METRIC_DISPLAY_LABEL,
  RESPONSIBILITY_METRIC_KINDS,
  RESPONSIBILITY_PRIMARY_METRIC_POSITION,
  RESPONSIBILITY_SUPPORTING_METRIC_LIMIT,
  RESPONSIBILITY_VISUALIZATION_LABEL,
  formatResponsibilityReading,
  resolveResponsibilityMetricKind,
  responsibilityKindHasTarget,
  responsibilityTargetLabel,
  type ProposeResponsibilityBarPayload,
  type ResponsibilityBarMetric,
  type ResponsibilityMetricDisplay,
} from "@paperclipai/shared";
import { activeMetricRows } from "./responsibility-metric-store.js";

/**
 * The standing instructions for the agent in a responsibility's bar
 * conversation. They ride on the per-task prompt (legacy adapters and native
 * runners alike), because native agents do not receive the paperclip skill.
 * This module reads only rows, so the heartbeat can import it without the
 * services behind the bar conversation itself (responsibility-bars.ts).
 */

type ResponsibilityRow = typeof responsibilities.$inferSelect;

const PROPOSAL_HISTORY = 3;

/** The bar a row holds today, in one line, or null when it has none. */
function describeCurrentBar(row: ResponsibilityRow) {
  const name = row.metricName?.trim();
  const metric: ResponsibilityBarMetric | null = name ? (() => {
    const kind = resolveResponsibilityMetricKind(row.metricKind, row.metricUnit);
    const usesTarget = responsibilityKindHasTarget(kind);
    return {
      kind,
      name,
      unit: kind === "percentage" ? "%" : kind === "yes_no" ? null : row.metricUnit?.trim() || null,
      direction: usesTarget ? (row.metricDirection as ResponsibilityBarMetric["direction"]) ?? "at_least" : null,
      target: usesTarget && row.metricTarget !== null ? Number(row.metricTarget) : null,
      low: kind === "range" && row.metricLow !== null ? Number(row.metricLow) : null,
      high: kind === "range" && row.metricHigh !== null ? Number(row.metricHigh) : null,
    };
  })() : null;
  if (!row.standard?.trim() && !metric) return null;
  const parts: string[] = [];
  if (row.standard?.trim()) parts.push(`"${row.standard.trim()}"`);
  if (metric) {
    const target = responsibilityTargetLabel(metric);
    parts.push(`${RESPONSIBILITY_BAR_TEMPLATES[metric.kind].label}: ${metric.name}${target ? ` (${target.toLowerCase()})` : ""}`);
    const current = row.metricCurrent === null ? null : Number(row.metricCurrent);
    parts.push(current === null ? "no reading yet" : `reading ${formatResponsibilityReading(metric, current)}`);
  }
  return parts.join("; ");
}

/**
 * Null unless the task is a bar conversation assigned to this agent and its
 * responsibility still exists. The caller checks the experimental flag.
 */
export async function loadResponsibilityBarGuidance(db: Db, input: {
  issue: { id: string; companyId: string; originKind: string | null; originId: string | null; assigneeAgentId: string | null };
  agentId: string;
}): Promise<string | null> {
  const { issue } = input;
  if (issue.originKind !== RESPONSIBILITY_BAR_ORIGIN_KIND || !issue.originId || issue.assigneeAgentId !== input.agentId) {
    return null;
  }
  const [row] = await db.select().from(responsibilities)
    .where(and(eq(responsibilities.id, issue.originId), eq(responsibilities.companyId, issue.companyId)));
  if (!row) return null;
  const [area, owner, runner, history, metricRows] = await Promise.all([
    row.areaId
      ? db.select({ title: responsibilityAreas.title }).from(responsibilityAreas)
        .where(and(eq(responsibilityAreas.id, row.areaId), eq(responsibilityAreas.companyId, row.companyId)))
        .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, row.ownerUserId))
      .then((rows) => rows[0] ?? null),
    row.runByAgentId
      ? db.select({ name: agents.name }).from(agents)
        .where(and(eq(agents.id, row.runByAgentId), eq(agents.companyId, row.companyId)))
        .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    db.select({
      status: issueThreadInteractions.status,
      payload: issueThreadInteractions.payload,
      result: issueThreadInteractions.result,
    }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, issue.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.kind, "propose_responsibility_bar"),
    )).orderBy(desc(issueThreadInteractions.createdAt)).limit(PROPOSAL_HISTORY),
    activeMetricRows(db, row),
  ]);
  const supportingRows = metricRows.filter((metric) => metric.position !== RESPONSIBILITY_PRIMARY_METRIC_POSITION);
  const latestReadings = await Promise.all(supportingRows.map((metric) =>
    db.select({ value: responsibilityMetricReadings.value, recordedAt: responsibilityMetricReadings.recordedAt })
      .from(responsibilityMetricReadings)
      .where(eq(responsibilityMetricReadings.metricId, metric.id))
      .orderBy(desc(responsibilityMetricReadings.recordedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null)));
  return buildResponsibilityBarGuidance({
    issueId: issue.id,
    responsibility: {
      title: row.title,
      description: row.description,
      status: row.status,
      area: area?.title ?? null,
      ownerName: owner?.name?.trim() || null,
      runByAgentName: runner?.name ?? null,
      currentBar: describeCurrentBar(row),
    },
    supportingMetrics: supportingRows.map((metric, index) => {
      const latest = latestReadings[index];
      return {
        title: metric.title,
        display: metric.display as ResponsibilityMetricDisplay,
        description: metric.description,
        latest: latest ? `${Number(latest.value)}${metric.display === "percent" ? "%" : metric.unit ? ` ${metric.unit}` : ""} on ${new Date(latest.recordedAt).toISOString().slice(0, 10)}` : null,
      };
    }),
    proposals: history.map((entry) => {
      const payload = entry.payload as Partial<ProposeResponsibilityBarPayload> | null;
      const result = entry.result as { outcome?: string; droppedMetrics?: string[] | null } | null;
      const dropped = result?.droppedMetrics?.filter(Boolean) ?? [];
      return {
        standard: payload?.bar?.standard ?? "",
        template: payload?.templateLabel ?? "",
        target: payload?.targetLabel ?? "",
        state: entry.status === "pending" ? "waiting for the person"
          : result?.outcome === "declined" ? "the person said it is not right"
            : result?.outcome === "replaced" ? "replaced by a later proposal"
              : result?.outcome === "accepted"
                ? dropped.length > 0 ? `accepted and applied without ${dropped.map((title) => `"${title}"`).join(" and ")} (the person dropped it)` : "accepted and applied"
                : "closed",
      };
    }),
  });
}

export interface ResponsibilityBarGuidanceInput {
  issueId: string;
  responsibility: {
    title: string;
    description: string | null;
    status: string;
    area: string | null;
    ownerName: string | null;
    runByAgentName: string | null;
    /** The bar in one line, or null when it has none. */
    currentBar: string | null;
  };
  /** The supporting metrics it has today (none when it shows starters). */
  supportingMetrics?: Array<{ title: string; display: ResponsibilityMetricDisplay; description: string | null; latest: string | null }>;
  /** Newest first. */
  proposals: Array<{ standard: string; template: string; target: string; state: string }>;
}

/** A bar proposal with a metric set, valid against the proposal schema. */
const METRIC_SET_EXAMPLE = {
  ...RESPONSIBILITY_BAR_TEMPLATES.percentage.example,
  metricKind: "percentage",
  primaryDisplay: "line",
  metrics: [
    {
      title: "Intro meetings booked per week",
      description: "Calendar events with a prospective LP booked that week, from the shared calendar",
      display: "bar",
      target: 3,
      direction: "at_least",
    },
    {
      title: "LP emails answered within a day",
      description: "Share of inbound LP emails with a reply within 24 hours, counted each Friday",
      display: "percent",
      target: 90,
    },
  ],
};

/** Pure: the bar-conversation instructions for the agent's per-task prompt. */
export function buildResponsibilityBarGuidance(input: ResponsibilityBarGuidanceInput): string {
  const { responsibility } = input;
  const person = responsibility.ownerName ?? "the person";
  const lines: string[] = [
    `This task is a conversation with ${person} about how success should be measured for one of their responsibilities. End it with one proposed bar they can accept with one tap. You never apply a bar yourself: only the person can, by accepting your proposal.`,
    "",
    "The responsibility:",
    `- Title: ${responsibility.title}`,
  ];
  if (responsibility.area) lines.push(`- Area: ${responsibility.area}`);
  if (responsibility.description?.trim()) lines.push(`- What it covers: ${responsibility.description.trim()}`);
  lines.push(`- Status: ${responsibility.status === "active" ? "confirmed" : "still proposed"}`);
  lines.push(`- Bar today: ${responsibility.currentBar ?? "none yet"}`);
  if (responsibility.runByAgentName) lines.push(`- Run by: ${responsibility.runByAgentName}`);
  const supporting = input.supportingMetrics ?? [];
  if (supporting.length > 0) {
    lines.push("- Supporting metrics today:");
    for (const metric of supporting) {
      lines.push(`  - ${metric.title} (${metric.display})${metric.description ? `: ${metric.description}` : ""}; ${metric.latest ? `latest ${metric.latest}` : "no reading yet"}`);
    }
  } else {
    lines.push("- Supporting metrics today: none chosen (the page shows starter metrics computed from the work)");
  }
  if (input.proposals.length > 0) {
    lines.push("", "Your proposals in this conversation, newest first:");
    for (const proposal of input.proposals) {
      lines.push(`- "${proposal.standard}" (${proposal.template}: ${proposal.target}): ${proposal.state}`);
    }
  }
  lines.push(
    "",
    "How to hold the conversation:",
    "1. Open with one or two sentences saying what you understand this responsibility to be and what matters about it.",
    "2. Ask at most three short questions, only what you cannot work out yourself, in one questions card (request_human_input with interactionKind \"questions\" on a native runner, otherwise an ask_user_questions interaction) with continuationPolicy wake_assignee. Prefer choices the person can tap over free text. Do not ask them to pick a template or a chart; that is your call.",
    "3. Propose the bar, with its metric set, in the call below. Then post one short line saying the proposal is ready, and mark this task done. The card stays open for the person after the task is done.",
    "4. If the person says the proposal is not right, or replies, you are woken here: ask what to change, or propose again. A new proposal replaces the waiting one, so there is only ever one.",
    "",
    "Templates (pick the one that fits):",
  );
  for (const kind of RESPONSIBILITY_METRIC_KINDS) {
    const template = RESPONSIBILITY_BAR_TEMPLATES[kind];
    const fields = template.fields.length > 0 ? `Fields: ${template.fields.join(", ")}` : "No target, unit or direction";
    lines.push(`- ${kind} (${template.label}): ${template.summary} ${template.whenItFits} ${fields}. metricCurrent is ${template.readingHelp}.`);
  }
  lines.push(
    "",
    "What makes a good bar:",
    "- Observable: someone can read today's value from a system or a simple count, without asking how anyone feels. A bar nobody can read goes stale.",
    "- Moves with the work: the projects, tasks and routines under it can move it within weeks.",
    "- A level to hold, not a finish line: the responsibility is ongoing, so the bar is a standard that stays true. A one-off result belongs to a project.",
    "- A target they would recognise: anchor it to what you know (today's level, or a common standard for the role); when it is your guess, keep it round and modest.",
    "- standard is one plain sentence saying what good looks like; metricName names exactly what is measured (for yes_no, the statement that should be true).",
    "- Set metricCurrent only for a reading you counted from real evidence, and say how in currentEvidence. Otherwise leave both out; the bar shows as not measured until someone reports a reading.",
    "",
    `The metric set: the bar's own metric is the primary one; you may add up to ${RESPONSIBILITY_SUPPORTING_METRIC_LIMIT} supporting metrics, so the page shows up to three that track this responsibility's health. Give the person something to start with, but only metrics worth watching:`,
    "- A good supporting metric explains movement in the primary one (a leading signal or a driver of it), or catches a failure the primary one would miss (quality slipping while the count holds, work piling up behind it).",
    "- Prefer something an agent can actually observe and record from a system or a simple count, week after week. Someone has to keep it current.",
    "- Do not propose a chart of something that has no history and will not get any: a line or bars need readings over time. A one-off fact belongs in the bar's sentence or a task, not a metric.",
    "- Each metric measures something different from the primary and from each other. Two strong metrics beat three weak ones; zero is fine.",
    "Which display fits which data (primaryDisplay for the bar's own metric, display for each supporting one):",
    `- number (${RESPONSIBILITY_METRIC_DISPLAY_LABEL.number}): a current count or amount that matters as it stands (open escalations, cash on hand); shows the target beside it.`,
    `- percent (${RESPONSIBILITY_METRIC_DISPLAY_LABEL.percent}): a share from 0 to 100 against a target (replies within a day); its unit is always %.`,
    `- line (${RESPONSIBILITY_METRIC_DISPLAY_LABEL.line}): a level read again and again where the trend matters (response time, pipeline value); draws the target as a reference line.`,
    `- bar (${RESPONSIBILITY_METRIC_DISPLAY_LABEL.bar}): something counted per week (meetings booked, tickets closed); each reading is one week's total.`,
    "- A yes_no bar's own metric is always a number; a percentage bar's can be a percent, line, bar or number; volume and range can be a number, line or bar.",
    "The page shows every metric as one of five visualizations, by these names, and nothing else; the person never fills in a chart. Choose from them:",
    `- ${RESPONSIBILITY_VISUALIZATION_LABEL.number} (display number): a large value against its target. Fits a count or amount that matters as it stands.`,
    `- ${RESPONSIBILITY_VISUALIZATION_LABEL.percent} (display percent): a ring filling toward a target share. Fits a share from 0 to 100.`,
    `- ${RESPONSIBILITY_VISUALIZATION_LABEL.yes_no} (a yes_no bar's own metric): a single state, true or not yet. Fits something that either holds or does not.`,
    `- ${RESPONSIBILITY_VISUALIZATION_LABEL.trend} (display line): a line over time with the target line. Fits a level read again and again, where the direction matters.`,
    `- ${RESPONSIBILITY_VISUALIZATION_LABEL.per_week} (display bar): one bar per week with the target line. Fits something counted per week.`,
    `- A range bar's own metric shows as ${RESPONSIBILITY_VISUALIZATION_LABEL.trend} or ${RESPONSIBILITY_VISUALIZATION_LABEL.number}, with its band; do not give it primaryDisplay bar.`,
    "- Propose at most three visualizations in all (the bar's own and up to two supporting). Prefer fewer when fewer tell the story: the bar's own alone is a good proposal.",
    "- On the proposal the person sees each visualization exactly as it will look, and may drop any supporting one before accepting (the bar's own always stays). Later they can switch any of them between the forms its data allows, or remove a supporting one. So pick the form that fits best and never ask them to choose a chart; if they dropped one, do not propose it again unless they ask.",
    "Each supporting metric: { title, description (one line on how it is measured), display, optional unit, optional target with direction (at_least or at_most), optional readings [{ value, recordedAt (ISO time) }] with readingsEvidence saying how you counted them }. Give starting readings only from real evidence (records you can see), never estimates. Sending metrics (even []) replaces the supporting metrics when the person accepts; leave metrics out to keep the ones it has.",
    "After the person accepts, the agents working under the responsibility record new readings with POST /api/responsibilities/{responsibilityId}/metrics/{metricId}/readings and { value } (metricId is primary for the bar's own metric).",
    "",
    "The call:",
    `POST /api/issues/${input.issueId}/bar-proposals (native runner: call_api with operationId "POST /api/issues/{id}/bar-proposals" and this task's id) with { standard, metricKind, metricName, the template's fields, optional metricCurrent and currentEvidence, optional primaryDisplay, optional metrics (supporting metrics), optional message (one plain sentence to the person) }. Examples:`,
  );
  for (const kind of RESPONSIBILITY_METRIC_KINDS) {
    lines.push(`- ${JSON.stringify({ metricKind: kind, ...RESPONSIBILITY_BAR_TEMPLATES[kind].example })}`);
  }
  lines.push(`- With a metric set: ${JSON.stringify(METRIC_SET_EXAMPLE)}`);
  lines.push(
    "201 shows the card in this conversation. 400 or 422 says what is wrong with the bar: fix it and send again. 409 means this conversation was cancelled or the responsibility was closed, and 404 that the feature is off: say so and stop. Use plain words with the person: responsibility, bar, task; never issue, interaction or field names.",
  );
  return lines.join("\n");
}
