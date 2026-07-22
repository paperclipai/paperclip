import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Sql } from "postgres";
import type { ModelCaller } from "../meeting/llm.js";
import { classifyOne, type InquiryInput } from "./qualifier.js";
import { resolveUnit, gov13RouteConsequence, gov17LogAudit, type UnitContext } from "../gov-kernel.js";

// REV-L2 GRADER (the scorecard half of "no hire without a scorecard"). Runs the SAME classifyOne the
// live qualifier runs, over the frozen golden cases (ck_eval.golden_case where active), scores each
// against Alan's ground-truth labels, writes graded eval_runs + a scorecard, routes the consequence,
// and audits — exactly like REV-09/REV-10, but for a JUDGMENT unit so it costs DeepSeek calls.
//
// Therefore it is NOT in the every-30-min deterministic gov-regression loop. It is its own job
// (weekly / manual), budget-capped, and no-ops cleanly while there are zero ACTIVE golden cases
// (i.e. before Alan freezes the draft set) so it never fabricates a verdict.
export const JOB_LOOP_QUALIFY_EVAL = "ck.loop-qualify-eval";

const SPEC_NAME = "REV-L2 Lead-Qualifier";
const TOL = 0.25; // icp_fit / believability are "correct" within this band of gold
const PASS_TARGET = 0.85; // intent exact-match target on the golden set

interface GoldAssertions { intent: string; icp_fit: number; believability: number }

export interface RevL2EvalResult {
  ran: boolean;
  reason?: string;
  volume: number;
  metrics: Record<string, number>;
  verdict?: string;
  scorecardId?: string;
  spentCents: number;
  provider: string;
}

// Pure scoring of one case, exported for unit testing.
export function scoreCase(gold: GoldAssertions, pred: { intent: string; icp_fit: number; believability: number }) {
  const intentOk = pred.intent === gold.intent;
  const icpOk = Math.abs(pred.icp_fit - gold.icp_fit) <= TOL;
  const believOk = Math.abs(pred.believability - gold.believability) <= TOL;
  const passed = intentOk && icpOk && believOk;
  // The dangerous failure: a real, high-ICP buyer dismissed as not-a-buyer. Forces quarantine.
  const realBuyer = gold.intent !== "other" && gold.icp_fit >= 0.6;
  const missedRealBuyer = realBuyer && (pred.intent === "other" || pred.icp_fit < 0.3);
  return { intentOk, icpOk, believOk, passed, missedRealBuyer };
}

