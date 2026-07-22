// The Weekly Tactical orchestrator — the ordered pipeline of segment jobs (meeting-flow.md build-notes).
// Assembles the deterministic pre-read (segments 1–5) -> writes meeting_run + meeting_issue rows ->
// runs IDS (the only LLM segment, budget-gated) -> grades the meeting -> concludes (self-rating +
// cascading FYIs + finalize). Each stage is a separately-testable function; this just sequences them.

import type { Sql } from "postgres";
import type { ModelCaller } from "./llm.js";
import { assemblePreRead, type PreReadSource, type MeetingPacket } from "./segments.js";
import { runIds, type IdsReport } from "./ids.js";
import { gradeMeeting, type GradeResult } from "./grader.js";
import { concludeMeeting, type ConcludeReport } from "./conclude.js";
import { assembleLivePreRead } from "./live-preread.js";
import { gov17LogAudit } from "../gov-kernel.js";

export const MEETING_SPEC_NAME = "Weekly Tactical (Level-10)";

// The meeting's own Agent Spec + golden set (no hire without a scorecard). The golden_case encodes the
// "good meeting" definition as assertions; the grader checks the run against them.
export async function ensureMeetingSpec(sql: Sql, agentId: string): Promise<string> {
  const existing = (await sql`select id from ck_eval.agent_spec where name = ${MEETING_SPEC_NAME} limit 1`) as unknown as Array<{ id: string }>;
  let specId: string;
  if (existing[0]) {
    specId = existing[0].id;
    await sql`update ck_eval.agent_spec set paperclip_agent_id = ${agentId} where id = ${specId}`;
  } else {
    const [row] = await sql`insert into ck_eval.agent_spec
      (paperclip_agent_id, name, charter, type, inputs_schema, outputs_schema, success_criteria,
       ground_truth_signal, evaluation_owner, metrics, cadence, consequence_policy, status)
      values (${agentId}, ${MEETING_SPEC_NAME},
        'Run the Weekly Tactical so that every promoted issue is SPC-validated and the top constraint-issue is solved to a decision + a to-do + a written golden case, within the per-meeting budget.',
        'hybrid',
        ${sql.json({ type: "object", properties: { packet: { type: "object" } } })},
        ${sql.json({ type: "object", properties: { decisions: { type: "array" }, rating: { type: "number" } } })},
        'produced decisions with owner+due, solved the top constraint-issue, wrote >=1 golden case, stayed in budget',
        'the four good-meeting criteria checked deterministically by the grader', 'GOV-12',
        ${sql.json({ rating: ">=8", good_meeting_rate: ">=0.9" })},
        ${sql.json({ continuous: false, periodic: "weekly" })},
        ${sql.json({ auto_tune: true, retire_requires_human: true })},
        'active') returning id`;
    specId = row.id as string;
  }
  // Golden set: the good-meeting criteria as a reviewed assertion (idempotent on source tag).
  const gc = (await sql`select id from ck_eval.golden_case where spec_id = ${specId} and source = 'meeting-spec:good-meeting-criteria' limit 1`) as unknown as Array<{ id: string }>;
  if (!gc[0]) {
    await sql`insert into ck_eval.golden_case (spec_id, kind, input, assertions, source, reviewed_by, reviewed_at, active)
      values (${specId}, 'assertion', ${sql.json({ a: "a completed Weekly Tactical run" })},
        ${sql.json({ decisions_with_owner_due: true, solved_top_constraint_issue: true, wrote_golden_case: true, stayed_in_budget: true })},
        'meeting-spec:good-meeting-criteria', 'GOV-06', now(), true)`;
  }
  return specId;
}

// Scheduled live pre-read: assemble segments 1–5 over the live company and
// write the meeting_run + Issues List. runLiveWeeklyTactical below continues
// the same run through budget-gated IDS, grading, and conclusion.
export interface LiveTacticalPreReadResult {
  meetingRunId: string;
  packet: MeetingPacket;
  promoted: number;
  dropped: number;
  redCount: number;
  unitsConsidered: number;
  wins: string[];
  promotedTitles: string[];
  droppedUnits: string[];
}

export async function runLiveTacticalPreRead(
  sql: Sql,
  opts: { companyId: string; agentId: string; budgetCapCents: number },
): Promise<LiveTacticalPreReadResult> {
  const live = await assembleLivePreRead(sql, opts.companyId);
  const packet = {
    kind: "weekly_tactical",
    company_id: opts.companyId,
    constraint: "qualified leads into the pipeline (the money constraint)",
    segue: { wins: live.wins },
    scorecard: [],
    okrs: [],
    rocks: [],
    headlines: [],
    todos: { total: 0, done: 0, donePct: 100, stuck: [] },
    spc_dropped: live.dropped.map((d) => ({ metric: d.unit, reason: d.reason })),
    issues_promoted: live.issues,
    units_considered: live.unitsConsidered,
    reds: live.redCount,
    assembled_at: new Date().toISOString(),
  } as MeetingPacket & { units_considered: number; reds: number };
  const [run] = await sql`insert into ck_eval.meeting_run (kind, company_id, packet, budget_cap_cents)
    values ('weekly_tactical', ${opts.companyId}, ${sql.json(packet as never)}, ${opts.budgetCapCents})
    returning id`;
  const meetingRunId = run.id as string;
  for (const c of live.issues) {
    await sql`insert into ck_eval.meeting_issue
      (meeting_run_id, source_kind, source_ref, title, evidence, impact_score, believability)
      values (${meetingRunId}, ${c.sourceKind}, ${c.sourceRef}, ${c.title},
        ${sql.json(c.evidence as never)}, ${c.impactScore}, ${c.believability})`;
  }
  await gov17LogAudit(sql, opts.companyId, opts.agentId, "meeting.preread_assembled", "meeting_run", meetingRunId, {
    kind: "weekly_tactical",
    live: true,
    promoted: live.issues.length,
    dropped_noise: packet.spc_dropped,
    units_considered: live.unitsConsidered,
    ids: "deferred_to_budgeted_runner",
  });
  return {
    meetingRunId,
    packet,
    promoted: live.issues.length,
    dropped: live.dropped.length,
    redCount: live.redCount,
    unitsConsidered: live.unitsConsidered,
    wins: live.wins,
    promotedTitles: live.issues.map((c) => c.title),
    droppedUnits: live.dropped.map((d) => d.unit),
  };
}

