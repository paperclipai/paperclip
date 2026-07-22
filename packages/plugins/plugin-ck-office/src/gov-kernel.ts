// GOV evaluation kernel, re-hosted inside the CK Evaluation Office plugin so the
// governance/eval loop runs ITSELF on a schedule instead of by-hand scripts.
//
// This is a faithful port of the proven kernel in
// ~/ck-hermes/ai-company/build/gov-kernel/ (kernel.ts + the run-* scripts):
//   GOV-07 grade -> GOV-02 metrics -> GOV-03 scorecard -> GOV-13 consequence -> GOV-17 audit.
// Deterministic, zero LLM/paid calls. It writes to the live ck_eval tables and
// Paperclip's immutable public.activity_log via the same `postgres` client the
// worker already uses (see worker.ts `db()`), so the SQL ports over unchanged.
//
// The two scheduled jobs only run the HEALTHY path of each unit (no disabled rules):
// certified production units are graded against ground truth every cycle and their
// verdicts/consequences routed. Retire is NEVER auto-executed (human-gated).
import type { Sql } from "postgres";
import { guard, type GuardContext } from "./safety/disclosure-guard.js";

// ── Unit logic: GOV-01 Spec-Registrar (deterministic validator) ────────────────
// Ported from build/gov-kernel/gov01-spec-registrar.ts — rules 1-8 exactly.
export type SpecType = "deterministic" | "judgment" | "hybrid";

export interface SpecCandidate {
  name?: unknown;
  charter?: unknown;
  type?: unknown;
  inputs_schema?: unknown;
  outputs_schema?: unknown;
  success_criteria?: unknown;
  ground_truth_signal?: unknown;
  metrics?: unknown;
  evaluation_owner?: unknown;
  cadence?: unknown;
  consequence_policy?: unknown;
  status?: unknown;
}

export interface VerdictItem { field: string; rule: number; message: string; }
export interface Verdict { valid: boolean; errors: VerdictItem[]; warnings: VerdictItem[]; }

const TYPES: SpecType[] = ["deterministic", "judgment", "hybrid"];
const PERIODICS = ["none", "daily", "weekly", "monthly"];

const nonEmptyStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function validateSpec(spec: SpecCandidate, opts: { disabledRules?: number[] } = {}): Verdict {
  const off = new Set(opts.disabledRules ?? []);
  const errors: VerdictItem[] = [];
  const warnings: VerdictItem[] = [];
  const err = (field: string, rule: number, message: string) => errors.push({ field, rule, message });

  if (!off.has(1)) {
    for (const f of ["name", "charter", "type", "success_criteria", "ground_truth_signal", "evaluation_owner"]) {
      if (!nonEmptyStr((spec as Record<string, unknown>)[f])) err(f, 1, `${f} is required and must be a non-empty string`);
    }
  }
  if (!off.has(2) && spec.type !== undefined && !TYPES.includes(spec.type as SpecType)) {
    err("type", 2, `type must be one of ${TYPES.join(", ")}`);
  }
  if (!off.has(3) && (!isObj(spec.metrics) || Object.keys(spec.metrics).length < 1)) {
    err("metrics", 3, "metrics must be a JSON object with at least one metric->target pair");
  }
  if (!off.has(4)) {
    const c = spec.cadence;
    if (!isObj(c) || typeof c.continuous !== "boolean" || !PERIODICS.includes(c.periodic as string)) {
      err("cadence", 4, `cadence needs boolean 'continuous' and 'periodic' in {${PERIODICS.join(",")}}`);
    }
  }
  if (!off.has(5)) {
    const cp = spec.consequence_policy;
    if (!isObj(cp) || typeof cp.auto_tune !== "boolean" || cp.retire_requires_human !== true) {
      err("consequence_policy", 5, "consequence_policy needs boolean auto_tune and retire_requires_human===true");
    }
  }
  if (!off.has(6) && (spec.type === "judgment" || spec.type === "hybrid")) {
    if (spec.inputs_schema == null) err("inputs_schema", 6, "judgment/hybrid units require inputs_schema");
    if (spec.outputs_schema == null) err("outputs_schema", 6, "judgment/hybrid units require outputs_schema");
  }
  if (!off.has(7) && nonEmptyStr(spec.charter)) {
    const ch = (spec.charter as string).trim();
    const hasSuccessNotion = /(so that|before|refuse|ensure|without|test|verify|valid|check|every|each)/i.test(ch);
    if (ch.length < 40 || !hasSuccessNotion) {
      warnings.push({ field: "charter", rule: 7, message: "charter looks vague (want verb + object + a success notion)" });
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

// ── Unit logic: REV-09 CRM-Updater (deterministic write-path) ───────────────────
// Ported from build/gov-kernel/rev/crm.ts.
export const STAGES = ["signal", "qualified", "contacted", "replied", "booked", "proposal", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];

export interface SourceEvent { id: string; deal_id: string; account: string; stage: Stage | string; }
export interface CrmRow { deal_id: string; account: string; stage: Stage; source_event_id: string; }
export interface ApplyResult { accepted: boolean; row?: CrmRow; reason?: string }

export function applyEvent(
  ev: SourceEvent, knownEventIds: Set<string>, opts: { disabledRules?: number[] } = {},
): ApplyResult {
  const off = new Set(opts.disabledRules ?? []);
  if (!off.has(1)) {
    if (!ev.id || !ev.deal_id || !ev.account || !ev.stage)
      return { accepted: false, reason: "schema: missing required field" };
    if (!(STAGES as readonly string[]).includes(ev.stage))
      return { accepted: false, reason: `schema: invalid stage '${ev.stage}'` };
  }
  if (!off.has(2)) {
    if (!knownEventIds.has(ev.id))
      return { accepted: false, reason: "reconcile: orphan update (no source event)" };
  }
  return { accepted: true, row: { deal_id: ev.deal_id, account: ev.account, stage: ev.stage as Stage, source_event_id: ev.id } };
}

export function isSchemaValidRow(row: CrmRow | undefined): boolean {
  return !!row && !!row.deal_id && !!row.account && !!row.source_event_id && (STAGES as readonly string[]).includes(row.stage);
}

// REV-09 golden set (ported from build/gov-kernel/rev/golden-events.ts).
export interface RevCase { key: string; ev: SourceEvent; known: boolean; expectAccept: boolean; note: string; }
export const GOLDEN_EVENTS: RevCase[] = [
  { key: "E1", ev: { id: "ev-001", deal_id: "D-1", account: "Acme AG",       stage: "signal" },     known: true,  expectAccept: true,  note: "valid signal write" },
  { key: "E2", ev: { id: "ev-002", deal_id: "D-1", account: "Acme AG",       stage: "qualified" },  known: true,  expectAccept: true,  note: "valid stage advance" },
  { key: "E3", ev: { id: "ev-003", deal_id: "D-2", account: "Brunnen GmbH",  stage: "contacted" },  known: true,  expectAccept: true,  note: "valid contacted" },
  { key: "E4", ev: { id: "ev-004", deal_id: "D-2", account: "Brunnen GmbH",  stage: "replied" },    known: true,  expectAccept: true,  note: "valid replied" },
  { key: "E5", ev: { id: "ev-005", deal_id: "D-3", account: "Tres Hermanos", stage: "booked" },     known: true,  expectAccept: true,  note: "valid booked" },
  { key: "E6", ev: { id: "ev-006", deal_id: "D-3", account: "Tres Hermanos", stage: "won" },        known: true,  expectAccept: true,  note: "valid won" },
  { key: "E7", ev: { id: "ev-orph", deal_id: "D-9", account: "Ghost SA",     stage: "won" },        known: false, expectAccept: false, note: "ORPHAN: no source event — must be rejected" },
  { key: "E8", ev: { id: "ev-008", deal_id: "D-4", account: "Lago AG",       stage: "negotiating" }, known: true, expectAccept: false, note: "SCHEMA: invalid stage — must be rejected" },
];
export const KNOWN_EVENT_IDS = new Set(GOLDEN_EVENTS.filter((c) => c.known).map((c) => c.ev.id));

// ── Unit logic: REV-10 Pipeline-Forecaster (deterministic formula) ──────────────
// Ported from build/gov-kernel/rev/forecaster.ts + golden-pipeline.ts.
export const CANONICAL_WEIGHTS: Record<Stage, number> = {
  signal: 0.05, qualified: 0.15, contacted: 0.25, replied: 0.40,
  booked: 0.60, proposal: 0.75, won: 1.0, lost: 0.0,
};
export interface Deal { deal_id: string; account: string; stage: Stage; amount_chf: number }
export interface ForecastResult { total_chf: number; perDeal: { deal_id: string; weighted_chf: number }[] }
export function forecast(deals: Deal[], opts: { weightOverride?: Partial<Record<Stage, number>> } = {}): ForecastResult {
  const w = { ...CANONICAL_WEIGHTS, ...(opts.weightOverride ?? {}) };
  const perDeal = deals.map((d) => ({ deal_id: d.deal_id, weighted_chf: Math.round(d.amount_chf * w[d.stage]) }));
  const total_chf = perDeal.reduce((s, d) => s + d.weighted_chf, 0);
  return { total_chf, perDeal };
}
export const GOLDEN_DEALS: Deal[] = [
  { deal_id: "D-1", account: "Acme AG",       stage: "qualified", amount_chf: 10000 },
  { deal_id: "D-2", account: "Brunnen GmbH",  stage: "replied",   amount_chf: 8000 },
  { deal_id: "D-3", account: "Tres Hermanos", stage: "won",       amount_chf: 5000 },
  { deal_id: "D-4", account: "Lago AG",       stage: "proposal",  amount_chf: 20000 },
  { deal_id: "D-5", account: "Nord SA",       stage: "contacted", amount_chf: 4000 },
  { deal_id: "D-6", account: "Süd GmbH",      stage: "lost",      amount_chf: 12000 },
];
export const EXPECTED_PER_DEAL: Record<string, number> = { "D-1": 1500, "D-2": 3200, "D-3": 5000, "D-4": 15000, "D-5": 1000, "D-6": 0 };
export const EXPECTED_TOTAL_CHF = 25700;

// ── Kernel functions (ported from build/gov-kernel/kernel.ts) ───────────────────
export interface CaseResult {
  caseId: string; key: string; passed: boolean; score: number;
  expectValid: boolean; gotValid: boolean; falseAccept: boolean;
}

// GOV-07 Regression-Runner — run GOV-01 against its golden set (from ck_eval.golden_case),
// write one eval_run per case.
export async function gov07RunRegression(
  sql: Sql, specId: string, disabledRules: number[] = [],
): Promise<CaseResult[]> {
  const cases = await sql`
    select id, input, assertions, source from ck_eval.golden_case
    where spec_id = ${specId} and active order by source`;
  const results: CaseResult[] = [];
  for (const c of cases) {
    const expect = c.assertions as { valid: boolean; errorField?: string; hasWarning?: boolean };
    const verdict = validateSpec(c.input, { disabledRules });
    let passed = verdict.valid === expect.valid;
    if (passed && expect.errorField) passed = verdict.errors.some((e) => e.field === expect.errorField);
    if (passed && expect.hasWarning) passed = verdict.warnings.length > 0;
    const falseAccept = expect.valid === false && verdict.valid === true;
    const score = passed ? 1 : 0;
    await sql`insert into ck_eval.eval_run
      (spec_id, mode, case_id, passed, score, evidence, judge, cost_cents)
      values (${specId}, 'regression', ${c.id}, ${passed}, ${score},
        ${sql.json({ verdict, expect, key: c.source } as never)}, 'deterministic', 0)`;
    results.push({ caseId: c.id, key: c.source, passed, score,
      expectValid: expect.valid, gotValid: verdict.valid, falseAccept });
  }
  return results;
}

// GOV-02 Metric-Collector.
export function gov02CollectMetrics(results: CaseResult[]) {
  const volume = results.length;
  const passed = results.filter((r) => r.passed).length;
  const invalid = results.filter((r) => !r.expectValid);
  const falseAccepts = results.filter((r) => r.falseAccept).length;
  const caught = invalid.length - falseAccepts;
  return {
    volume,
    pass_rate: volume ? passed / volume : 0,
    false_accept_rate: invalid.length ? falseAccepts / invalid.length : 0,
    recall_of_invalid: invalid.length ? caught / invalid.length : 1,
  };
}

// GOV-03 Scorecard-Keeper.
export async function gov03WriteScorecard(
  sql: Sql, specId: string, metrics: ReturnType<typeof gov02CollectMetrics>,
  periodStart: Date, periodEnd: Date,
) {
  const quality = metrics.pass_rate;
  const workCents = 0, evalCents = 0;
  const costAdjusted = quality / Math.max(workCents + evalCents, 1);
  const verdict = metrics.false_accept_rate > 0 ? "quarantine" : quality >= 1 ? "keep" : "tune";
  const [row] = await sql`insert into ck_eval.scorecard
    (spec_id, period_start, period_end, metrics, work_cost_cents, eval_cost_cents, cost_adjusted_score, verdict)
    values (${specId}, ${periodStart}, ${periodEnd}, ${sql.json(metrics)}, ${workCents}, ${evalCents},
      ${costAdjusted}, ${verdict})
    returning id, verdict`;
  return { scorecardId: row.id as string, verdict: row.verdict as string, costAdjusted };
}

// GOV-13 Consequence-Router — verdict -> ladder action. retire is NEVER auto-executed.
export async function gov13RouteConsequence(
  sql: Sql, specId: string, verdict: string, autoTune: boolean,
) {
  let trigger: string | null = null, action: string | null = null, humanGate = "n/a";
  if (verdict === "keep") return null;
  if (verdict === "tune") { trigger = "minor_miss"; action = autoTune ? "auto_tune" : "flag"; }
  else if (verdict === "quarantine") { trigger = "drift"; action = "quarantine"; }
  else if (verdict === "retire_proposed") { trigger = "chronic"; action = "retire_proposed"; humanGate = "pending"; }
  const [ev] = await sql`insert into ck_eval.consequence_event
    (spec_id, trigger, action, automatic, human_gate_status, details)
    values (${specId}, ${trigger}, ${action}, ${action !== "retire_proposed"}, ${humanGate},
      ${sql.json({ from_verdict: verdict })})
    returning id, trigger, action, human_gate_status`;
  return ev;
}

// GOV-17 Change-Logger — append to Paperclip's immutable activity_log.
export async function gov17LogAudit(
  sql: Sql, companyId: string, agentId: string,
  action: string, entityType: string, entityId: string, details: Record<string, unknown>,
) {
  await sql`insert into public.activity_log
    (company_id, actor_type, actor_id, action, entity_type, entity_id, agent_id, details)
    values (${companyId}, 'system', 'GOV-17', ${action}, ${entityType}, ${entityId}, ${agentId},
      ${sql.json(details as never)})`;
}

// ── Per-unit orchestration (healthy path) ───────────────────────────────────────
export interface UnitContext { specId: string; companyId: string; agentId: string; }

// Resolve the spec + its Paperclip agent/company (for audit) by spec name.
export async function resolveUnit(sql: Sql, specName: string): Promise<UnitContext | null> {
  const [spec] = await sql`select id, paperclip_agent_id from ck_eval.agent_spec where name = ${specName} limit 1`;
  if (!spec) return null;
  const [agent] = await sql`
    select a.id as agent_id, a.company_id from public.agents a where a.id = ${spec.paperclip_agent_id} limit 1`;
  if (!agent) return null;
  return { specId: spec.id as string, companyId: agent.company_id as string, agentId: agent.agent_id as string };
}

export interface UnitRunResult {
  unit: string; specId: string; scorecardId: string; verdict: string;
  metrics: Record<string, unknown>; consequence: { trigger: string; action: string } | null;
}

// GOV-01 — run-m2 healthy flow.
async function runGov01(sql: Sql, u: UnitContext): Promise<UnitRunResult> {
  const t = Date.now();
  const results = await gov07RunRegression(sql, u.specId, []);
  const metrics = gov02CollectMetrics(results);
  const sc = await gov03WriteScorecard(sql, u.specId, metrics, new Date(t - 3600_000), new Date(t));
  const [spec] = await sql`select consequence_policy from ck_eval.agent_spec where id = ${u.specId}`;
  const autoTune = (spec?.consequence_policy as { auto_tune?: boolean })?.auto_tune ?? true;
  const consequence = await gov13RouteConsequence(sql, u.specId, sc.verdict, autoTune);
  await gov17LogAudit(sql, u.companyId, u.agentId, "governance.scorecard_computed", "scorecard", sc.scorecardId,
    { unit: "GOV-01", scheduled: true, metrics, verdict: sc.verdict });
  if (consequence)
    await gov17LogAudit(sql, u.companyId, u.agentId, "governance.consequence_routed", "consequence_event",
      consequence.id, { trigger: consequence.trigger, action: consequence.action, human_gate: consequence.human_gate_status });
  return { unit: "GOV-01", specId: u.specId, scorecardId: sc.scorecardId, verdict: sc.verdict,
    metrics, consequence: consequence ? { trigger: consequence.trigger, action: consequence.action } : null };
}

// REV-09 — run-rev09 healthy flow.
async function runRev09(sql: Sql, u: UnitContext): Promise<UnitRunResult> {
  const rows: { key: string; accepted: boolean; correct: boolean; orphanPassed: boolean }[] = [];
  for (const c of GOLDEN_EVENTS) {
    const res = applyEvent(c.ev, KNOWN_EVENT_IDS, {});
    const correct = res.accepted === c.expectAccept;
    const orphanPassed = res.accepted && !c.known;
    const schemaBad = res.accepted && !isSchemaValidRow(res.row);
    rows.push({ key: c.key, accepted: res.accepted, correct, orphanPassed });
    await sql`insert into ck_eval.eval_run (spec_id, mode, passed, score, evidence, judge, input_tokens, output_tokens, cost_cents)
      values (${u.specId}, 'regression', ${correct}, ${correct ? 1 : 0},
        ${sql.json({ key: c.key, accepted: res.accepted, expect: c.expectAccept, orphanPassed, schemaBad, reason: res.reason ?? null, note: c.note })},
        'deterministic', 0, 0, 0)`;
  }
  const total = rows.length;
  const accuracy = rows.filter((r) => r.correct).length / total;
  const orphanUpdates = rows.filter((r) => r.orphanPassed).length;
  const accepted = rows.filter((r) => r.accepted).length;
  const schemaValidRate = accepted === 0 ? 1 : rows.filter((r) => r.accepted && !r.orphanPassed).length / accepted;
  const verdict = orphanUpdates > 0 ? "quarantine" : accuracy === 1 ? "keep" : accuracy >= 0.7 ? "tune" : "quarantine";
  const metrics = { accuracy, orphan_updates: orphanUpdates, schema_valid_rate: schemaValidRate, volume: total };
  const [sc] = await sql`insert into ck_eval.scorecard
    (spec_id, period_start, period_end, metrics, work_cost_cents, eval_cost_cents, cost_adjusted_score, verdict)
    values (${u.specId}, now() - interval '2 hours', now() - interval '1 hour',
      ${sql.json(metrics)}, 0, 0, ${accuracy}, ${verdict}) returning id, verdict`;
  const consequence = await gov13RouteConsequence(sql, u.specId, sc.verdict, true);
  await gov17LogAudit(sql, u.companyId, u.agentId, "governance.scorecard_computed", "scorecard", sc.id,
    { unit: "REV-09", scheduled: true, accuracy, orphan_updates: orphanUpdates, verdict: sc.verdict });
  if (consequence)
    await gov17LogAudit(sql, u.companyId, u.agentId, "governance.consequence_routed", "consequence_event", consequence.id,
      { trigger: consequence.trigger, action: consequence.action });
  return { unit: "REV-09", specId: u.specId, scorecardId: sc.id as string, verdict: sc.verdict as string,
    metrics, consequence: consequence ? { trigger: consequence.trigger, action: consequence.action } : null };
}

// REV-10 — run-rev10 healthy flow.
async function runRev10(sql: Sql, u: UnitContext): Promise<UnitRunResult> {
  const res = forecast(GOLDEN_DEALS, {});
  let mismatches = 0;
  for (const d of res.perDeal) {
    const expect = EXPECTED_PER_DEAL[d.deal_id];
    const ok = d.weighted_chf === expect;
    if (!ok) mismatches++;
    await sql`insert into ck_eval.eval_run (spec_id, mode, passed, score, evidence, judge, input_tokens, output_tokens, cost_cents)
      values (${u.specId}, 'regression', ${ok}, ${ok ? 1 : 0},
        ${sql.json({ deal: d.deal_id, got: d.weighted_chf, expect })}, 'deterministic', 0, 0, 0)`;
  }
  const totalOk = res.total_chf === EXPECTED_TOTAL_CHF;
  if (!totalOk) mismatches++;
  await sql`insert into ck_eval.eval_run (spec_id, mode, passed, score, evidence, judge, input_tokens, output_tokens, cost_cents)
    values (${u.specId}, 'regression', ${totalOk}, ${totalOk ? 1 : 0},
      ${sql.json({ check: "total_chf", got: res.total_chf, expect: EXPECTED_TOTAL_CHF })}, 'deterministic', 0, 0, 0)`;
  const reconcile = mismatches === 0;
  const verdict = reconcile ? "keep" : "quarantine";
  const metrics = { reconcile, mismatch: mismatches, total_chf: res.total_chf, expected_total_chf: EXPECTED_TOTAL_CHF };
  const [sc] = await sql`insert into ck_eval.scorecard
    (spec_id, period_start, period_end, metrics, work_cost_cents, eval_cost_cents, cost_adjusted_score, verdict)
    values (${u.specId}, now() - interval '2 hours', now() - interval '1 hour',
      ${sql.json(metrics)}, 0, 0, ${reconcile ? 1 : 0}, ${verdict}) returning id, verdict`;
  const consequence = await gov13RouteConsequence(sql, u.specId, sc.verdict, true);
  await gov17LogAudit(sql, u.companyId, u.agentId, "governance.scorecard_computed", "scorecard", sc.id,
    { unit: "REV-10", scheduled: true, reconcile, mismatch: mismatches, verdict: sc.verdict });
  if (consequence)
    await gov17LogAudit(sql, u.companyId, u.agentId, "governance.consequence_routed", "consequence_event", consequence.id,
      { trigger: consequence.trigger, action: consequence.action });
  return { unit: "REV-10", specId: u.specId, scorecardId: sc.id as string, verdict: sc.verdict as string,
    metrics, consequence: consequence ? { trigger: consequence.trigger, action: consequence.action } : null };
}

// KS-DG Disclosure-Guard — deterministic gate over the divino-sales Hard rules. Graded exactly like
// GOV-01 (rule-definitional golden set in ck_eval.golden_case): a "should-block" case that PASSES is a
// false-accept and quarantines the unit (bad outward text would have slipped the gate).
async function runKsDg(sql: Sql, u: UnitContext): Promise<UnitRunResult> {
  const t = Date.now();
  const cases = await sql`
    select id, input, assertions, source from ck_eval.golden_case
    where spec_id = ${u.specId} and active and kind = 'assertion' order by source`;
  const results: CaseResult[] = [];
  for (const c of cases) {
    const input = c.input as { text: string; ctx?: GuardContext };
    const expect = c.assertions as { pass: boolean; rule?: string };
    const res = guard(input.text ?? "", input.ctx ?? {});
    let passed = res.pass === expect.pass;
    if (passed && expect.rule) passed = res.violations.some((x) => x.rule === expect.rule && x.severity === "block");
    const falseAccept = expect.pass === false && res.pass === true; // should-block text that passed
    const score = passed ? 1 : 0;
    await sql`insert into ck_eval.eval_run
      (spec_id, mode, case_id, passed, score, evidence, judge, cost_cents)
      values (${u.specId}, 'regression', ${c.id}, ${passed}, ${score},
        ${sql.json({ source: c.source, expect, got: { pass: res.pass, violations: res.violations } } as never)}, 'deterministic', 0)`;
    results.push({ caseId: c.id, key: c.source, passed, score, expectValid: expect.pass, gotValid: res.pass, falseAccept });
  }
  const metrics = gov02CollectMetrics(results);
  const sc = await gov03WriteScorecard(sql, u.specId, metrics, new Date(t - 3600_000), new Date(t));
  const [spec] = await sql`select consequence_policy from ck_eval.agent_spec where id = ${u.specId}`;
  const autoTune = (spec?.consequence_policy as { auto_tune?: boolean })?.auto_tune ?? true;
  const consequence = await gov13RouteConsequence(sql, u.specId, sc.verdict, autoTune);
  await gov17LogAudit(sql, u.companyId, u.agentId, "governance.scorecard_computed", "scorecard", sc.scorecardId,
    { unit: "KS-DG", scheduled: true, metrics, verdict: sc.verdict });
  if (consequence)
    await gov17LogAudit(sql, u.companyId, u.agentId, "governance.consequence_routed", "consequence_event",
      consequence.id, { trigger: consequence.trigger, action: consequence.action, human_gate: consequence.human_gate_status });
  return { unit: "KS-DG", specId: u.specId, scorecardId: sc.scorecardId, verdict: sc.verdict,
    metrics, consequence: consequence ? { trigger: consequence.trigger, action: consequence.action } : null };
}

// ── Job entrypoints ─────────────────────────────────────────────────────────────
export interface RegressionReport { ran: UnitRunResult[]; skipped: string[]; }

// `ck.gov-regression` — grade every built/certified unit with a golden set against
// ground truth, write graded eval_runs + a scorecard, route the consequence, audit.
export async function runGovRegression(sql: Sql): Promise<RegressionReport> {
  const ran: UnitRunResult[] = [];
  const skipped: string[] = [];
  const plan: [string, (s: Sql, u: UnitContext) => Promise<UnitRunResult>][] = [
    ["GOV-01 Spec-Registrar", runGov01],
    ["KS-DG Disclosure-Guard", runKsDg],
    ["REV-09 CRM-Updater", runRev09],
    ["REV-10 Pipeline-Forecaster", runRev10],
  ];
  for (const [name, fn] of plan) {
    const u = await resolveUnit(sql, name);
    if (!u) { skipped.push(name); continue; }
    ran.push(await fn(sql, u));
  }
  return { ran, skipped };
}

export interface MetaEvalReport {
  checked: { spec: string; drift: boolean; reason: string | null }[];
  driftEvents: number;
}

// `ck.gov-meta-eval` — GOV-12 Meta-Evaluator. Re-read the latest two scorecards per
// spec; if the verdict changed or the score moved >0.01, flag drift: write a
// consequence_event (trigger 'drift' -> action 'auto_tune') + an audit entry.
export async function runGovMetaEval(sql: Sql): Promise<MetaEvalReport> {
  const specs = await sql`
    select s.id, s.name, s.paperclip_agent_id
    from ck_eval.agent_spec s
    where (select count(*) from ck_eval.scorecard sc where sc.spec_id = s.id) >= 2
    order by s.name`;
  const checked: { spec: string; drift: boolean; reason: string | null }[] = [];
  let driftEvents = 0;
  for (const s of specs) {
    const last2 = await sql`
      select verdict, cost_adjusted_score, metrics, computed_at
      from ck_eval.scorecard where spec_id = ${s.id}
      order by computed_at desc limit 2`;
    if (last2.length < 2) { checked.push({ spec: s.name as string, drift: false, reason: "insufficient history" }); continue; }
    const [latest, prev] = last2;
    const scoreOf = (r: { cost_adjusted_score: unknown; metrics: Record<string, unknown> }): number => {
      const m = (r.metrics ?? {}) as Record<string, unknown>;
      const v = m.accuracy ?? m.pass_rate ?? r.cost_adjusted_score;
      return v == null ? 0 : Number(v);
    };
    const verdictChanged = latest.verdict !== prev.verdict;
    const scoreDelta = Math.abs(scoreOf(latest as never) - scoreOf(prev as never));
    const drift = verdictChanged || scoreDelta > 0.01;
    let reason: string | null = null;
    if (drift) {
      reason = verdictChanged
        ? `verdict ${prev.verdict} -> ${latest.verdict}`
        : `score moved ${scoreDelta.toFixed(3)}`;
      // drift -> auto_tune (NEVER auto-retire). Direct insert to record trigger='drift'.
      const [ev] = await sql`insert into ck_eval.consequence_event
        (spec_id, trigger, action, automatic, human_gate_status, details)
        values (${s.id}, 'drift', 'auto_tune', true, 'n/a', ${sql.json({ meta_eval: true, reason })})
        returning id`;
      driftEvents++;
      const [agent] = await sql`select id, company_id from public.agents where id = ${s.paperclip_agent_id} limit 1`;
      if (agent)
        await gov17LogAudit(sql, agent.company_id as string, agent.id as string,
          "governance.drift_detected", "consequence_event", ev.id as string,
          { unit: s.name, reason, latest_verdict: latest.verdict, prev_verdict: prev.verdict, score_delta: scoreDelta });
    }
    checked.push({ spec: s.name as string, drift, reason });
  }
  return { checked, driftEvents };
}