export async function runRevL2Eval(
  sql: Sql,
  caller: ModelCaller,
  u: UnitContext,
  opts: { budgetCapCents?: number; activeOnly?: boolean; dryRun?: boolean } = {},
): Promise<RevL2EvalResult> {
  const cap = opts.budgetCapCents ?? 25;
  const activeOnly = opts.activeOnly ?? true;
  const dryRun = opts.dryRun ?? false;

  const cases = activeOnly
    ? await sql`select id, input, assertions, source from ck_eval.golden_case
        where spec_id = ${u.specId} and active and kind = 'assertion' order by source`
    : await sql`select id, input, assertions, source from ck_eval.golden_case
        where spec_id = ${u.specId} and kind = 'assertion' order by source`;

  if (cases.length === 0) {
    return { ran: false, reason: "no golden cases to grade (none active yet — awaiting human freeze)",
      volume: 0, metrics: {}, spentCents: 0, provider: caller.provider };
  }

  let spentCents = 0, intentHits = 0, icpHits = 0, believHits = 0, passes = 0, missed = 0, graded = 0;
  let icpErrSum = 0, believErrSum = 0;
  for (const c of cases) {
    if (spentCents >= cap) break; // budget breaker
    const gold = c.assertions as GoldAssertions;
    let pred: { intent: string; icp_fit: number; believability: number };
    let evidence: Record<string, unknown>;
    let passed = false, score = 0;
    try {
      const cls = await classifyOne(caller, c.input as InquiryInput);
      spentCents += cls.costCents;
      pred = { intent: cls.intent, icp_fit: cls.icp_fit, believability: cls.believability };
      const s = scoreCase(gold, pred);
      if (s.intentOk) intentHits++;
      if (s.icpOk) icpHits++;
      if (s.believOk) believHits++;
      if (s.passed) passes++;
      if (s.missedRealBuyer) missed++;
      icpErrSum += Math.abs(pred.icp_fit - gold.icp_fit);
      believErrSum += Math.abs(pred.believability - gold.believability);
      passed = s.passed; score = s.passed ? 1 : 0;
      evidence = { source: c.source, gold, pred, reason: cls.reason, ...s };
    } catch (err) {
      // unparseable / API error = a failed case (score 0), recorded, not crashed.
      evidence = { source: c.source, gold, error: String(err).slice(0, 160), passed: false };
    }
    graded++;
    if (!dryRun) {
      await sql`insert into ck_eval.eval_run
        (spec_id, mode, case_id, passed, score, evidence, judge, cost_cents)
        values (${u.specId}, 'regression', ${c.id}, ${passed}, ${score},
          ${sql.json(evidence as never)}, ${caller.provider === "stub" ? "stub" : "llm"}, ${Math.round(spentCents)})`;
    }
  }

  const volume = graded;
  const metrics: Record<string, number> = {
    volume,
    intent_accuracy: volume ? intentHits / volume : 0,
    icp_within_0_25: volume ? icpHits / volume : 0,
    believability_within_0_25: volume ? believHits / volume : 0,
    pass_rate: volume ? passes / volume : 0,
    missed_real_buyers: missed,
    icp_mae: volume ? icpErrSum / volume : 0,
    believability_mae: volume ? believErrSum / volume : 0,
  };

  // Safety-first verdict: any missed real buyer quarantines, regardless of headline accuracy.
  const verdict = missed > 0 ? "quarantine" : metrics.pass_rate >= PASS_TARGET ? "keep" : "tune";

  if (dryRun) {
    return { ran: true, reason: "dry-run (no scorecard written)", volume, metrics, verdict, spentCents, provider: caller.provider };
  }

  const evalCents = Math.max(1, Math.round(spentCents));
  const costAdjusted = metrics.pass_rate / evalCents;
  const [sc] = await sql`insert into ck_eval.scorecard
    (spec_id, period_start, period_end, metrics, work_cost_cents, eval_cost_cents, cost_adjusted_score, verdict)
    values (${u.specId}, now() - interval '1 hour', now(), ${sql.json(metrics)}, 0, ${evalCents}, ${costAdjusted}, ${verdict})
    returning id, verdict`;
  const consequence = await gov13RouteConsequence(sql, u.specId, sc.verdict as string, true);
  await gov17LogAudit(sql, u.companyId, u.agentId, "governance.scorecard_computed", "scorecard", sc.id as string,
    { unit: SPEC_NAME, scheduled: true, provider: caller.provider, metrics, verdict: sc.verdict });
  if (consequence)
    await gov17LogAudit(sql, u.companyId, u.agentId, "governance.consequence_routed", "consequence_event",
      consequence.id, { trigger: consequence.trigger, action: consequence.action });

  return { ran: true, volume, metrics, verdict: sc.verdict as string, scorecardId: sc.id as string, spentCents, provider: caller.provider };
}

export function registerLeadQualifierEval(
  ctx: PluginContext,
  deps: { getSql: () => Promise<Sql>; getCaller: () => Promise<ModelCaller> },
): void {
  ctx.jobs.register(JOB_LOOP_QUALIFY_EVAL, async (job) => {
    const sql = await deps.getSql();
    const u = await resolveUnit(sql, SPEC_NAME);
    if (!u) { ctx.logger.warn(`REV-L2 Eval: spec '${SPEC_NAME}' not resolvable (no spec/agent) — skipped.`); return; }
    const caller = await deps.getCaller();
    const r = await runRevL2Eval(sql, caller, u, { budgetCapCents: 25 });
    if (!r.ran) { ctx.logger.info(`REV-L2 Eval: ${r.reason}`); return; }
    ctx.logger.info(
      `REV-L2 Eval: provider=${r.provider} volume=${r.volume} pass_rate=${r.metrics.pass_rate?.toFixed(2)} ` +
        `intent_acc=${r.metrics.intent_accuracy?.toFixed(2)} missed_real_buyers=${r.metrics.missed_real_buyers} ` +
        `verdict=${r.verdict} spent=${r.spentCents.toFixed(4)}c (trigger=${job.trigger})`,
    );
    try {
      const companies = await ctx.companies.list({ limit: 100 });
      const ck = companies.find((c) => c.name === "CK IT Solutions");
      if (ck)
        await ctx.activity.log({
          companyId: ck.id,
          message: `REV-L2 Lead-Qualifier scorecard (${r.provider}): pass_rate ${(r.metrics.pass_rate * 100).toFixed(0)}%, ` +
            `intent ${(r.metrics.intent_accuracy * 100).toFixed(0)}%, missed real buyers ${r.metrics.missed_real_buyers}, verdict ${r.verdict}.`,
          entityType: "job", entityId: JOB_LOOP_QUALIFY_EVAL, metadata: { ...r.metrics, verdict: r.verdict },
        });
    } catch (err) {
      ctx.logger.warn(`REV-L2 Eval: activity log skipped (${String(err).slice(0, 80)})`);
    }
  });
}
