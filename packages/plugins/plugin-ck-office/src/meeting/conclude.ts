// Segment 7 — Conclude (meeting-flow.md §7). Deterministic.
//   * Recap every new to-do (owner + due date).
//   * Cascading FYIs: typed messages pushed to the units that need to know (activity_log, GOV-17).
//   * Finalize meeting_run: write the self-rating + spend + meta_eval_ref (the GOV-12 sample). This is
//     the one allowed finalize-write the append-only guard permits.
//   * The decisions were already appended to the immutable activity_log by IDS (meeting.ids_solved);
//     here we append the meeting.concluded summary so the whole Termin is one auditable record.

import type { Sql } from "postgres";
import type { MeetingPacket } from "./segments.js";
import type { IdsReport } from "./ids.js";
import type { GradeResult } from "./grader.js";
import { gov17LogAudit } from "../gov-kernel.js";

export interface ConcludeDeps {
  sql: Sql;
  companyId: string;
  agentId: string;
  meetingRunId: string;
  packet: MeetingPacket;
  ids: IdsReport;
  grade: GradeResult;
}

export interface ConcludeReport {
  recap: string[];
  fyiCount: number;
  rating: number;
}

export async function concludeMeeting(deps: ConcludeDeps): Promise<ConcludeReport> {
  const { sql, ids, grade } = deps;

  // Recap — read back every new to-do (owner + due).
  const recap = ids.solved.map(
    (s) => `TODO: ${s.decision} — owner ${s.ownerUnit}, due ${s.dueAt.slice(0, 10)}`,
  );

  // Cascading FYIs — one typed message per owner_unit that picked up a to-do (Traction). Typed message
  // = an activity_log fyi entry referencing the unit; no free chat (02b §0).
  const owners = Array.from(new Set(ids.solved.map((s) => s.ownerUnit)));
  let fyiCount = 0;
  for (const owner of owners) {
    const todos = ids.solved.filter((s) => s.ownerUnit === owner);
    await gov17LogAudit(sql, deps.companyId, deps.agentId, "meeting.fyi", "owner_unit", owner, {
      intent: "fyi",
      to: owner,
      todos: todos.map((t) => ({ decision: t.decision, due_at: t.dueAt, golden_case_id: t.goldenCaseId })),
    });
    fyiCount++;
  }

  // Finalize the meeting_run (the allowed append-only finalize: rating/spend/finished_at/meta_eval_ref).
  await sql`update ck_eval.meeting_run
    set rating = ${grade.rating}, spend_cents = ${Math.round(ids.observedCents)},
        finished_at = now(), meta_eval_ref = ${grade.sampleEvalRunId}
    where id = ${deps.meetingRunId}`;

  // Append the concluded summary to the immutable activity_log.
  await gov17LogAudit(sql, deps.companyId, deps.agentId, "meeting.concluded", "meeting_run", deps.meetingRunId, {
    rating: grade.rating,
    good_meeting: grade.goodMeeting,
    verdict: grade.verdict,
    decisions: ids.solved.length,
    deferred: ids.deferred,
    golden_cases: ids.goldenCasesWritten,
    spend_cents: Math.round(ids.observedCents),
    budget_tripped: ids.tripped,
    handed_to_gov12: grade.sampleEvalRunId,
  });

  return { recap, fyiCount, rating: grade.rating };
}
