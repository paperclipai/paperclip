// v0.4 proof — a Weekly Tactical end-to-end on the live ck_workforce DB, in a THROWAWAY test company.
// Mirrors run-m3.ts. Determinism-first: MODE=stub (default, free) proves the whole machine; MODE=deepseek
// does the real IDS on a tiny budget (cents); MODE=breaker forces a budget trip to prove IDS can't run away.
// Set DEEPSEEK_MODEL=deepseek-v4-flash|deepseek-v4-pro to pick the current DeepSeek lane explicitly.
//
//   cd /work/packages/db && DATABASE_URL=... [DEEPSEEK_API_KEY=...] MODE=deepseek \
//     node_modules/.bin/tsx ../plugins/plugin-ck-office/src/meeting/run-weekly.ts
//
// The API key is read from env (supplied via a 0600 --env-file at runtime), never logged/stored/in argv.
import postgres from "postgres";
import { StubCaller, DeepseekCaller, type ModelCaller, type ChatRequest, type ChatResult } from "./llm.js";
import { ensureMeetingSpec, runWeeklyTactical } from "./weekly-tactical.js";
import type { PreReadSource } from "./segments.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const MODE = process.env.MODE ?? "stub";
const KEY = process.env.DEEPSEEK_API_KEY ?? "";
if (MODE === "deepseek" && !KEY) throw new Error("MODE=deepseek needs DEEPSEEK_API_KEY (via --env-file)");
const CAP = Number(process.env.BUDGET_CAP_CENTS ?? 5);
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const sql = postgres(url, { onnotice: () => {} });

const TEST_COMPANY = "CK TEST — Meeting v0.4";

// A stub that charges a FIXED cents per call — used by MODE=breaker to exercise the budget breaker.
class FixedCostStub implements ModelCaller {
  readonly provider = "stub-fixedcost";
  private inner = new StubCaller();
  constructor(private centsPerCall: number) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    const r = await this.inner.chat(req);
    return { ...r, costCents: this.centsPerCall, model: "stub-fixedcost" };
  }
}

function makeCaller(): ModelCaller {
  if (MODE === "deepseek") return new DeepseekCaller(KEY, DEEPSEEK_MODEL);
  if (MODE === "breaker") return new FixedCostStub(2); // 2c/call, cap 5c -> trips inside meeting
  return new StubCaller();
}

async function ensureCompanyAndAgent(): Promise<{ companyId: string; agentId: string }> {
  let [co] = await sql`select id from public.companies where name = ${TEST_COMPANY} limit 1`;
  if (!co) [co] = await sql`insert into public.companies (name, status, issue_prefix)
    values (${TEST_COMPANY}, 'active', 'TST') returning id`;
  let [ag] = await sql`select id from public.agents where company_id = ${co.id} and name = 'GOV-24 Issues-Manager (chair)' limit 1`;
  if (!ag) [ag] = await sql`insert into public.agents (company_id, name, role, status, adapter_type, adapter_config)
    values (${co.id}, 'GOV-24 Issues-Manager (chair)', 'governance', 'idle', 'process', ${sql.json({})}) returning id`;
  await sql`update public.agents set paused_at = null, pause_reason = null where id = ${ag.id}`;
  return { companyId: co.id as string, agentId: ag.id as string };
}

// Seed a spec + a scorecard SERIES (idempotent: only seeds if the spec has no scorecards yet, so reruns
// don't shift the SPC limits). Returns the spec id.
async function seedSeriesSpec(
  companyId: string,
  name: string,
  metricKey: string,
  series: number[],
  believability: number,
): Promise<string> {
  let [spec] = await sql`select id from ck_eval.agent_spec where name = ${name} limit 1`;
  if (!spec) [spec] = await sql`insert into ck_eval.agent_spec
    (name, charter, type, success_criteria, ground_truth_signal, evaluation_owner, metrics, cadence, status)
    values (${name}, ${`Seeded test metric ${metricKey} so that the SPC filter has a real series to read.`},
      'deterministic', 'series matches seeded ground truth', 'seeded series', 'GOV-12',
      ${sql.json({ [metricKey]: ">=target" })}, ${sql.json({ continuous: true, periodic: "weekly" })}, 'active')
    returning id`;
  const existing = (await sql`select count(*)::int as n from ck_eval.scorecard where spec_id = ${spec.id}`) as unknown as Array<{ n: number }>;
  if (existing[0].n === 0) {
    const N = series.length;
    for (let i = 0; i < N; i++) {
      const ageHours = N - i; // oldest first
      await sql`insert into ck_eval.scorecard
        (spec_id, period_start, period_end, metrics, work_cost_cents, eval_cost_cents, cost_adjusted_score, verdict, computed_at)
        values (${spec.id}, now() - (${ageHours + 1} || ' hours')::interval, now() - (${ageHours} || ' hours')::interval,
          ${sql.json({ [metricKey]: series[i] })}, 0, 0, ${believability}, 'keep', now() - (${ageHours} || ' hours')::interval)`;
    }
  }
  return spec.id as string;
}

