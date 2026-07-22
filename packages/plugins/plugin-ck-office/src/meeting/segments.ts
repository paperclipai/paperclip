// Segments 1–5 of the Weekly Tactical — the deterministic pre-read (meeting-flow.md §T-minus…5).
// "The room is a document before anyone speaks." No LLM here: every line is computed.
//
//   1 Segue / good news        — one computed line of wins.
//   2 Scorecard review         — paired indicators + the SPC filter (the Deming gate). A red number is
//                                only promoted to an Issue if SPC says special-cause; common-cause noise
//                                is DROPPED (and recorded, so the drop is auditable).
//   3 Rock / OKR review        — on/off-track (OKR scored 0–1, mean of KRs; <0.7 off-track). Off-track -> Issue.
//   4 Headlines                — one-line FYIs; action-needing -> Issue, the rest is context.
//   5 To-Do review             — done / not-done; stuck items -> Issue.
//
// Output: a `meeting_packet` (jsonb stored on meeting_run) + a set of meeting_issue rows for the
// promoted items, each carrying an impact_score (Goldratt: ΔThroughput toward the named constraint) and
// a believability weight (Dalio, §3c) so IDS can constraint-rank and believability-weight them.
//
// Segment 2 reads the REAL ck_eval.scorecard history; the other segments take typed pre-read inputs
// (seeded for a throwaway run; in production they bind to GOV-21 OKR-Tracker, the board, and the
// to-do list). Pure transforms over data + inputs — independently testable.

import type { Sql } from "postgres";
import { spcClassify, type Direction, type SpcResult } from "./spc.js";

// ── Pre-read inputs ────────────────────────────────────────────────────────────
export interface MetricInput {
  /** Display name (e.g. "outreach replies"). */
  name: string;
  /** ck_eval.agent_spec.id whose scorecard history holds this metric (segment 2 reads it). */
  specId: string;
  /** The metrics-jsonb key inside ck_eval.scorecard.metrics to extract the series from. */
  metricKey: string;
  /** The target line GOV-05 compares against to decide "red". */
  target: number;
  /** Which way is better. Determines the SPC bad-side and what counts as "red". */
  better: "higher_is_better" | "lower_is_better";
  /** The paired quality counter-metric name (Grove: no single-number gaming). Optional. */
  pairedWith?: string;
  /** Whether this metric bears on the named constraint (Goldratt) — boosts impact ranking. */
  onConstraint?: boolean;
  /** Believability of this source (0–1); defaults to the spec's recent cost-adjusted score, else 1. */
  believability?: number;
}

export interface OkrInput {
  id: string;
  name: string;
  /** Key-result scores in [0,1]; objective = mean. */
  krScores: number[];
  onConstraint?: boolean;
}
export interface RockInput {
  id: string;
  name: string;
  status: "on_track" | "off_track";
  onConstraint?: boolean;
}
export interface TodoInput {
  id: string;
  title: string;
  owner: string;
  dueAt: string | null;
  done: boolean;
  onConstraint?: boolean;
}
export interface HeadlineInput {
  text: string;
  actionNeeded: boolean;
  onConstraint?: boolean;
}

export interface PreReadSource {
  companyId: string;
  /** The single named constraint the meeting optimizes toward (ADR-021 / Goldratt). */
  constraint: string;
  wins: string[];
  metrics: MetricInput[];
  okrs: OkrInput[];
  rocks: RockInput[];
  todos: TodoInput[];
  headlines: HeadlineInput[];
}

// ── Issue candidate (becomes a meeting_issue row) ───────────────────────────────
export interface IssueCandidate {
  sourceKind: "scorecard_spc" | "okr_offtrack" | "todo_stuck" | "headline" | "other";
  sourceRef: string;
  title: string;
  impactScore: number;
  believability: number;
  evidence: Record<string, unknown>;
}

// ── Segment 1 (shared with the Daily Huddle) ────────────────────────────────────
// Compute the segue / good-news line(s). Never generated — pure. If no explicit wins are supplied,
// synthesize one from the assembled state ("start on a win", Mochary/Scaling Up).
export function segueLine(wins: string[], greenCount: number, rocksOn: number): string[] {
  if (wins.length > 0) return [...wins];
  return [`${greenCount} scorecard metric(s) green; ${rocksOn} rock(s)/unit(s) on track.`];
}

