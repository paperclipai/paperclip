// IDS — segment 6, the heart, and the ONLY segment that spends real tokens (meeting-flow.md §6).
//
// Input: the SPC-filtered, constraint-ranked meeting_issue list + believability weights. GOV-24 works
// top-down, few deeply (time-box = token-box), under a HARD per-meeting budget. For each issue:
//   I — Identify the REAL root (Coaching-Habit "and what else?"), not the headline number.
//   D — Discuss with a MANDATORY Red-Team seat: a SEPARATE model invocation with an adversarial prompt
//       (and optionally a diverse model), mandated to argue the opposing hypothesis — observations not
//       accusations, evidence-cited (Crucial Conversations / NVC). The disagreement is logged.
//   S — Solve to ONE decision + a to-do (single owner_unit + due_at), AND — critically — encode the root
//       cause as a permanent ck_eval.golden_case (the corpus-learns loop, ADR-020). A solve without a
//       golden case is INCOMPLETE.
// Believability-weighting (Dalio): issues are ranked by impact × believability; earned weight, not
// one-agent-one-vote. Unsolved lower-priority issues stay 'open' for next week.

import type { Sql } from "postgres";
import type { ModelCaller, ChatResult } from "./llm.js";
import { gov13RouteConsequence, gov17LogAudit } from "../gov-kernel.js";

export interface IdsDeps {
  sql: Sql;
  caller: ModelCaller;
  companyId: string;
  agentId: string; // the chair (GOV-24 Issues-Manager) — actor for cost_events + audit
  meetingRunId: string;
  meetingSpecId: string; // golden-case fallback spec for non-scorecard issues
  constraint: string;
  budgetCapCents: number;
  topN?: number;
  primaryModel?: string;
  redTeamModel?: string; // diverse model for the Red-Team seat (diversity > quantity, 02b §3d)
}

interface IssueRow {
  id: string;
  source_kind: string;
  source_ref: string | null;
  title: string;
  impact_score: string | number;
  believability: string | number;
  redteam: unknown;
  evidence?: unknown;
}

export interface SolvedIssue {
  issueId: string;
  title: string;
  identifiedRoot: string;
  decision: string;
  ownerUnit: string;
  dueAt: string;
  goldenCaseId: string;
  redTeamDisagreement: string;
  consequence: { trigger: string; action: string } | null;
}

export interface IdsReport {
  solved: SolvedIssue[];
  deferred: number;
  observedCents: number;
  tripped: boolean;
  llmCalls: number;
  goldenCasesWritten: number;
}

