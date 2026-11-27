import {
  RESPONSIBILITY_STATUS_REPORT_FRESH_DAYS,
  RESPONSIBILITY_STATUS_REPORT_LABEL,
  type ResponsibilityArea,
  type ResponsibilityHealth,
  type ResponsibilityMetricSummary,
  type ResponsibilityStatusReportsOverview,
  type ResponsibilityStatusReportSummary,
  type ResponsibilityWithRollup,
} from "@paperclipai/shared";
import { describeMetricReading, groupByArea, RESPONSIBILITY_HEALTH_LABEL } from "./responsibilities";

/**
 * Derivations for the Dashboard's "Agent status" view (experimental,
 * `enableResponsibilities`): each responsibility's status as its reporting
 * agent wrote it (falling back to the status the number gives, said plainly),
 * the four counts, a summary composed from the reports (no model), and the
 * areas with a line, a status and a share on track each. Pure, so the view
 * stays a plain renderer and every word is tested here.
 */

/** The four statuses the view counts. `unclear` holds "can't tell yet" and "not measured". */
export type AgentStatusKind = "behind" | "at_risk" | "on_track" | "unclear";
/** Who the status comes from: an agent's report, a person's correction, or the number alone. */
export type AgentStatusSource = "agent" | "person" | "number";

/** The tiles' order, as in the reference: what is fine first, then what is not. */
export const AGENT_STATUS_TILE_ORDER: readonly AgentStatusKind[] = ["on_track", "at_risk", "behind", "unclear"];

export const AGENT_STATUS_TILE_LABEL: Record<AgentStatusKind, string> = {
  on_track: "On track",
  at_risk: "At risk",
  behind: "Behind",
  unclear: "Unclear",
};

/** The status hue each kind borrows. */
export const AGENT_STATUS_HEALTH: Record<AgentStatusKind, ResponsibilityHealth> = {
  behind: "behind",
  at_risk: "at_risk",
  on_track: "on_track",
  unclear: "not_measured",
};

/** Most concerning first. "Unclear" sits above on track: it is not known to be fine. */
const SEVERITY: Record<AgentStatusKind, number> = { behind: 0, at_risk: 1, unclear: 2, on_track: 3 };

export interface AgentStatusRow {
  responsibility: ResponsibilityWithRollup;
  areaId: string | null;
  kind: AgentStatusKind;
  /** The chip's word: "At risk", "Can't tell yet", "Not measured". */
  label: string;
  source: AgentStatusSource;
  /** The written line, or the sentence from the number. */
  message: string;
  detail: string | null;
  /** A written report older than the freshness window. Always false for the number. */
  outOfDate: boolean;
  /** When the report was written; null for the number. */
  writtenAt: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  /** The agent whose view the status waits for, or who writes it. */
  reporterAgentId: string | null;
  updateRequested: boolean;
}

function healthKind(health: ResponsibilityHealth): AgentStatusKind {
  return health === "not_measured" ? "unclear" : health;
}

/** One responsibility's row: its report when there is one, otherwise its number. */
export function agentStatusRow(
  responsibility: ResponsibilityWithRollup,
  summary: ResponsibilityStatusReportSummary | undefined,
): AgentStatusRow {
  const base = {
    responsibility,
    areaId: responsibility.areaId,
    reporterAgentId: summary?.reporterAgentId ?? null,
    updateRequested: summary?.updateRequested ?? false,
  };
  const report = summary?.current ?? null;
  if (report) {
    return {
      ...base,
      kind: report.status === "unknown" ? "unclear" : report.status,
      label: RESPONSIBILITY_STATUS_REPORT_LABEL[report.status],
      source: report.userId ? "person" : "agent",
      message: report.message,
      detail: report.detail,
      outOfDate: report.outOfDate,
      writtenAt: report.writtenAt,
      authorAgentId: report.agentId,
      authorUserId: report.userId,
    };
  }
  const health = responsibility.rollup.health;
  return {
    ...base,
    kind: healthKind(health),
    label: RESPONSIBILITY_HEALTH_LABEL[health],
    source: "number",
    message: responsibility.rollup.statusSentence,
    detail: null,
    outOfDate: false,
    writtenAt: null,
    authorAgentId: null,
    authorUserId: null,
  };
}

