// Grade the meeting itself — no exception to "no hire without a scorecard" (meeting-flow.md build-notes §6).
// A "good meeting" = produced decisions with owner+due, solved the top constraint-issue, wrote ≥1 golden
// case, and stayed in budget. The Weekly Tactical has its own Agent Spec + golden set (the four criteria
// below ARE the golden assertions); this writes its eval_run + scorecard + routes the consequence, exactly
// like any unit. It also produces the Traction 1–10 self-rating and the sample handed to GOV-12.

import type { Sql } from "postgres";
import type { MeetingPacket } from "./segments.js";
import type { IdsReport } from "./ids.js";
import { gov13RouteConsequence, gov17LogAudit } from "../gov-kernel.js";

export interface GradeDeps {
  sql: Sql;
  companyId: string;
  agentId: string;
  meetingRunId: string;
  meetingSpecId: string;
  packet: MeetingPacket;
  ids: IdsReport;
  budgetCapCents: number;
}

export interface MeetingCriteria {
  decisions_with_owner_due: boolean;
  solved_top_constraint_issue: boolean;
  wrote_golden_case: boolean;
  stayed_in_budget: boolean;
}

export interface GradeResult {
  rating: number; // Traction 1–10
  goodMeeting: boolean;
  verdict: "keep" | "tune" | "quarantine";
  criteria: MeetingCriteria;
  scorecardId: string;
  sampleEvalRunId: string; // handed to GOV-12 Meta-Evaluator (meeting_run.meta_eval_ref)
  consequence: { trigger: string; action: string } | null;
}

export function deriveMeetingCriteria(
  promoted: MeetingPacket["issues_promoted"],
  ids: Pick<IdsReport, "solved" | "goldenCasesWritten" | "observedCents">,
  budgetCapCents: number,
): MeetingCriteria {
  const topRanked =
    promoted.length === 0
      ? null
      : [...promoted].sort(
          (a, b) => b.impactScore * b.believability - a.impactScore * a.believability,
        )[0];
  const solvedTitles = new Set(ids.solved.map((s) => s.title));
  return {
    decisions_with_owner_due:
      promoted.length === 0 ||
      (ids.solved.length > 0 && ids.solved.every((s) => !!s.ownerUnit && !!s.dueAt)),
    solved_top_constraint_issue: topRanked === null ? true : solvedTitles.has(topRanked.title),
    wrote_golden_case: ids.goldenCasesWritten >= 1 || promoted.length === 0,
    stayed_in_budget: Math.round(ids.observedCents) <= budgetCapCents,
  };
}

export async function gradeMeeting(deps: GradeDeps): Promise<GradeResult> {
  const { sql, packet, ids } = deps;

  // The top constraint-issue = the highest impact×believability among ALL promoted issues. The meeting
  // is good only if THAT one got solved (Goldratt: relieve the bottleneck, not the loudest).
  const promoted = packet.issues_promoted;
  const criteria = deriveMeetingCriteria(promoted, ids, deps.budgetCapCents);

  // Weighted points -> rating /10.
  const pts =
    (criteria.decisions_with_owner_due ? 3 : 0) +
    (criteria.solved_top_constraint_issue ? 3 : 0) +
    (criteria.wrote_golden_case ? 2 : 0) +
    (criteria.stayed_in_budget ? 2 : 0);
  const rating = Math.max(1, pts); // 1–10 scale, min 1
  const goodMeeting = Object.values(criteria).every(Boolean);
  const verdict: GradeResult["verdict"] = rating >= 8 ? "keep" : rating >= 5 ? "tune" : "quarantine";

  // eval_run on the meeting spec — the sample GOV-12 re-judges (mode='regression' vs the golden criteria).
  const [er] = await sql`insert into ck_eval.eval_run
    (spec_id, mode, passed, score, evidence, judge, cost_cents)
    values (${deps.meetingSpecId}, 'regression', ${goodMeeting}, ${rating / 10},
      ${sql.json({ criteria, rating, solved: ids.solved.length, deferred: ids.deferred, golden_cases: ids.goldenCasesWritten, observed_cents: ids.observedCents, budget_cap_cents: deps.budgetCapCents } as never)},
      'deterministic', 0)
    returning id`;

  // Scorecard (cost-adjusted: quality per token spent — CK's own thesis).
  const quality = rating / 10;
  const workCents = Math.round(ids.observedCents);
  const costAdjusted = quality / Math.max(workCents, 1);
  const [sc] = await sql`insert into ck_eval.scorecard
    (spec_id, period_start, period_end, metrics, work_cost_cents, eval_cost_cents, cost_adjusted_score, verdict)
    values (${deps.meetingSpecId}, ${packet.assembled_at}, now(),
      ${sql.json({ ...criteria, rating, good_meeting: goodMeeting, solved: ids.solved.length, deferred: ids.deferred, golden_cases: ids.goldenCasesWritten } as never)},
      ${workCents}, 0, ${costAdjusted}, ${verdict})
    returning id`;

  const consequence = await gov13RouteConsequence(sql, deps.meetingSpecId, verdict, true);

  await gov17LogAudit(sql, deps.companyId, deps.agentId, "meeting.graded", "scorecard", sc.id as string, {
    unit: "Weekly Tactical",
    rating,
    good_meeting: goodMeeting,
    verdict,
    criteria,
  });

  return {
    rating,
    goodMeeting,
    verdict,
    criteria,
    scorecardId: sc.id as string,
    sampleEvalRunId: er.id as string,
    consequence: consequence ? { trigger: consequence.trigger, action: consequence.action } : null,
  };
}
