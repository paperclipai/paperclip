import { readEvalCostLedger, validEvalLedgerId } from "./cost-ledger.js";
import { usdToUnits } from "../../packages/shared/src/money.js";
import { html, isPublicReportTimestamp } from "./report-format.js";

const money = (n: bigint) => `${n / 1_000_000_000n}.${String(n % 1_000_000_000n).padStart(9, "0")}`;
interface EvalOperationsAvailableReport {
  version: 1;
  scope: "shared_gateway_ledger";
  status?: never;
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
  fields(report, ["version", "scope", "ledgerCampaignId", "journalHash", "records", "deadlineAt", "limitUsd", "knownUsd", "heldUsd", "committedUsd", "requests", "unresolvedRequests", "boundedUnresolvedRequests", "conflictingRequests", "inflight", "breakdown", "attempts"]);
  if (report.version !== 1 || report.scope !== "shared_gateway_ledger" || !validEvalLedgerId(report.ledgerCampaignId)
      || !/^[a-f0-9]{64}$/.test(report.journalHash) || !isPublicReportTimestamp(report.deadlineAt) || !Array.isArray(report.attempts)) fail();
  [report.records, report.requests, report.unresolvedRequests, report.conflictingRequests, report.inflight].forEach(count);
  if (report.records < 1 || report.unresolvedRequests > report.requests || report.conflictingRequests > report.unresolvedRequests || report.inflight > report.requests) fail();
  if (report.boundedUnresolvedRequests !== undefined) {
    count(report.boundedUnresolvedRequests);
    if (report.boundedUnresolvedRequests > report.unresolvedRequests - report.conflictingRequests) fail();
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
  const report: EvalOperationsAvailableReport = { version: 1, scope: "shared_gateway_ledger", ledgerCampaignId: snapshot.campaignId,
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

export function operationsReportText(report: EvalOperationsReport): string[] {
  if (report.status === "unavailable") return [
    "Request ledger accounting unavailable: the journal could not be read or validated. Request amounts, counts, and held reservations are unknown.",
    "Retained test results are preserved. Recover and validate the original journal before resuming paid work; do not reset the allowance or treat missing amounts as zero.",
  ];
  return [
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