// ── Segment 2 helpers ───────────────────────────────────────────────────────────
function spcDirection(better: MetricInput["better"]): Direction {
  return better === "higher_is_better" ? "lower_is_bad" : "higher_is_bad";
}
function isRed(latest: number, target: number, better: MetricInput["better"]): boolean {
  return better === "higher_is_better" ? latest < target : latest > target;
}

// Pull a numeric series for `metricKey` from a spec's scorecard history (chronological).
async function loadSeries(sql: Sql, specId: string, metricKey: string): Promise<number[]> {
  const rows = (await sql`
    select metrics, computed_at
    from ck_eval.scorecard
    where spec_id = ${specId}
    order by computed_at asc
  `) as unknown as Array<{ metrics: Record<string, unknown> }>;
  const series: number[] = [];
  for (const r of rows) {
    const v = (r.metrics ?? {})[metricKey];
    if (typeof v === "number" && Number.isFinite(v)) series.push(v);
  }
  return series;
}

// Believability proxy: a spec's most recent cost-adjusted score (how much we trust its numbers).
async function specBelievability(sql: Sql, specId: string): Promise<number> {
  const rows = (await sql`
    select cost_adjusted_score from ck_eval.scorecard
    where spec_id = ${specId} and cost_adjusted_score is not null
    order by computed_at desc limit 1
  `) as unknown as Array<{ cost_adjusted_score: string | number | null }>;
  const v = rows[0]?.cost_adjusted_score;
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1) : 1;
}

export interface ScorecardLine {
  name: string;
  pairedWith: string | null;
  latest: number | null;
  target: number;
  better: string;
  red: boolean;
  spc: SpcResult | null;
  outcome: "green" | "dropped_noise" | "promoted_signal" | "insufficient";
}

// ── The assembled packet ────────────────────────────────────────────────────────
export interface MeetingPacket {
  kind: "weekly_tactical" | "daily_huddle";
  company_id: string;
  constraint: string;
  segue: { wins: string[] };
  scorecard: ScorecardLine[];
  okrs: Array<{ id: string; name: string; objective: number; onTrack: boolean }>;
  rocks: Array<{ id: string; name: string; status: string }>;
  headlines: HeadlineInput[];
  todos: { total: number; done: number; donePct: number; stuck: string[] };
  issues_promoted: IssueCandidate[];
  spc_dropped: Array<{ metric: string; reason: string }>;
  assembled_at: string;
}

