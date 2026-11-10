import { readEvalCostLedger, validEvalLedgerId } from "./cost-ledger.js";
import { usdToUnits } from "../../packages/shared/src/money.js";
import { html, isPublicReportTimestamp } from "./report-format.js";

const money = (n: bigint) => `${n / 1_000_000_000n}.${String(n % 1_000_000_000n).padStart(9, "0")}`;
interface ModelTokenTotals { input: number; cachedRead: number; cachedWrite: number; output: number; reasoning: number }
interface ModelTokenUsage { requests: number; conflictingRequests: number; totals: ModelTokenTotals; setup: { requests: number; totals: ModelTokenTotals } }
const tokenFields = ["input", "cachedRead", "cachedWrite", "output", "reasoning"] as const;
const emptyTokenTotals = (): ModelTokenTotals => ({ input: 0, cachedRead: 0, cachedWrite: 0, output: 0, reasoning: 0 });

interface EvalOperationsAvailableReport {
  version: 1;
  scope: "shared_gateway_ledger";
  status?: never;
  accountingReadiness?: "model_requests";
  modelAccounting?: { requests: number; unresolvedRequests: number; conflictingRequests: number; inflight: number; knownUsd: string; heldUsd: string; tokenUsage?: ModelTokenUsage };
  ledgerCampaignId: string;
  journalHash: string;
  records: number;
  deadlineAt: string;
  limitUsd: string;
  knownUsd: string;
  heldUsd: string;
  committedUsd: string;
  requests: number;
  unresolvedRequests: number;
  boundedUnresolvedRequests?: number;
  conflictingRequests: number;
  inflight: number;
  breakdown: { reported: string; estimated: string; allocated: string; reconciled: string };
  attempts: Array<{ executionId: string; attemptId: string; requests: number; unresolvedRequests: number; knownUsd: string; heldUsd: string }>;
}
export type EvalOperationsReport = EvalOperationsAvailableReport | {
  version: 1; scope: "shared_gateway_ledger"; status: "unavailable";
};

