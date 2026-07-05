/**
 * Work Timeline layout — pure transform from the Phase B endpoint contract
 * (`WorkTimelineResult`) into a renderable view model for the custom-SVG Gantt.
 *
 * Ports the board-locked "Direction C" logic (PAP-12422): agent/system rows only
 * (humans never get a row), overlapping runs packed into concurrency sub-lanes,
 * a kickoff actor derived per run (shown as an avatar chip — may be a human),
 * and straight agent→agent delegation connectors from a source bar's trailing
 * edge to a target bar's leading edge (dashed for retries / changes-requested).
 *
 * Everything here is deterministic given (result, options) so it can be unit
 * tested without a DOM.
 */
import type {
  WorkTimelineActor,
  WorkTimelineEdge,
  WorkTimelineEvent,
  WorkTimelineResult,
  WorkTimelineSpan,
} from "@paperclipai/shared";

export interface LayoutOptions {
  /** px per minute along the x axis (set by the zoom level). */
  pxPerMinute: number;
  /** width of the left actor gutter in px. */
  gutter: number;
  /** row height in px. */
  rowH: number;
  /** bar height in px. */
  barH: number;
  /** vertical gap between concurrency sub-lanes in px. */
  laneGap: number;
  /** wall-clock "now" in ms, used to close in-progress runs. */
  nowMs: number;
}

export interface PositionedBar {
  span: WorkTimelineSpan;
  /** leading (start) x in px. */
  x1: number;
  /** trailing (end) x in px. */
  x2: number;
  /** vertical center of the bar in px. */
  yc: number;
  /** top of the bar in px. */
  yTop: number;
  height: number;
  running: boolean;
  /** the actor who kicked this run off, if resolvable (may be a human/user). */
  kickoff: WorkTimelineActor | null;
}

/**
 * Instant human/actor actions are deliberately not plotted in the main chart.
 * The shape remains in the layout model so call sites do not need special cases,
 * but rows now stay focused on actors with actual run participation.
 */
export interface PositionedMarker {
  event: WorkTimelineEvent;
  /** x position (px) of the marker centre = x(event.at). */
  x: number;
  /** vertical centre of the marker in px (row-relative, excludes axis offset). */
  yc: number;
}

export interface ActorRow {
  actor: WorkTimelineActor;
  /** top of the row (excluding axis offset) in px. */
  y: number;
  /** row height in px. */
  h: number;
  laneCount: number;
  bars: PositionedBar[];
  /** reserved for instant event markers; currently empty by design. */
  markers: PositionedMarker[];
  /** number of runs plotted on this row (the "Signal" rail count). */
  runCount: number;
  /** total active run time on this row in ms (the "Signal" rail active-time). */
  activeMs: number;
}

export interface Connector {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  sourceRunId: string;
  targetRunId: string;
  /** dashed = a return / retry (changes-requested) hop. */
  dashed: boolean;
}

export interface TimelineLayout {
  rows: ActorRow[];
  connectors: Connector[];
  /** full inner width of the chart (gutter + plotted time + pad). */
  width: number;
  /** full height of the chart including the axis strip. */
  height: number;
  /** domain start (ms). */
  fromMs: number;
  /** domain end (ms). */
  toMs: number;
  gutter: number;
  pxPerMinute: number;
  /** ordered list of distinct issue keys present for the task hue map. */
  issues: { key: string; label: string; color: string }[];
}

export const AXIS_H = 32;
const RUNNING_STATUSES = new Set(["running", "in_progress", "queued", "pending"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "aborted", "skipped"]);

export function isRunningStatus(status: string): boolean {
  return RUNNING_STATUSES.has(status);
}

export function isCancelledStatus(status: string): boolean {
  return CANCELLED_STATUSES.has(status);
}

/**
 * "Signal" encoding (PAP-12694, board-picked): colour spends on ONE meaning —
 * how the run started — instead of a per-issue hash rainbow. Delegated runs
 * (kicked off by another actor) read blue; automation/self-started runs read
 * amber. The blue/amber pair is colour-blind-safe and holds contrast on both
 * light and dark backgrounds so the chart screenshots cleanly. Cancelled runs
 * drop their fill entirely (rendered as a hollow dashed bar) and a teal "now"
 * line marks the present.
 */
export const TIMELINE_COLORS = {
  delegated: "#5b9bf6",
  automation: "#f4b740",
  /** stroke/ink for a hollow, cancelled bar. */
  cancelled: "#9aa3ad",
  now: "#2dd4bf",
} as const;