// Robust JSON extraction from a model reply (handles code fences / stray prose).
function parseJson(text: string): Record<string, unknown> {
  const fenced = text.replace(/```json|```/gi, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(fenced.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return {};
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);

export function idsBillingType(provider: string): "metered_api" | "unknown" {
  return provider === "deepseek" ? "metered_api" : "unknown";
}

export async function runIds(deps: IdsDeps): Promise<IdsReport> {
  const { sql, caller, companyId, agentId, meetingRunId, meetingSpecId } = deps;
  const topN = deps.topN ?? 3;
  const cap = deps.budgetCapCents;

  // Constraint-rank: impact × believability, desc (Goldratt + Dalio). Solve the bottleneck first.
  const issues = (await sql`
    select id, source_kind, source_ref, title, impact_score, believability, redteam, evidence
    from ck_eval.meeting_issue
    where meeting_run_id = ${meetingRunId} and status = 'open'
    order by (impact_score * believability) desc, impact_score desc
  `) as unknown as IssueRow[];

  const solved: SolvedIssue[] = [];
  let observed = 0;
  let tripped = false;
  let llmCalls = 0;
  let goldenCasesWritten = 0;

  const charge = async (r: ChatResult, stage: string, issueId: string): Promise<void> => {
    llmCalls++;
    observed += r.costCents;
    const billingType = idsBillingType(caller.provider);
    await sql`insert into public.cost_events
      (company_id, agent_id, provider, biller, billing_type, model,
       input_tokens, output_tokens, cost_cents, occurred_at)
      values (${companyId}, ${agentId}, ${caller.provider}, ${caller.provider}, ${billingType},
        ${`${r.model}:ids-${stage}`}, ${r.inputTokens}, ${r.outputTokens}, ${r.costCents}, now())`;
    void issueId;
  };

  const budgetExhausted = (): boolean => Math.round(observed) >= cap;

  let processed = 0;
  for (const issue of issues) {
    if (processed >= topN) break; // few, deeply
    if (budgetExhausted()) {
      tripped = true;
      break;
    }
    processed++;

    const issueJson = JSON.stringify({
      title: issue.title,
      evidence: issue.evidence ?? {},
      named_constraint: deps.constraint,
      believability: Number(issue.believability),
    });

    // I — Identify the real root.
    const identify = await caller.chat({
      system:
        "You are GOV-24 Issues-Manager running IDS in an EOS Level-10 meeting. Find the REAL root cause " +
        "of the issue, not the surface number. Apply the Coaching Habit 'and what else?' to surface the " +
        "underlying problem. Reply ONLY as JSON: " +
        '{"root_cause": string, "and_what_else": string[]}.',
      user: issueJson,
      json: true,
      maxTokens: 220,
      model: deps.primaryModel,
    });
    await charge(identify, "identify", issue.id);
    const idObj = parseJson(identify.text);
    const rootCause = str(idObj.root_cause, "root cause not established");

    if (budgetExhausted()) {
      tripped = true;
      break;
    }

    // D — Discuss: the MANDATORY Red-Team seat (separate invocation, adversarial prompt, diverse model).
    const redteam = await caller.chat({
      system:
        "You are the RED-TEAM seat, mandated to DISAGREE. Argue the OPPOSING hypothesis to the proposed " +
        "root cause. Phrase per Crucial Conversations/NVC: OBSERVATIONS not accusations, tentative, and " +
        "EVIDENCE-CITED (cite the numbers). You pay zero social cost — mine for the conflict the humans " +
        'would avoid. Reply ONLY as JSON: {"opposing_hypothesis": string, "evidence": string, "observation": string}.',
      user: JSON.stringify({ issue: issueJson, proposed_root_cause: rootCause }),
      json: true,
      maxTokens: 220,
      temperature: 0.4,
      model: deps.redTeamModel ?? deps.primaryModel,
    });
    await charge(redteam, "redteam", issue.id);
    const rtObj = parseJson(redteam.text);
    const redTeamDisagreement = str(rtObj.opposing_hypothesis, "(red-team produced no parseable disagreement)");
    const redTeamRecord = {
      opposing_hypothesis: redTeamDisagreement,
      evidence: str(rtObj.evidence),
      observation: str(rtObj.observation),
      model: redteam.model,
    };

    if (budgetExhausted()) {
      // We have a root + a logged disagreement but no budget to solve; leave open, record the red-team.
      await sql`update ck_eval.meeting_issue
        set redteam = ${sql.json(redTeamRecord as never)}, identified_root = ${rootCause}, updated_at = now()
        where id = ${issue.id}`;
      tripped = true;
      break;
    }

    // S — Solve: converge to ONE decision + a to-do, having WEIGHED the red-team (disagree-and-commit).
    const solve = await caller.chat({
      system:
        "You are GOV-24 Issues-Manager converging the IDS to a SOLVE. You have the proposed root cause AND " +
        "the Red-Team's opposing view; weigh both (disagree-and-commit) and decide. Output ONE clear " +
        "decision with a single owner_unit and a due date in days, AND a golden_rule: a permanent " +
        "regression assertion that would catch this issue recurring. Also classify the governance " +
        'consequence for the source unit. Reply ONLY as JSON: {"decision": string, "owner_unit": string, ' +
        '"due_in_days": number, "golden_rule": string, "consequence": "none"|"tune"|"quarantine"}.',
      user: JSON.stringify({
        issue: issueJson,
        root_cause: rootCause,
        red_team: redTeamRecord,
        named_constraint: deps.constraint,
      }),
      json: true,
      maxTokens: 260,
      model: deps.primaryModel,
    });
    await charge(solve, "solve", issue.id);
    const sObj = parseJson(solve.text);
    const decision = str(sObj.decision, `Investigate and correct: ${issue.title}`);
    const ownerUnit = str(sObj.owner_unit, "GOV-24");
    const dueDays = Number.isFinite(Number(sObj.due_in_days)) ? Math.max(1, Math.min(30, Number(sObj.due_in_days))) : 7;
    const goldenRule = str(
      sObj.golden_rule,
      `If "${issue.title}" recurs it must be re-flagged as special-cause and routed to IDS.`,
    );
    const consequenceClass = ["none", "tune", "quarantine"].includes(String(sObj.consequence))
      ? String(sObj.consequence)
      : "none";

    const dueAt = new Date(Date.now() + dueDays * 86_400_000).toISOString();

    // ★ Write the golden case — the corpus-learns loop (ADR-020). Attach to the source spec when the
    // issue came from a scorecard; otherwise to the meeting's own spec.
    const goldenSpecId =
      issue.source_kind === "scorecard_spc" && issue.source_ref ? issue.source_ref : meetingSpecId;
    const [gc] = await sql`insert into ck_eval.golden_case
      (spec_id, kind, input, expected, assertions, rubric, source, reviewed_by, reviewed_at, active)
      values (${goldenSpecId}, 'assertion',
        ${sql.json({ issue_title: issue.title, evidence: issue.evidence ?? {} } as never)},
        null,
        ${sql.json({ golden_rule: goldenRule, root_cause: rootCause, red_team_considered: redTeamRecord.opposing_hypothesis } as never)},
        null, ${`meeting:weekly_tactical:${meetingRunId}`}, 'GOV-24 (IDS meeting)', now(), true)
      returning id`;
    goldenCasesWritten++;

    // Update the issue to solved with the full IDS outcome.
    await sql`update ck_eval.meeting_issue
      set status = 'solved', identified_root = ${rootCause}, decision = ${decision},
          owner_unit = ${ownerUnit}, due_at = ${dueAt}, golden_case_id = ${gc.id},
          redteam = ${sql.json(redTeamRecord as never)}, updated_at = now()
      where id = ${issue.id}`;

    // Route a governance consequence on the source unit if the solve calls for it (retire stays
    // human-gated inside gov13RouteConsequence).
    let consequence: { trigger: string; action: string } | null = null;
    if (consequenceClass !== "none" && issue.source_kind === "scorecard_spc" && issue.source_ref) {
      const verdict = consequenceClass === "quarantine" ? "quarantine" : "tune";
      const ev = await gov13RouteConsequence(sql, issue.source_ref, verdict, true);
      if (ev) consequence = { trigger: ev.trigger, action: ev.action };
    }

    // Audit: the decision + the golden case, to the immutable activity_log (GOV-17).
    await gov17LogAudit(sql, companyId, agentId, "meeting.ids_solved", "meeting_issue", issue.id, {
      decision,
      owner_unit: ownerUnit,
      due_at: dueAt,
      root_cause: rootCause,
      red_team: redTeamRecord.opposing_hypothesis,
      golden_case_id: gc.id,
      consequence,
    });

    solved.push({
      issueId: issue.id,
      title: issue.title,
      identifiedRoot: rootCause,
      decision,
      ownerUnit,
      dueAt,
      goldenCaseId: gc.id as string,
      redTeamDisagreement,
      consequence,
    });
  }

  // Budget incident if the time-box=token-box tripped (mirrors the M1-proven budget breaker).
  if (tripped) {
    const policy = (await sql`
      select id from public.budget_policies
      where scope_type = 'agent' and scope_id = ${agentId} and metric = 'billed_cents'
      order by created_at desc limit 1
    `) as unknown as Array<{ id: string }>;
    if (policy[0]) {
      await sql`insert into public.budget_incidents
        (company_id, policy_id, scope_type, scope_id, metric, window_kind, window_start, window_end,
         threshold_type, amount_limit, amount_observed, status)
        values (${companyId}, ${policy[0].id}, 'agent', ${agentId}, 'billed_cents', 'lifetime', now(), now(),
          'hard', ${cap}, ${Math.round(observed)}, 'open')`;
    }
  }

  const deferred = issues.length - solved.length;
  return { solved, deferred, observedCents: observed, tripped, llmCalls, goldenCasesWritten };
}