export interface LiveWeeklyTacticalResult extends LiveTacticalPreReadResult {
  ids: IdsReport;
  grade: GradeResult;
  conclude: ConcludeReport;
}

export async function runLiveWeeklyTactical(
  sql: Sql,
  opts: {
    companyId: string;
    agentId: string;
    meetingSpecId: string;
    budgetCapCents: number;
    caller: ModelCaller;
  },
): Promise<LiveWeeklyTacticalResult> {
  const preRead = await runLiveTacticalPreRead(sql, opts);
  const ids = await runIds({
    sql,
    caller: opts.caller,
    companyId: opts.companyId,
    agentId: opts.agentId,
    meetingRunId: preRead.meetingRunId,
    meetingSpecId: opts.meetingSpecId,
    constraint: preRead.packet.constraint,
    budgetCapCents: opts.budgetCapCents,
    topN: 3,
  });
  const grade = await gradeMeeting({
    sql,
    companyId: opts.companyId,
    agentId: opts.agentId,
    meetingRunId: preRead.meetingRunId,
    meetingSpecId: opts.meetingSpecId,
    packet: preRead.packet,
    ids,
    budgetCapCents: opts.budgetCapCents,
  });
  const conclude = await concludeMeeting({
    sql,
    companyId: opts.companyId,
    agentId: opts.agentId,
    meetingRunId: preRead.meetingRunId,
    packet: preRead.packet,
    ids,
    grade,
  });
  return { ...preRead, ids, grade, conclude };
}

export interface WeeklyTacticalDeps {
  sql: Sql;
  caller: ModelCaller;
  companyId: string;
  agentId: string;
  meetingSpecId: string;
  source: PreReadSource;
  budgetCapCents: number;
  topN?: number;
  primaryModel?: string;
  redTeamModel?: string;
}

export interface WeeklyTacticalReport {
  meetingRunId: string;
  packet: MeetingPacket;
  promotedCount: number;
  droppedNoise: Array<{ metric: string; reason: string }>;
  ids: IdsReport;
  grade: GradeResult;
  conclude: ConcludeReport;
}

export async function runWeeklyTactical(deps: WeeklyTacticalDeps): Promise<WeeklyTacticalReport> {
  const { sql } = deps;

  // Segments 1–5 — deterministic pre-read (no LLM).
  const { packet, issues } = await assemblePreRead(sql, deps.source, { kind: "weekly_tactical" });

  // The room is a document before anyone speaks: write the meeting_run with the assembled packet.
  const [run] = await sql`insert into ck_eval.meeting_run (kind, company_id, packet, budget_cap_cents)
    values ('weekly_tactical', ${deps.companyId}, ${sql.json(packet as never)}, ${deps.budgetCapCents})
    returning id`;
  const meetingRunId = run.id as string;

  // Persist the promoted issues (the Issues List).
  for (const c of issues) {
    await sql`insert into ck_eval.meeting_issue
      (meeting_run_id, source_kind, source_ref, title, evidence, impact_score, believability)
      values (${meetingRunId}, ${c.sourceKind}, ${c.sourceRef}, ${c.title},
        ${sql.json(c.evidence as never)}, ${c.impactScore}, ${c.believability})`;
  }

  await gov17LogAudit(sql, deps.companyId, deps.agentId, "meeting.preread_assembled", "meeting_run", meetingRunId, {
    kind: "weekly_tactical",
    promoted: issues.length,
    dropped_noise: packet.spc_dropped,
    scorecard_metrics: packet.scorecard.length,
  });

  // Segment 6 — IDS (the only LLM segment), budget-gated.
  const ids = await runIds({
    sql,
    caller: deps.caller,
    companyId: deps.companyId,
    agentId: deps.agentId,
    meetingRunId,
    meetingSpecId: deps.meetingSpecId,
    constraint: deps.source.constraint,
    budgetCapCents: deps.budgetCapCents,
    topN: deps.topN,
    primaryModel: deps.primaryModel,
    redTeamModel: deps.redTeamModel,
  });

  // Grade the meeting itself (scorecard + sample to GOV-12) and compute the 1–10 self-rating.
  const grade = await gradeMeeting({
    sql,
    companyId: deps.companyId,
    agentId: deps.agentId,
    meetingRunId,
    meetingSpecId: deps.meetingSpecId,
    packet,
    ids,
    budgetCapCents: deps.budgetCapCents,
  });

  // Segment 7 — Conclude (recap, cascading FYIs, finalize meeting_run).
  const conclude = await concludeMeeting({
    sql,
    companyId: deps.companyId,
    agentId: deps.agentId,
    meetingRunId,
    packet,
    ids,
    grade,
  });

  return {
    meetingRunId,
    packet,
    promotedCount: issues.length,
    droppedNoise: packet.spc_dropped,
    ids,
    grade,
    conclude,
  };
}
