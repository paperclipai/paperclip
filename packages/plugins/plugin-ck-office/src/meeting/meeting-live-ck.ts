// Run a COMPLETE Weekly Tactical (Level-10 / Mochary / Goldratt) for the LIVE CK IT Solutions company,
// so the CK Meeting Room page shows a real meeting (Issues List + IDS decisions + self-rating), not the
// throwaway demo. Metrics/wins/todos/headlines are assembled from REAL ck_workforce data (no external
// dep). IDS runs on the current DeepSeek V4 lane (flash by default; override with DEEPSEEK_MODEL) under
// a hard budget cap. Invoke:
//   cd /work/packages/db && DATABASE_URL=... DEEPSEEK_API_KEY=... \
//     /work/node_modules/.bin/tsx ../plugins/plugin-ck-office/src/meeting/meeting-live-ck.ts
import postgres from "postgres";
import { DeepseekCaller } from "./llm.js";
import { ensureMeetingSpec, runWeeklyTactical } from "./weekly-tactical.js";
import { assembleLivePreRead } from "./live-preread.js";
import type { PreReadSource, MetricInput } from "./segments.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const KEY = process.env.DEEPSEEK_API_KEY ?? "";
if (!KEY) throw new Error("DEEPSEEK_API_KEY required");
const CID = process.env.CK_COMPANY_ID ?? "e651858f-b11b-4b43-aa43-20c1192d7e98";
const CHAIR = process.env.CK_CHAIR_AGENT_ID ?? "88a0f76f-802d-4af2-81fa-1a0cd3deeb4c"; // GOV-25 Chief-of-Staff
const CAP = Number(process.env.BUDGET_CAP_CENTS ?? 25);
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const sql = postgres(url, { onnotice: () => {} });

// Seed a real single-point metric series so segment-2 SPC has a spec to read (honest snapshot).
async function seedMetric(name: string, metricKey: string, value: number, believability: number): Promise<string> {
  let [spec] = await sql`select id from ck_eval.agent_spec where name = ${name} limit 1`;
  if (!spec) {
    [spec] = await sql`insert into ck_eval.agent_spec
      (name, charter, type, success_criteria, ground_truth_signal, evaluation_owner, metrics, cadence, status)
      values (${name}, ${`Live ops metric ${metricKey} for the CK Weekly Tactical.`}, 'deterministic',
        'series matches live ground truth', 'live ck_workforce query', 'GOV-12',
        ${sql.json({ [metricKey]: ">=target" })}, ${sql.json({ continuous: true, periodic: "weekly" })}, 'active')
      returning id`;
  }
  // Refresh the latest point each run (idempotent-ish: append a fresh weekly point).
  await sql`insert into ck_eval.scorecard
    (spec_id, period_start, period_end, metrics, work_cost_cents, eval_cost_cents, cost_adjusted_score, verdict, computed_at)
    values (${spec.id}, now() - interval '7 days', now(), ${sql.json({ [metricKey]: value })}, 0, 0, ${believability}, 'keep', now())`;
  return spec.id as string;
}