/** Most concerning first; among equals, a fresh written report before an old one or the number. Stable otherwise. */
export function sortAgentStatusRows(rows: readonly AgentStatusRow[]): AgentStatusRow[] {
  const freshness = (row: AgentStatusRow) => (row.source === "number" ? 2 : row.outOfDate ? 1 : 0);
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => SEVERITY[a.row.kind] - SEVERITY[b.row.kind] || freshness(a.row) - freshness(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

/** Rows for the person's active responsibilities, in the overview's order. */
export function agentStatusRows(
  responsibilities: readonly ResponsibilityWithRollup[],
  reports: Pick<ResponsibilityStatusReportsOverview, "reports"> | null | undefined,
): AgentStatusRow[] {
  const byId = new Map((reports?.reports ?? []).map((entry) => [entry.responsibilityId, entry]));
  return responsibilities.filter((item) => item.status === "active").map((item) => agentStatusRow(item, byId.get(item.id)));
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function count(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Who wrote a row's status, in words: the agent's name, "you", "a person", or null for the number. */
export function agentStatusAuthor(
  row: Pick<AgentStatusRow, "source" | "authorAgentId" | "authorUserId">,
  agentName: (id: string) => string | undefined,
  viewerUserId: string | null,
): string | null {
  if (row.source === "number") return null;
  if (row.source === "person") return row.authorUserId && row.authorUserId === viewerUserId ? "You" : "A person";
  return (row.authorAgentId && agentName(row.authorAgentId)) || "An agent";
}

/** "today", "yesterday", "3 days ago", "on Oct 2". */
export function writtenAgo(writtenAt: string, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(writtenAt).getTime()) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `on ${new Date(writtenAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

// ---------------------------------------------------------------------------
// The four numbers
// ---------------------------------------------------------------------------

export interface AgentStatusTile {
  kind: AgentStatusKind;
  label: string;
  value: number;
  /** The line beneath, reading sensibly at zero. */
  line: string;
}

export interface AgentStatusTiles {
  tiles: AgentStatusTile[];
  total: number;
  byAgent: number;
  byPerson: number;
  outOfDate: number;
  fromNumber: number;
  /** "9 written by agents · 2 out of date · 1 corrected by a person · 35 from the numbers". */
  provenance: string;
}

/** The view's four counts by the status each responsibility shows, and where those statuses come from. */
export function agentStatusTiles(rows: readonly AgentStatusRow[]): AgentStatusTiles {
  const total = rows.length;
  const of = (kind: AgentStatusKind) => rows.filter((row) => row.kind === kind);
  const areasOf = (list: readonly AgentStatusRow[]) => new Set(list.map((row) => row.areaId ?? "__none__")).size;
  const tiles = AGENT_STATUS_TILE_ORDER.map((kind): AgentStatusTile => {
    const list = of(kind);
    let line: string;
    if (kind === "on_track") line = `Of ${count(total, "responsibility", "responsibilities")}`;
    else if (kind === "unclear") {
      const cantTell = list.filter((row) => row.source !== "number").length;
      const notMeasured = list.length - cantTell;
      line = list.length === 0
        ? "Every one has a status"
        : [cantTell > 0 ? `${cantTell} can't tell yet` : null, notMeasured > 0 ? `${notMeasured} not measured` : null].filter(Boolean).join(" · ");
    } else line = list.length === 0 ? "None right now" : `In ${count(areasOf(list), "area", "areas")}`;
    return { kind, label: AGENT_STATUS_TILE_LABEL[kind], value: list.length, line };
  });
  const byAgent = rows.filter((row) => row.source === "agent").length;
  const byPerson = rows.filter((row) => row.source === "person").length;
  const outOfDate = rows.filter((row) => row.outOfDate).length;
  const fromNumber = rows.filter((row) => row.source === "number").length;
  const provenance = [
    `${byAgent} written by ${byAgent === 1 ? "an agent" : "agents"}`,
    outOfDate > 0 ? `${outOfDate} out of date` : null,
    byPerson > 0 ? `${byPerson} written by a person` : null,
    `${fromNumber} from the ${fromNumber === 1 ? "number" : "numbers"}`,
  ].filter(Boolean).join(" · ");
  return { tiles, total, byAgent, byPerson, outOfDate, fromNumber, provenance };
}

// ---------------------------------------------------------------------------
// The summary, composed from the reports
// ---------------------------------------------------------------------------

export interface AgentStatusSummaryLine {
  row: AgentStatusRow;
  /** Who wrote it. */
  by: string;
}

export interface AgentStatusSummary {
  /** One or two plain sentences. */
  lead: string;
  /** The most concerning written messages, attributed. At most `limit`. */
  lines: AgentStatusSummaryLine[];
  /** Whose update was asked for: "CTO and UXDesigner, for 3 updates", or null. */
  waiting: string | null;
}

/**
 * A short summary from what agents (and people) wrote: how many statuses are
 * written, what they say is wrong, then the most concerning messages first
 * with who wrote them, and whose update is awaited. No model.
 */