export function validateEvalOperationsReport(report: EvalOperationsReport): void {
  const fail = (): never => { throw new Error("Invalid retained eval operations report"); };
  const fields = (value: unknown, allowed: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail();
  };
  if (report?.status === "unavailable") {
    fields(report, ["version", "scope", "status"]);
    if (report.version !== 1 || report.scope !== "shared_gateway_ledger") fail();
    return;
  }
  const dollars = (value: unknown): bigint => typeof value === "string" && /^(?:0|[1-9][0-9]*)\.[0-9]{9}$/.test(value) ? usdToUnits(value) : fail();
  const count = (value: unknown) => { if (!Number.isSafeInteger(value) || Number(value) < 0) fail(); };
  fields(report, ["version", "scope", "accountingReadiness", "modelAccounting", "ledgerCampaignId", "journalHash", "records", "deadlineAt", "limitUsd", "knownUsd", "heldUsd", "committedUsd", "requests", "unresolvedRequests", "boundedUnresolvedRequests", "conflictingRequests", "inflight", "breakdown", "attempts"]);
  if (report.version !== 1 || report.scope !== "shared_gateway_ledger" || !validEvalLedgerId(report.ledgerCampaignId)
      || !/^[a-f0-9]{64}$/.test(report.journalHash) || !isPublicReportTimestamp(report.deadlineAt) || !Array.isArray(report.attempts)) fail();
  [report.records, report.requests, report.unresolvedRequests, report.conflictingRequests, report.inflight].forEach(count);
  if (report.records < 1 || report.unresolvedRequests > report.requests || report.conflictingRequests > report.unresolvedRequests || report.inflight > report.requests) fail();
  if (report.boundedUnresolvedRequests !== undefined) {
    count(report.boundedUnresolvedRequests);
    if (report.boundedUnresolvedRequests > report.unresolvedRequests - report.conflictingRequests) fail();
  }
  if (report.accountingReadiness !== undefined && (report.accountingReadiness !== "model_requests" || !report.modelAccounting)) fail();
  if (report.modelAccounting !== undefined) {
    const model = report.modelAccounting;
    fields(model, ["requests", "unresolvedRequests", "conflictingRequests", "inflight", "knownUsd", "heldUsd", "tokenUsage"]);
    if (model.tokenUsage !== undefined) {
      const usage = model.tokenUsage;
      fields(usage, ["requests", "conflictingRequests", "totals", "setup"]);
      fields(usage.setup, ["requests", "totals"]);
      [usage.requests, usage.conflictingRequests, usage.setup.requests].forEach(count);
      if (usage.requests + usage.conflictingRequests > model.requests || usage.setup.requests > usage.requests) fail();
      for (const [requests, totals] of [[usage.requests, usage.totals], [usage.setup.requests, usage.setup.totals]] as const) {
        fields(totals, [...tokenFields]);
        tokenFields.forEach(key => count(totals[key]));
        if (totals.reasoning > totals.output || requests === 0 && tokenFields.some(key => totals[key] !== 0)) fail();
      }
      if (tokenFields.some(key => usage.setup.totals[key] > usage.totals[key])) fail();
    }
    [model.requests, model.unresolvedRequests, model.conflictingRequests, model.inflight].forEach(count);
    if (model.requests > report.requests || model.unresolvedRequests > model.requests || model.unresolvedRequests > report.unresolvedRequests
        || model.conflictingRequests > model.unresolvedRequests || model.conflictingRequests > report.conflictingRequests
        || model.inflight > model.requests || model.inflight > report.inflight
        || dollars(model.knownUsd) > dollars(report.knownUsd) || dollars(model.heldUsd) > dollars(report.heldUsd)) fail();
  }
  dollars(report.limitUsd);
  const known = dollars(report.knownUsd), held = dollars(report.heldUsd);
  if (known + held !== dollars(report.committedUsd)) fail();
  fields(report.breakdown, ["reported", "estimated", "allocated", "reconciled"]);
  if (["reported", "estimated", "allocated", "reconciled"].reduce((sum, key) => sum + dollars(report.breakdown[key as keyof typeof report.breakdown]), 0n) !== known) fail();
  let requests = 0, unresolved = 0, rowKnown = 0n, rowHeld = 0n;
  const seen = new Set<string>();
  for (const attempt of report.attempts) {
    fields(attempt, ["executionId", "attemptId", "requests", "unresolvedRequests", "knownUsd", "heldUsd"]);
    if (!validEvalLedgerId(attempt.executionId) || !validEvalLedgerId(attempt.attemptId)) fail();
    const key = JSON.stringify([attempt.executionId, attempt.attemptId]); if (seen.has(key)) fail(); seen.add(key);
    count(attempt.requests); count(attempt.unresolvedRequests);
    if (attempt.requests < 1 || attempt.unresolvedRequests > attempt.requests) fail();
    requests += attempt.requests; unresolved += attempt.unresolvedRequests;
    rowKnown += dollars(attempt.knownUsd); rowHeld += dollars(attempt.heldUsd);
  }
  if (requests !== report.requests || unresolved !== report.unresolvedRequests || rowKnown !== known || rowHeld !== held) fail();
}

export async function readEvalOperationsReport(file: string): Promise<EvalOperationsReport> {
  try { return await readAvailableEvalOperationsReport(file); }
  catch { return { version: 1, scope: "shared_gateway_ledger", status: "unavailable" }; }
}

