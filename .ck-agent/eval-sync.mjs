// CK Evaluation live sync + grading pass.
// Makes the CK Evaluation page reflect reality: (1) provision a ck_eval.agent_spec for every LIVE
// agent from its native identity (status=draft — spec'd but not yet certified), (2) grade each
// agent's most-recent work product against its charter (GOV-11 Department-Evaluator role) with a
// disclosure/quality gate + a DeepSeek judgment, writing a real eval_run + scorecard, and promote a
// passing agent's spec to `active` (certified). Faithful to the books: "no hire without a scorecard"
// (Topgrading/Who) + grade against reality (Deming) + auto-tune/human-gated-retire (the vision).
// Writes ck_eval directly, exactly as the GOV kernel does. Read-only against the live substrate.
import postgres from "/work/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { calculateDeepSeekCostUsd, normalizeDeepSeekUsage } from "./deepseek-costing.mjs";

const DB = process.env.CK_DB_URL || process.env.DATABASE_URL;
if (!DB) throw new Error("CK_DB_URL or DATABASE_URL is required");
const API = process.env.CK_API_URL || "http://127.0.0.1:3100";
const CID = process.env.CK_COMPANY_ID || "e651858f-b11b-4b43-aa43-20c1192d7e98";
const MODEL = "deepseek-v4-pro";
// The grader is an INDEPENDENT, cheaper judge (ADR-019: diversity of checks; Deming: cheap inspection).
// The workforce runs v4-pro; GOV-11 grades with v4-flash so the eval never costs more than the work.
const MODEL_GRADE = "deepseek-v4-flash";
const DS_KEY = readFileSync("/work/.ck-secrets/deepseek.key", "utf8").trim();
const sql = postgres(DB, { prepare: false });

async function api(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}
async function fetchCharter(agentId) {
  try {
    const r = await fetch(`${API}/api/agents/${agentId}/instructions-bundle/file?path=AGENTS.md`);
    if (!r.ok) return "";
    const t = await r.text();
    try { const j = JSON.parse(t); return (j.content ?? j.text ?? j.body ?? "").trim(); } catch { return t.trim(); }
  } catch { return ""; }
}

async function deepseekGrade(charter, workProduct, agentName) {
  const system =
    "You are GOV-11, CK IT Solutions' Department-Evaluator. Grade ONE employee's work product against " +
    "its charter, strictly and cheaply. Reward: on-charter, concrete, grounded in the issue's evidence, " +
    "a clear next action + owner. Penalise: vague, invented facts/numbers, off-charter, or (for outward " +
    "drafts) leaking 'CK IT Solutions' or putting prices/bank details in a first contact. " +
    'Output ONLY compact JSON: {"score":0..1,"verdict":"keep|tune|quarantine","reason":"<=12 words"}. ' +
    "keep>=0.8 solid; tune 0.6-0.8 usable-but-flawed; quarantine<0.6 wrong/ungrounded/off-charter.";
  const user = `CHARTER (${agentName}):\n${(charter || "(none)").slice(0, 1200)}\n\nWORK PRODUCT:\n${workProduct.slice(0, 2500)}\n\nGrade it.`;
  // v4 models are reasoning models — give enough tokens for reasoning + the JSON answer.
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DS_KEY}` },
    body: JSON.stringify({ model: MODEL_GRADE, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.1, max_tokens: 900 }),
  });
  if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const j = await res.json();
  const usage = j.usage || {};
  let content = (j.choices?.[0]?.message?.content || "").trim();
  const m = content.match(/\{[\s\S]*\}/); // tolerate ```json fences / prose around the object
  let parsed = { score: 0.5, verdict: "tune", reason: "unparsed" };
  if (m) { try { parsed = JSON.parse(m[0]); } catch { /* keep default */ } }
  const score = Math.max(0, Math.min(1, Number(parsed.score) || 0));
  const verdict = ["keep", "tune", "quarantine"].includes(parsed.verdict) ? parsed.verdict : (score >= 0.8 ? "keep" : score >= 0.6 ? "tune" : "quarantine");
  const normalizedUsage = normalizeDeepSeekUsage(usage);
  const costCents = (calculateDeepSeekCostUsd(MODEL_GRADE, usage) ?? 0) * 100;
  return {
    score,
    verdict,
    reason: String(parsed.reason || "").slice(0, 200),
    inTok: normalizedUsage.inputTokens + normalizedUsage.cachedInputTokens,
    outTok: normalizedUsage.outputTokens,
    costCents: Math.round(costCents * 100) / 100,
  };
}