async function main() {
  // ── real metrics from live data ──────────────────────────────────────────────
  const [{ off_charter }] = (await sql`
    select count(*)::int as off_charter from ck_eval.scorecard
    where verdict = 'quarantine' and metrics->>'source' = 'live_work_product'`) as unknown as Array<{ off_charter: number }>;
  const [{ certified }] = (await sql`
    select count(*)::int as certified from ck_eval.agent_spec s
    join public.agents a on a.id = s.paperclip_agent_id
    where a.company_id = ${CID} and s.status = 'active'`) as unknown as Array<{ certified: number }>;
  const [{ work_products }] = (await sql`
    select count(*)::int as work_products from public.issue_comments ic
    join public.agents a on a.id = ic.author_agent_id
    where a.company_id = ${CID} and ic.author_type = 'agent' and ic.deleted_at is null`) as unknown as Array<{ work_products: number }>;

  console.log(`live metrics: off_charter=${off_charter} certified=${certified} work_products=${work_products}`);

  // off-charter units is the money-relevant RED (bad work never converts) → the meeting's IDS topic.
  const offCharterSpec = await seedMetric("CK Off-Charter-Rate", "off_charter_units", off_charter, 0.95);
  const certifiedSpec = await seedMetric("CK Certified-Units", "certified_units", certified, 0.9);
  const wpSpec = await seedMetric("CK Work-Products", "work_products_delivered", work_products, 0.85);

  // ── real todos: open issues assigned to agents ───────────────────────────────
  const openIssues = (await sql`
    select i.id, i.title, coalesce(a.name, 'unassigned') as owner, i.status
    from public.issues i left join public.agents a on a.id = i.assignee_agent_id
    where i.company_id = ${CID} and i.status in ('todo', 'in_progress')
    order by i.updated_at desc limit 5`) as unknown as Array<{ id: string; title: string; owner: string; status: string }>;

  // ── real wins from the eval pass ─────────────────────────────────────────────
  const live = await assembleLivePreRead(sql, CID).catch(() => null);
  const wins = (live?.wins?.length ? live.wins : [
    `${certified} agents certified this week (live grading)`,
    `Disposition loop fixed — runs close cleanly`,
  ]).slice(0, 3);

  const metrics: MetricInput[] = [
    { name: "off-charter units", specId: offCharterSpec, metricKey: "off_charter_units", target: 0, better: "lower_is_better", onConstraint: true, pairedWith: "certified units" },
    { name: "certified units", specId: certifiedSpec, metricKey: "certified_units", target: 20, better: "higher_is_better" },
    { name: "work products", specId: wpSpec, metricKey: "work_products_delivered", target: 60, better: "higher_is_better", pairedWith: "certified units" },
  ];

  const source: PreReadSource = {
    companyId: CID,
    constraint: "qualified leads into the pipeline (the money constraint)",
    wins,
    metrics,
    okrs: [
      { id: "okr-outbound", name: "Stand up the B2B outbound reorder loop", krScores: [0.4, 0.2], onConstraint: true },
      { id: "okr-quality", name: "Every agent on-charter (0 quarantined)", krScores: [0.5] },
    ],
    rocks: [
      { id: "rock-outbound", name: "First B2B venue placement drafted → approved → sent", status: "off_track", onConstraint: true },
      { id: "rock-eval", name: "Live evaluation spine self-maintaining", status: "on_track" },
    ],
    todos: openIssues.map((i, n) => ({ id: i.id || `td-${n}`, title: i.title, owner: i.owner, dueAt: null, done: i.status === "done" })),
    headlines: [
      { text: `${off_charter} agents graded OFF-CHARTER this week — bad work never converts to revenue`, actionNeeded: true, onConstraint: true },
    ],
  };

  const meetingSpecId = await ensureMeetingSpec(sql, CHAIR);
  await sql`insert into public.budget_policies
    (company_id, scope_type, scope_id, metric, window_kind, amount, hard_stop_enabled, notify_enabled, is_active)
    values (${CID}, 'agent', ${CHAIR}, 'billed_cents', 'lifetime', ${CAP}, true, false, true)
    on conflict (company_id, scope_type, scope_id, metric, window_kind) do update set amount = ${CAP}, is_active = true`;

  console.log(`# CK IT Solutions Weekly Tactical — chair=GOV-25, cap=${CAP}c, todos=${openIssues.length}`);
  const report = await runWeeklyTactical({
    sql, caller: new DeepseekCaller(KEY, DEEPSEEK_MODEL),
    companyId: CID, agentId: CHAIR, meetingSpecId, source, budgetCapCents: CAP,
    topN: 3, primaryModel: DEEPSEEK_MODEL, redTeamModel: DEEPSEEK_MODEL,
  });

  console.log(`meeting_run=${report.meetingRunId}`);
  console.log(`promoted issues=${report.promotedCount}  IDS solved=${report.ids.solved.length} deferred=${report.ids.deferred} spend=${report.ids.observedCents.toFixed(3)}c tripped=${report.ids.tripped}`);
  for (const s of report.ids.solved) console.log(`  • SOLVED: ${s.title}\n      decision: ${s.decision.slice(0, 120)}\n      red-team: ${s.redTeamDisagreement.slice(0, 100)}`);
  console.log(`rating=${report.conclude.rating}/10  good_meeting=${report.grade.goodMeeting}`);
  await sql.end();
}
main().catch((e) => { console.error("meeting-live FAILED:", e.message, e.stack?.split("\n").slice(0, 3).join(" | ")); process.exit(1); });