export type RunSourceKind = "delegated" | "automation";

/** How a run was started: delegated (has a kickoff actor) vs. automation/self. */
export function barSourceKind(bar: PositionedBar): RunSourceKind {
  return bar.kickoff ? "delegated" : "automation";
}

/** Source colour for a bar under the "Signal" encoding. */
export function barColor(bar: PositionedBar): string {
  return TIMELINE_COLORS[barSourceKind(bar)];
}

export function actorType(actor: WorkTimelineActor | undefined): string {
  return actor?.type ?? "system";
}

/** Deterministic, stable hue per issue that reads on both light and dark. */
export function issueColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) & 0xffffffff;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% 52%)`;
}

/** 2-char initials for an SVG avatar chip. */
export function shortLabel(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (name.slice(0, 2) || "?").toUpperCase();
}

function spanStartMs(s: WorkTimelineSpan): number {
  return new Date(s.start).getTime();
}

function spanEndMs(s: WorkTimelineSpan, nowMs: number): number {
  const raw = s.end ? new Date(s.end).getTime() : nowMs;
  return raw;
}

/**
 * Resolve the kickoff actor for a run: the source of the delegation/assignment
 * edge that points at this run's actor on this run's issue, closest at-or-before
 * the run start (falling back to the nearest such edge). Mirrors the design's
 * "avatar chip at the leading edge = who kicked it off".
 */
function resolveKickoff(
  span: WorkTimelineSpan,
  edges: WorkTimelineEdge[],
  actorById: Map<string, WorkTimelineActor>,
): WorkTimelineActor | null {
  const start = spanStartMs(span);
  let best: { edge: WorkTimelineEdge; delta: number } | null = null;
  for (const e of edges) {
    if (e.toActorId !== span.actorId || e.issueId !== span.issueId) continue;
    if (e.fromActorId === span.actorId) continue; // self-kickoff is not a delegation
    const at = new Date(e.at).getTime();
    // Prefer edges at-or-before the run start; otherwise smallest absolute gap.
    const delta = at <= start ? start - at : (at - start) + 1e12;
    if (!best || delta < best.delta) best = { edge: e, delta };
  }
  if (!best) return null;
  return actorById.get(best.edge.fromActorId) ?? null;
}

export function computeLayout(result: WorkTimelineResult, opts: LayoutOptions): TimelineLayout {
  const { pxPerMinute, gutter, rowH, barH, laneGap, nowMs } = opts;
  const fromMs = new Date(result.window.from).getTime();
  const toMs = new Date(result.window.to).getTime();
  const actorById = new Map(result.actors.map((a) => [a.id, a]));

  const x = (ms: number) => gutter + ((ms - fromMs) / 60000) * pxPerMinute;

  // Rows: any actor with in-window runs gets a row. Event-only comments/creates
  // do not create marker-only rows because they make the chart noisy.
  const firstActivity = new Map<string, number>();
  const noteActivity = (actorId: string, t: number) => {
    const cur = firstActivity.get(actorId);
    if (cur === undefined || t < cur) firstActivity.set(actorId, t);
  };
  for (const s of result.spans) noteActivity(s.actorId, spanStartMs(s));

  const rowActors = result.actors
    .filter((a) => firstActivity.has(a.id)) // drop actors with no run in-window
    .sort((a, b) => (firstActivity.get(a.id)! - firstActivity.get(b.id)!));

  // Issue hue map (ordered by first appearance) for the task color map.
  const issueOrder: string[] = [];
  const issueLabel = new Map<string, string>();
  for (const s of result.spans) {
    const key = s.issueId;
    if (!issueLabel.has(key)) {
      issueOrder.push(key);
      issueLabel.set(key, s.issueIdentifier ?? s.issueTitle ?? "issue");
    }
  }
  const issues = issueOrder.map((key) => ({ key, label: issueLabel.get(key)!, color: issueColor(key) }));

  const barIndex = new Map<string, PositionedBar>(); // runId -> bar
  const rows: ActorRow[] = [];
  let y = 0;
  for (const actor of rowActors) {
    const runs = result.spans
      .filter((s) => s.actorId === actor.id)
      .sort((p, q) => spanStartMs(p) - spanStartMs(q));

    // Greedy pack overlapping runs into sub-lanes.
    const laneEnds: number[] = [];
    const laneOf = new Map<string, number>();
    for (const r of runs) {
      const rs = spanStartMs(r);
      const re = spanEndMs(r, nowMs);
      let placed = -1;
      for (let ln = 0; ln < laneEnds.length; ln++) {
        if (laneEnds[ln] <= rs) {
          placed = ln;
          break;
        }
      }
      if (placed === -1) {
        placed = laneEnds.length;
        laneEnds.push(re);
      } else {
        laneEnds[placed] = re;
      }
      laneOf.set(r.runId, placed);
    }
    const laneCount = Math.max(1, laneEnds.length);
    const h = Math.max(rowH, laneCount * (barH + laneGap) + 8);

    const bars: PositionedBar[] = runs.map((r) => {
      const lane = laneOf.get(r.runId) ?? 0;
      const laneTop = y + 6 + lane * (barH + laneGap);
      const x1 = x(spanStartMs(r));
      const x2raw = x(spanEndMs(r, nowMs));
      const x2 = Math.max(x1 + 3, x2raw); // clamp sub-minute runs to a visible min width
      const bar: PositionedBar = {
        span: r,
        x1,
        x2,
        yTop: laneTop,
        yc: laneTop + barH / 2,
        height: barH,
        running: isRunningStatus(r.status),
        kickoff: resolveKickoff(r, result.edges, actorById),
      };
      barIndex.set(r.runId, bar);
      return bar;
    });

    const markers: PositionedMarker[] = [];

    const activeMs = runs.reduce((sum, r) => sum + Math.max(0, spanEndMs(r, nowMs) - spanStartMs(r)), 0);

    rows.push({ actor, y, h, laneCount, bars, markers, runCount: runs.length, activeMs });
    y += h;
  }

  // Connectors: straight agent→agent lines, connected at both ends. For each bar
  // with an agent/system kickoff, connect from the kickoff actor's nearest
  // preceding bar (same issue preferred) to this bar's leading edge.
  const connectors: Connector[] = [];
  for (const row of rows) {
    for (const bar of row.bars) {
      const k = bar.kickoff;
      if (!k || k.type === "user") continue; // agent→agent only; humans stay as chips
      const source = nearestSourceBar(k.id, bar, barIndex, nowMs);
      if (!source) continue;
      connectors.push({
        x1: source.x2,
        y1: source.yc,
        x2: bar.x1,
        y2: bar.yc,
        sourceRunId: source.span.runId,
        targetRunId: bar.span.runId,
        dashed: Boolean(bar.span.retryOfRunId),
      });
    }
  }

  const width = gutter + ((toMs - fromMs) / 60000) * pxPerMinute + 40;
  const height = y + AXIS_H;
  return { rows, connectors, width, height, fromMs, toMs, gutter, pxPerMinute, issues };
}

/** The kickoff actor's bar that best precedes `target` (same issue preferred). */
function nearestSourceBar(
  kickoffActorId: string,
  target: PositionedBar,
  barIndex: Map<string, PositionedBar>,
  nowMs: number,
): PositionedBar | null {
  const targetStart = spanStartMs(target.span);
  let sameIssue: PositionedBar | null = null;
  let anyIssue: PositionedBar | null = null;
  for (const bar of barIndex.values()) {
    if (bar.span.actorId !== kickoffActorId) continue;
    if (bar === target) continue;
    const end = spanEndMs(bar.span, nowMs);
    if (end > targetStart + 1) continue; // must precede (small tolerance)
    if (bar.span.issueId === target.span.issueId) {
      if (!sameIssue || spanEndMs(sameIssue.span, nowMs) < end) sameIssue = bar;
    }
    if (!anyIssue || spanEndMs(anyIssue.span, nowMs) < end) anyIssue = bar;
  }
  return sameIssue ?? anyIssue;
}

/** Choose a "nice" gridline step (ms) targeting ~120px between labels. */
export function chooseTickStepMs(pxPerMinute: number): number {
  const targetPx = 120;
  const minutesPerTarget = targetPx / pxPerMinute;
  const steps = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080]; // minutes
  for (const m of steps) {
    if (m >= minutesPerTarget) return m * 60000;
  }
  return steps[steps.length - 1] * 60000;
}

export function formatDuration(startMs: number, endMs: number): string {
  const mins = Math.max(0, Math.round((endMs - startMs) / 60000));
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}