// ── build the throwaway pre-read source ─────────────────────────────────────────
const { companyId, agentId } = await ensureCompanyAndAgent();
const meetingSpecId = await ensureMeetingSpec(sql, agentId);

// Budget policy on the chair (the meeting's time-box=token-box).
await sql`insert into public.budget_policies
  (company_id, scope_type, scope_id, metric, window_kind, amount, hard_stop_enabled, notify_enabled, is_active)
  values (${companyId}, 'agent', ${agentId}, 'billed_cents', 'lifetime', ${CAP}, true, false, true)
  on conflict (company_id, scope_type, scope_id, metric, window_kind) do update set amount = ${CAP}, is_active = true`;

// Segment-2 metrics: a NOISE-red (dropped), a SIGNAL-red on the constraint (promoted), and a GREEN one.
const qualitySpecId = await seedSeriesSpec(companyId, "TEST Outreach-Quality", "reply_quality",
  [0.85, 0.79, 0.88, 0.81, 0.9, 0.78, 0.86, 0.82, 0.79], 0.9);
const throughputSpecId = await seedSeriesSpec(companyId, "TEST Lead-Throughput", "qualified_leads",
  [30, 32, 28, 31, 29, 33, 27, 30, 8], 0.95);
const volumeSpecId = await seedSeriesSpec(companyId, "TEST Outreach-Volume", "outreach_sent",
  [110, 115, 108, 112, 120, 118, 116, 119, 120], 0.9);

const source: PreReadSource = {
  companyId,
  constraint: "qualified leads into the pipeline (the money constraint)",
  wins: ["Closed CHF 5k Tres Hermanos reorder", "GOV-01 regression green all week"],
  metrics: [
    { name: "reply quality", specId: qualitySpecId, metricKey: "reply_quality", target: 0.8, better: "higher_is_better" },
    { name: "qualified leads", specId: throughputSpecId, metricKey: "qualified_leads", target: 20, better: "higher_is_better", onConstraint: true, pairedWith: "reply quality" },
    { name: "outreach sent", specId: volumeSpecId, metricKey: "outreach_sent", target: 100, better: "higher_is_better", pairedWith: "reply quality" },
  ],
  okrs: [
    { id: "okr-leadgen", name: "Double qualified-lead flow", krScores: [0.3, 0.5], onConstraint: true },
    { id: "okr-ops", name: "Eval coverage to 90%", krScores: [0.8, 0.9] },
  ],
  rocks: [{ id: "rock-crm", name: "CRM reconcile automation live", status: "off_track" }],
  todos: [
    { id: "td-1", title: "Send Q3 supplier RFQ", owner: "REV-06", dueAt: null, done: true },
    { id: "td-2", title: "Fix forecaster weight bug", owner: "REV-10", dueAt: null, done: false },
  ],
  headlines: [{ text: "Divino churn signal on 2 accounts", actionNeeded: true }],
};

console.log(`# Weekly Tactical v0.4 — mode=${MODE}, budget cap=${CAP}c, company=${TEST_COMPANY}`);

  const report = await runWeeklyTactical({
    sql,
    caller: makeCaller(),
    companyId,
    agentId,
    meetingSpecId,
    source,
    budgetCapCents: CAP,
    topN: 3,
    primaryModel: MODE === "deepseek" ? DEEPSEEK_MODEL : undefined,
    redTeamModel: MODE === "deepseek" ? DEEPSEEK_MODEL : undefined, // separate adversarial invocation
  });