async function readAvailableEvalOperationsReport(file: string): Promise<EvalOperationsAvailableReport> {
  const loaded = await readEvalCostLedger(file), snapshot = loaded.state.snapshot();
  const groups = new Map<string, EvalOperationsAvailableReport["attempts"][number]>();
  for (const request of snapshot.requests) {
    const key = JSON.stringify([request.executionId, request.attemptId]);
    const group = groups.get(key) ?? { executionId: request.executionId, attemptId: request.attemptId,
      requests: 0, unresolvedRequests: 0, knownUsd: money(0n), heldUsd: money(0n) };
    const cost = usdToUnits(request.costUsd ?? "0"), reserved = usdToUnits(request.reservedUsd);
    const held = (!request.finished || !request.receiptComplete) && reserved > cost ? reserved - cost : 0n;
    group.requests++; if (!request.receiptComplete) group.unresolvedRequests++;
    group.knownUsd = money(usdToUnits(group.knownUsd) + cost);
    group.heldUsd = money(usdToUnits(group.heldUsd) + held);
    groups.set(key, group);
  }
  const modelRequests = snapshot.requests.filter(request => request.phase !== "infrastructure");
  const modelKnown = modelRequests.reduce((sum, request) => sum + usdToUnits(request.costUsd ?? "0"), 0n);
  const modelHeld = modelRequests.reduce((sum, request) => {
    const cost = usdToUnits(request.costUsd ?? "0"), reserved = usdToUnits(request.reservedUsd);
    return sum + ((!request.finished || !request.receiptComplete) && reserved > cost ? reserved - cost : 0n);
  }, 0n);
  const tokenUsage: ModelTokenUsage = { requests: 0, conflictingRequests: 0, totals: emptyTokenTotals(), setup: { requests: 0, totals: emptyTokenTotals() } };
  for (const request of loaded.state.requests.values()) {
    if (request.identity.phase === "infrastructure") continue;
    const candidates = request.observations.filter(observation => observation.final && observation.tokens
      && ["gateway", "provider"].includes(observation.source));
    const values = tokenFields.map(key => new Set(candidates.flatMap(observation => observation.tokens![key] === undefined ? [] : [observation.tokens![key]!] )));
    const complete = candidates.find(observation => ["input", "cachedRead", "cachedWrite", "output"].every(key => observation.tokens![key as keyof ModelTokenTotals] !== undefined));
    if (values.some(value => value.size > 1) || complete && candidates.some(observation => (observation.tokens!.reasoning ?? 0) > complete.tokens!.output!)) { tokenUsage.conflictingRequests++; continue; }
    if (!complete) continue;
    const tokens = Object.fromEntries(tokenFields.map(key => [key, complete.tokens![key] ?? 0])) as unknown as ModelTokenTotals;
    tokens.reasoning = candidates.find(observation => observation.tokens!.reasoning !== undefined)?.tokens?.reasoning ?? 0;
    tokenUsage.requests++;
    if (request.identity.phase === "setup") tokenUsage.setup.requests++;
    for (const key of tokenFields) {
      tokenUsage.totals[key] += tokens[key];
      if (request.identity.phase === "setup") tokenUsage.setup.totals[key] += tokens[key];
    }
  }
  const report: EvalOperationsAvailableReport = { version: 1, scope: "shared_gateway_ledger", ledgerCampaignId: snapshot.campaignId,
    ...(loaded.state.limits.overhead?.accountingReadiness ? { accountingReadiness: loaded.state.limits.overhead.accountingReadiness } : {}),
    modelAccounting: { requests: modelRequests.length, unresolvedRequests: modelRequests.filter(request => !request.receiptComplete).length,
      conflictingRequests: modelRequests.filter(request => request.conflict).length, inflight: modelRequests.filter(request => !request.finished).length,
      knownUsd: money(modelKnown), heldUsd: money(modelHeld), tokenUsage },
    journalHash: loaded.previous, records: loaded.sequence, deadlineAt: new Date(loaded.state.limits.deadlineAt).toISOString(),
    limitUsd: snapshot.limitUsd, knownUsd: snapshot.knownUsd, heldUsd: snapshot.heldUsd, committedUsd: snapshot.committedUsd,
    requests: snapshot.requests.length, unresolvedRequests: snapshot.unknownRequests, boundedUnresolvedRequests: snapshot.boundedUnresolvedRequests, conflictingRequests: snapshot.conflictingRequests,
    inflight: snapshot.inflight, breakdown: snapshot.breakdown as EvalOperationsAvailableReport["breakdown"], attempts: [...groups.values()] };
  validateEvalOperationsReport(report);
  return report;
}

export function evalAccountingStatus(report: EvalOperationsReport): "unavailable" | "blocked" | "provisional" | "receipts_complete" {
  validateEvalOperationsReport(report);
  if (report.status === "unavailable") return "unavailable";
  if (report.conflictingRequests || report.inflight || usdToUnits(report.committedUsd) > usdToUnits(report.limitUsd)
      || report.unresolvedRequests !== (report.boundedUnresolvedRequests ?? 0)) return "blocked";
  return report.unresolvedRequests ? "provisional" : "receipts_complete";
}

export function evalReadinessStatus(report: EvalOperationsReport): ReturnType<typeof evalAccountingStatus> {
  const full = evalAccountingStatus(report);
  if (report.status === "unavailable" || report.accountingReadiness !== "model_requests") return full;
  const model = report.modelAccounting!;
  if (!model.requests || model.unresolvedRequests || model.inflight || report.conflictingRequests || report.inflight
      || usdToUnits(report.committedUsd) > usdToUnits(report.limitUsd)) return "blocked";
  return "receipts_complete";
}