export function composeAgentStatusSummary(
  rows: readonly AgentStatusRow[],
  agentName: (id: string) => string | undefined,
  viewerUserId: string | null,
  limit = 3,
): AgentStatusSummary {
  const written = rows.filter((row) => row.source !== "number");
  const total = rows.length;
  let lead: string;
  if (total === 0) lead = "You do not own any responsibilities yet.";
  else if (written.length === 0) lead = "No agent has written a status yet. Every status below comes from the numbers.";
  else {
    const behind = written.filter((row) => row.kind === "behind").length;
    const atRisk = written.filter((row) => row.kind === "at_risk").length;
    const stale = written.filter((row) => row.outOfDate).length;
    const intro = written.length === total
      ? total === 1 ? "Your one status is written." : `All ${total} of your statuses are written.`
      : `${written.length} of your ${total} statuses are written; the rest come from the numbers.`;
    const verdict = behind + atRisk === 0
      ? "None of the written ones is behind or at risk."
      : `They put ${[behind > 0 ? `${behind} behind` : null, atRisk > 0 ? `${atRisk} at risk` : null].filter(Boolean).join(" and ")}.`;
    const freshness = stale > 0 ? ` ${stale} ${stale === 1 ? "is" : "are"} older than ${RESPONSIBILITY_STATUS_REPORT_FRESH_DAYS} days.` : "";
    lead = `${intro} ${verdict}${freshness}`;
  }
  const concerning = sortAgentStatusRows(written.filter((row) => row.kind !== "on_track")).slice(0, limit);
  const lines = concerning.map((row) => ({ row, by: agentStatusAuthor(row, agentName, viewerUserId) ?? "" }));
  const waitingRows = rows.filter((row) => row.updateRequested);
  let waiting: string | null = null;
  if (waitingRows.length > 0) {
    const names = [...new Set(waitingRows.map((row) => (row.reporterAgentId && agentName(row.reporterAgentId)) || "an agent"))];
    waiting = `${joinNames(names)}, for ${count(waitingRows.length, "update", "updates")}`;
  }
  return { lead, lines, waiting };
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export interface AgentStatusAreaGroup {
  area: Pick<ResponsibilityArea, "id" | "title" | "status"> | null;
  /** Most concerning first. */
  rows: AgentStatusRow[];
  /** The area's status: its worst responsibility. "Unclear" only when nothing in it has a clearer status. Null when empty. */
  kind: AgentStatusKind | null;
  /** The one line under the area's name: its most concerning responsibility's message. */
  headline: { text: string; by: string | null; fromNumber: boolean } | null;
  onTrack: number;
  /** "1 of 3 responsibilities on track". */
  onTrackLabel: string;
  /** 0 to 100. */
  onTrackPercent: number;
  /** The agents reporting in it (reporters and authors), in row order. */
  agentIds: string[];
}

export function areaStatusKind(rows: readonly Pick<AgentStatusRow, "kind">[]): AgentStatusKind | null {
  if (rows.length === 0) return null;
  for (const kind of ["behind", "at_risk", "on_track"] as const) if (rows.some((row) => row.kind === kind)) return kind;
  return "unclear";
}

/** The areas holding the person's responsibilities (plus any just added), each with its line, status and share on track. */
export function agentStatusAreaGroups(
  areas: readonly Pick<ResponsibilityArea, "id" | "title" | "status">[],
  rows: readonly AgentStatusRow[],
  agentName: (id: string) => string | undefined,
  viewerUserId: string | null,
  keepEmpty: ReadonlySet<string> = new Set(),
): AgentStatusAreaGroup[] {
  return groupByArea(areas, rows, keepEmpty).map(({ area, items }) => {
    const sorted = sortAgentStatusRows(items);
    const top = sorted[0];
    const onTrack = sorted.filter((row) => row.kind === "on_track").length;
    const agentIds = [...new Set(sorted.flatMap((row) => [row.authorAgentId, row.reporterAgentId]).filter((id): id is string => !!id))];
    return {
      area,
      rows: sorted,
      kind: areaStatusKind(sorted),
      headline: top
        ? { text: top.message, by: agentStatusAuthor(top, agentName, viewerUserId), fromNumber: top.source === "number" }
        : null,
      onTrack,
      onTrackLabel: `${onTrack} of ${count(sorted.length, "responsibility", "responsibilities")} on track`,
      onTrackPercent: sorted.length === 0 ? 0 : Math.round((onTrack / sorted.length) * 100),
      agentIds,
    };
  });
}

// ---------------------------------------------------------------------------
// The metric column
// ---------------------------------------------------------------------------

export interface AgentStatusMetricCell {
  /** The metric's name, small. */
  label: string;
  /** The reading: "2.4 s", "Yes", or "No reading yet". */
  value: string;
  /** "target at most 2 s", "range 12–24 months", "should be yes", "no target set". */
  target: string;
}

/** The metric column for any bar template, through the shared reading helper. Null without a metric. */
export function agentStatusMetricCell(metric: ResponsibilityMetricSummary | null): AgentStatusMetricCell | null {
  if (!metric) return null;
  const reading = describeMetricReading(metric);
  if (reading.visual.kind === "yes_no") {
    return { label: metric.name, value: reading.current ?? "No answer yet", target: "should be yes" };
  }
  if (reading.visual.kind === "range" || metric.kind === "range") {
    return { label: metric.name, value: reading.current ?? "No reading yet", target: reading.target ? `range ${reading.target}` : "no range set" };
  }
  return {
    label: metric.name,
    value: reading.current ?? "No reading yet",
    target: reading.target ? `${metric.direction === "at_most" ? "target at most" : "target"} ${reading.target}` : "no target set",
  };
}