// Assemble segments 1–5 into a packet + the promoted issue candidates. Deterministic; reads scorecards.
export async function assemblePreRead(
  sql: Sql,
  src: PreReadSource,
  opts: { kind?: "weekly_tactical" | "daily_huddle" } = {},
): Promise<{ packet: MeetingPacket; issues: IssueCandidate[] }> {
  const issues: IssueCandidate[] = [];
  const spcDropped: Array<{ metric: string; reason: string }> = [];

  // Segment 2 — scorecard + SPC gate.
  const scorecard: ScorecardLine[] = [];
  for (const m of src.metrics) {
    const series = await loadSeries(sql, m.specId, m.metricKey);
    const latest = series.length ? series[series.length - 1] : null;
    const red = latest != null && isRed(latest, m.target, m.better);
    const believability = m.believability ?? (await specBelievability(sql, m.specId));
    let spc: SpcResult | null = null;
    let outcome: ScorecardLine["outcome"] = "green";

    if (latest == null) {
      outcome = "insufficient";
    } else if (!red) {
      outcome = "green";
    } else {
      spc = spcClassify({ series, direction: spcDirection(m.better) });
      if (spc.classification === "signal") {
        outcome = "promoted_signal";
        // impact: deviation in σ units (or vs target if σ=0), scaled by constraint + believability.
        const sigmaUnits = spc.sigmaHat > 0 ? Math.abs(latest - spc.mean) / spc.sigmaHat : 6;
        const impact = sigmaUnits * (m.onConstraint ? 2 : 1) * believability;
        issues.push({
          sourceKind: "scorecard_spc",
          sourceRef: m.specId,
          title: `Scorecard red is a special-cause signal: ${m.name} = ${latest} (target ${m.target})`,
          impactScore: Number(impact.toFixed(3)),
          believability,
          evidence: {
            metric: m.name,
            latest,
            target: m.target,
            spc_rules: spc.rulesFired,
            mean: spc.mean,
            ucl: spc.ucl,
            lcl: spc.lcl,
            paired_with: m.pairedWith ?? null,
            on_constraint: !!m.onConstraint,
          },
        });
      } else if (spc.classification === "noise") {
        outcome = "dropped_noise";
        spcDropped.push({ metric: m.name, reason: spc.reason });
      } else {
        outcome = "insufficient";
        spcDropped.push({ metric: m.name, reason: spc.reason });
      }
    }
    scorecard.push({
      name: m.name,
      pairedWith: m.pairedWith ?? null,
      latest,
      target: m.target,
      better: m.better,
      red,
      spc,
      outcome,
    });
  }

  // Segment 3 — Rock / OKR review.
  const okrs = src.okrs.map((o) => {
    const objective = o.krScores.length ? o.krScores.reduce((s, x) => s + x, 0) / o.krScores.length : 0;
    const onTrack = objective >= 0.7;
    if (!onTrack) {
      issues.push({
        sourceKind: "okr_offtrack",
        sourceRef: `okr:${o.id}`,
        title: `OKR off-track: ${o.name} (objective ${objective.toFixed(2)} < 0.70)`,
        impactScore: Number(((0.7 - objective) * (o.onConstraint ? 2 : 1) * 5).toFixed(3)),
        believability: 1,
        evidence: { kr_scores: o.krScores, objective, on_constraint: !!o.onConstraint },
      });
    }
    return { id: o.id, name: o.name, objective: Number(objective.toFixed(3)), onTrack };
  });
  const rocks = src.rocks.map((r) => {
    if (r.status === "off_track") {
      issues.push({
        sourceKind: "okr_offtrack",
        sourceRef: `rock:${r.id}`,
        title: `Rock off-track: ${r.name}`,
        impactScore: Number((3 * (r.onConstraint ? 2 : 1)).toFixed(3)),
        believability: 1,
        evidence: { on_constraint: !!r.onConstraint },
      });
    }
    return { id: r.id, name: r.name, status: r.status };
  });

  // Segment 4 — Headlines.
  for (const h of src.headlines) {
    if (h.actionNeeded) {
      issues.push({
        sourceKind: "headline",
        sourceRef: "headline",
        title: `Headline needs action: ${h.text}`,
        impactScore: Number((2 * (h.onConstraint ? 2 : 1)).toFixed(3)),
        believability: 1,
        evidence: { text: h.text, on_constraint: !!h.onConstraint },
      });
    }
  }

  // Segment 5 — To-Do review.
  const done = src.todos.filter((t) => t.done).length;
  const total = src.todos.length;
  const stuck = src.todos.filter((t) => !t.done);
  for (const t of stuck) {
    issues.push({
      sourceKind: "todo_stuck",
      sourceRef: `todo:${t.id}`,
      title: `To-do not done: ${t.title} (owner ${t.owner})`,
      impactScore: Number((1.5 * (t.onConstraint ? 2 : 1)).toFixed(3)),
      believability: 1,
      evidence: { owner: t.owner, due_at: t.dueAt, on_constraint: !!t.onConstraint },
    });
  }

  // Segment 1 — Segue / good news (computed; never generated). Shared with the Daily Huddle.
  const greenCount = scorecard.filter((s) => s.outcome === "green").length;
  const rocksOn = rocks.filter((r) => r.status === "on_track").length;
  const computedWins = segueLine(src.wins, greenCount, rocksOn);

  const packet: MeetingPacket = {
    kind: opts.kind ?? "weekly_tactical",
    company_id: src.companyId,
    constraint: src.constraint,
    segue: { wins: computedWins },
    scorecard,
    okrs,
    rocks,
    headlines: src.headlines,
    todos: {
      total,
      done,
      donePct: total ? Number(((done / total) * 100).toFixed(1)) : 100,
      stuck: stuck.map((t) => t.title),
    },
    issues_promoted: issues,
    spc_dropped: spcDropped,
    assembled_at: new Date().toISOString(),
  };

  return { packet, issues };
}