export function operationsReportText(report: EvalOperationsReport): string[] {
  if (report.status === "unavailable") return [
    "Request ledger accounting unavailable: the journal could not be read or validated. Request amounts, counts, and held reservations are unknown.",
    "Retained test results are preserved. Recover and validate the original journal before resuming paid work; do not reset the allowance or treat missing amounts as zero.",
  ];
  return [
    ...(report.modelAccounting ? [`Model requests: ${report.modelAccounting.requests}; $${report.modelAccounting.knownUsd} known token cost; $${report.modelAccounting.heldUsd} additional held; ${report.modelAccounting.unresolvedRequests} unresolved.`] : []),
    ...(report.modelAccounting?.tokenUsage ? (() => {
      const model = report.modelAccounting!, usage = model.tokenUsage!, total = usage.totals, setup = usage.setup.totals;
      return [`Ledger token usage: ${usage.requests}/${model.requests} model requests have unambiguous final usage; ${usage.conflictingRequests} conflicting; ${model.requests - usage.requests - usage.conflictingRequests} missing. Totals: ${total.input} uncached input / ${total.cachedRead} cache-read input / ${total.cachedWrite} cache-write input / ${total.output} output. Reported reasoning: ${total.reasoning}, included in output.`,
        `Setup token usage (${usage.setup.requests} requests, included above): ${setup.input} uncached input / ${setup.cachedRead} cache-read input / ${setup.cachedWrite} cache-write input / ${setup.output} output. Completed, failed and canceled requests are included once; token coverage is separate from invoice reconciliation.`];
    })() : []),
    ...(report.accountingReadiness === "model_requests" ? [`Readiness scope: model requests; status: ${evalReadinessStatus(report)}. Operating costs remain separately unreconciled unless final receipts establish otherwise. Their reservations remain inside campaign admission; this does not establish a full-lifecycle operating-cost bound.`] : []),
    `Accounting status: ${evalAccountingStatus(report)}. ${report.boundedUnresolvedRequests ?? 0} pending charges have reviewed bounds; ${report.unresolvedRequests - (report.boundedUnresolvedRequests ?? 0)} do not. Provisional completion preserves holds and requires later reconciliation; it does not establish invoice completeness.`,
    `Shared request ledger ${report.ledgerCampaignId}: $${report.knownUsd} known subtotal; $${report.heldUsd} additional held reservations; $${report.committedUsd} committed against $${report.limitUsd}.`,
    `Charges: $${report.breakdown.reconciled} reconciled; $${report.breakdown.reported} reported; $${report.breakdown.estimated} estimated; $${report.breakdown.allocated} allocated.`,
    `${report.requests} recorded requests or overhead reservations; ${report.unresolvedRequests} unresolved; ${report.conflictingRequests} conflicting; ${report.inflight} in flight. Deadline ${report.deadlineAt}.`,
    "This shared ledger includes earlier attempts and setup probes routed through the gateway, plus any declared campaign-overhead reservations. Do not add its model subtotal to heartbeat totals. Held reservations are not charges. Unrecorded infrastructure, storage, subscriptions and requests outside the gateway still need accounting; zero recorded requests does not prove zero cost.",
    `Journal checkpoint: ${report.records} records; SHA-256 ${report.journalHash}.`,
  ];
}

export function renderEvalOperationsReport(report: EvalOperationsReport): string {
  validateEvalOperationsReport(report);
  if (report.status === "unavailable") return `<section aria-label="Request ledger accounting"><h2>Request ledger accounting unavailable</h2>${operationsReportText(report).map(line => `<p>${html(line)}</p>`).join("")}</section>`;
  return `<section aria-label="Request ledger accounting"><h2>Request ledger accounting</h2>${operationsReportText(report).map(line => `<p>${html(line)}</p>`).join("")}
    <table><thead><tr><th>Execution</th><th>Attempt or component</th><th>Requests / reservations</th><th>Known subtotal</th><th>Additional held</th><th>Unresolved</th></tr></thead><tbody>
    ${report.attempts.map(attempt => `<tr><td>${html(attempt.executionId)}</td><td>${html(attempt.attemptId)}</td><td>${attempt.requests}</td><td>$${html(attempt.knownUsd)}</td><td>$${html(attempt.heldUsd)}</td><td>${attempt.unresolvedRequests}</td></tr>`).join("")}
    </tbody></table></section>`;
}