// ── narrate ─────────────────────────────────────────────────────────────────────
const { packet, ids, grade, conclude } = report;
console.log(`\n[segments 1–5] pre-read assembled (deterministic):`);
console.log(`  segue wins: ${packet.segue.wins.join(" | ")}`);
console.log(`  scorecard: ${packet.scorecard.map((s) => `${s.name}=${s.latest}(${s.outcome})`).join(", ")}`);
console.log(`  SPC dropped (noise-reds): ${packet.spc_dropped.map((d) => d.metric).join(", ") || "(none)"}`);
console.log(`  promoted issues: ${report.promotedCount}`);
console.log(`\n[segment 6] IDS (the only LLM segment): solved=${ids.solved.length} deferred=${ids.deferred} llmCalls=${ids.llmCalls} spend=${ids.observedCents.toFixed(4)}c tripped=${ids.tripped}`);
for (const s of ids.solved) {
  console.log(`  • SOLVED: ${s.title}`);
  console.log(`      root: ${s.identifiedRoot.slice(0, 100)}`);
  console.log(`      RED-TEAM disagreed: ${s.redTeamDisagreement.slice(0, 100)}`);
  console.log(`      decision: ${s.decision.slice(0, 100)}`);
  console.log(`      to-do: owner=${s.ownerUnit} due=${s.dueAt.slice(0, 10)}  golden_case=${s.goldenCaseId}  consequence=${s.consequence ? `${s.consequence.trigger}->${s.consequence.action}` : "none"}`);
}
console.log(`\n[segment 7] conclude: rating=${conclude.rating}/10  FYIs=${conclude.fyiCount}  good_meeting=${grade.goodMeeting} verdict=${grade.verdict}`);
console.log(`  grade criteria: ${JSON.stringify(grade.criteria)}`);

// ── DB-verified DoD checklist ─────────────────────────────────────────────────────
const [mrun] = await sql`select rating, spend_cents, finished_at, meta_eval_ref, packet from ck_eval.meeting_run where id = ${report.meetingRunId}`;
const dropped = (packet.spc_dropped.some((d) => d.metric === "reply quality"));
const promotedSignal = packet.scorecard.find((s) => s.name === "qualified leads")?.outcome === "promoted_signal";
const [gcCount] = await sql`select count(*)::int as n from ck_eval.golden_case where source = ${`meeting:weekly_tactical:${report.meetingRunId}`}`;
const [costAgg] = await sql`select coalesce(sum(cost_cents),0)::int as cents, count(*)::int as n from public.cost_events where company_id = ${companyId} and model like '%ids-%'`;
const [actCount] = await sql`select count(*)::int as n from public.activity_log where company_id = ${companyId} and entity_id::text = ${report.meetingRunId}`;
const idsAudits = (await sql`select count(*)::int as n from public.activity_log where company_id = ${companyId} and action = 'meeting.ids_solved'`) as unknown as Array<{ n: number }>;
const topSolved = grade.criteria.solved_top_constraint_issue;
const redTeamLogged = ids.solved.length > 0 && ids.solved.every((s) => s.redTeamDisagreement.length > 0);
const [incident] = await sql`select count(*)::int as n from public.budget_incidents where company_id = ${companyId}`;

const proof: Record<string, boolean> = {
  "pre-read assembled deterministically (no LLM in segments 1–5)": packet.scorecard.length === 3 && packet.issues_promoted.length > 0,
  "SPC DROPPED a noise-red (reply quality)": dropped,
  "SPC PROMOTED a signal-red to an Issue (qualified leads)": !!promotedSignal,
  "IDS produced a decision + to-do (owner+due)": ids.solved.length > 0 && ids.solved.every((s) => !!s.ownerUnit && !!s.dueAt),
  "a real Red-Team disagreement was logged": redTeamLogged,
  "the top constraint-issue was solved": topSolved,
  "a ck_eval.golden_case was WRITTEN on solve": (gcCount.n as number) >= 1,
  "everything logged to immutable activity_log": (mrun != null) && idsAudits[0].n >= 1 && (actCount.n as number) >= 1,
  "meeting_run finalized (rating + meta_eval_ref handed to GOV-12)": mrun?.rating != null && mrun?.meta_eval_ref != null,
  "the meeting self-rated AND is itself scored": conclude.rating >= 1 && !!grade.scorecardId,
  "IDS ran under the per-meeting budget (cost_events captured)": MODE === "breaker" ? ids.tripped : Math.round(ids.observedCents) <= CAP,
};
if (MODE === "breaker") proof["budget breaker fired an incident (IDS cannot run away)"] = (incident.n as number) >= 1;

console.log(`\n  cost_events (this meeting's IDS): ${costAgg.n} events, ${costAgg.cents}c stored (real float ${ids.observedCents.toFixed(4)}c)`);
console.log(`  budget_incidents for test company: ${incident.n}`);
console.log("\n══════════ v0.4 WEEKLY TACTICAL — DoD PROOF ══════════");
let ok = true;
for (const [k, v] of Object.entries(proof)) { console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`); if (!v) ok = false; }
console.log(ok
  ? `\n✅ Weekly Tactical proven end-to-end (mode=${MODE}). Real LLM spend this run: ${ids.observedCents.toFixed(4)}c. meeting_run=${report.meetingRunId}`
  : `\n❌ DoD incomplete — see FAILs. meeting_run=${report.meetingRunId}`);
await sql.end();
process.exit(ok ? 0 : 1);