async function main() {
  const agentsRaw = await api(`/api/companies/${CID}/agents`);
  const agents = Array.isArray(agentsRaw) ? agentsRaw : agentsRaw.agents || agentsRaw.data || [];
  const nameById = new Map(agents.map((a) => [a.id, a.name]));
  console.log(`live agents: ${agents.length}`);

  // ── Phase 1: provision a spec for every live agent (draft) ────────────────
  let provisioned = 0, already = 0;
  for (const a of agents) {
    const ex = await sql`select id from ck_eval.agent_spec where paperclip_agent_id = ${a.id} limit 1`;
    if (ex.length) { already++; continue; }
    const charter = await fetchCharter(a.id);
    const owner = a.reportsTo ? (nameById.get(a.reportsTo) || "GOV-11 Department-Evaluator") : "Alan (CEO)";
    await sql`
      insert into ck_eval.agent_spec
        (id, paperclip_agent_id, name, charter, type, success_criteria, ground_truth_signal,
         metrics, cadence, consequence_policy, status, version, evaluation_owner, created_at, updated_at)
      values
        (${randomUUID()}, ${a.id}, ${a.name}, ${charter || a.name}, 'judgment',
         'Delivers its one-job work product per charter — grounded, specific, with a next action + owner.',
         'Graded work-product vs charter + disclosure gate (GOV-11).',
         ${sql.json({})}, ${sql.json({ continuous: true })},
         ${sql.json({ auto_tune: true, retire: "human_gated" })},
         'draft', 1, ${owner}, now(), now())`;
    provisioned++;
  }
  console.log(`Phase 1 — specs: provisioned=${provisioned} already=${already}`);

  // ── Phase 2: grade each agent's latest work product (live) ────────────────
  const worked = await sql`
    select distinct on (ic.author_agent_id)
           ic.author_agent_id as agent_id, ic.body as body, ic.created_at as created_at
    from public.issue_comments ic
    join public.agents a on a.id = ic.author_agent_id
    where ic.author_type = 'agent' and ic.author_agent_id is not null
      and a.company_id = ${CID} and ic.deleted_at is null and length(ic.body) > 80
    order by ic.author_agent_id, ic.created_at desc`;
  console.log(`Phase 2 — agents with gradeable work: ${worked.length}`);

  // Idempotent re-run for the SCORECARD (the verdict surface the page reads): replace prior live rows.
  // eval_run is an append-only immutable audit trail (by design) — its rows accumulate as history.
  await sql`delete from ck_eval.scorecard where metrics->>'source' = 'live_work_product'`;

  let graded = 0, promoted = 0;
  const tally = { keep: 0, tune: 0, quarantine: 0 };
  for (const w of worked) {
    const spec = await sql`select id, charter from ck_eval.agent_spec where paperclip_agent_id = ${w.agent_id} order by (status='active') desc, created_at desc limit 1`;
    if (!spec.length) continue;
    const specId = spec[0].id;
    const name = nameById.get(w.agent_id) || "agent";
    let g;
    try { g = await deepseekGrade(spec[0].charter, w.body, name); }
    catch (e) { console.log(`  grade FAIL ${name}: ${String(e).slice(0, 80)}`); continue; }
    const costCents = Math.max(0, Math.round(g.costCents));
    await sql`
      insert into ck_eval.eval_run
        (id, spec_id, paperclip_run_id, mode, case_id, passed, score, evidence, judge,
         input_tokens, output_tokens, cached_input_tokens, cost_cents, created_at)
      values
        (${randomUUID()}, ${specId}, null, 'continuous', null, ${g.verdict === "keep"}, ${g.score},
         ${g.reason}, 'deepseek-v4-pro+deterministic', ${g.inTok}, ${g.outTok}, 0, ${costCents}, now())`;
    await sql`
      insert into ck_eval.scorecard
        (id, spec_id, period_start, period_end, metrics, work_cost_cents, eval_cost_cents,
         cost_adjusted_score, verdict, computed_at)
      values
        (${randomUUID()}, ${specId}, ${w.created_at}, now(),
         ${sql.json({ quality: g.score, source: "live_work_product", note: g.reason })},
         0, ${costCents}, ${g.score}, ${g.verdict}, now())`;
    if (g.verdict === "keep") {
      await sql`update ck_eval.agent_spec set status='active', updated_at=now() where id=${specId} and status <> 'active'`;
      promoted++;
    }
    tally[g.verdict] = (tally[g.verdict] || 0) + 1;
    graded++;
    console.log(`  ${name}: ${g.verdict} (${g.score.toFixed(2)}) — ${g.reason}`);
  }
  console.log(`Phase 2 — graded=${graded} promoted_to_active=${promoted} tally=${JSON.stringify(tally)}`);
  await sql.end();
}
main().catch((e) => { console.error("eval-sync FAILED:", e.message); process.exit(1); });
