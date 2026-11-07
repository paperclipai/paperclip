import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openEvalCostLedger, type EvalSpendLimits } from "./cost-ledger.js";
import { costBoundConfigurationSha256, reservationBound, type EvalCostBoundEvidence } from "./cost-bound-evidence.js";
import { EVAL_OVERHEAD_COMPONENTS } from "./operating-overhead.js";
import { evalAccountingStatus, readEvalOperationsReport, renderEvalOperationsReport, validateEvalOperationsReport } from "./operations-report.js";
import { scheduledCampaignFindings } from "./scheduled-finalization.js";
import type { RunnerE2ECampaign } from "./types.js";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const evidence: EvalCostBoundEvidence = { version: 1, scope: "full_lifecycle", evidenceSha256: "a".repeat(64), configurationSha256: costBoundConfigurationSha256({ fixture: true }) };
const identity = { executionId: "cell", attemptId: "one", phase: "agent" as const };
const bound = reservationBound("model_limits", evidence, { fixture: true });
async function fixture(overhead = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "provisional-accounting-")); directories.push(dir);
  const file = path.join(dir, "ledger.jsonl");
  const limits: EvalSpendLimits = { campaignId: "fixture", maxUsd: "20", maxRequests: 20, maxConcurrent: 2,
    deadlineAt: "2099-01-01T00:00:00Z", maxAttemptsPerExecution: 1,
    ...(overhead ? { overhead: { version: 1 as const, reference: "fixture-audit", runner: "github-hosted" as const,
      verifiedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      components: EVAL_OVERHEAD_COMPONENTS.map(component => ({ component, maxUsd: component === "shared_subscription" ? "0" : "1",
        reference: `fixture-${component}`, provisionalBound: evidence })) } } : {}) };
  if (limits.overhead) for (const component of limits.overhead.components) {
    component.provisionalBound = { ...evidence, configurationSha256: costBoundConfigurationSha256({
      reference: limits.overhead.reference, runner: limits.overhead.runner, verifiedAt: limits.overhead.verifiedAt, expiresAt: limits.overhead.expiresAt,
      component: { component: component.component, maxUsd: component.maxUsd, reference: component.reference },
    }) };
  }
  const ledger = await openEvalCostLedger(file, limits);
  await ledger.admitAttempt(identity.executionId, identity.attemptId);
  return { ledger, file, limits };
}
function accountingFindings(operations: Awaited<ReturnType<typeof readEvalOperationsReport>>) {
  return scheduledCampaignFindings({ results: [], expected: [], operations } as unknown as RunnerE2ECampaign)
    .filter(finding => finding.startsWith("accounting_"));
}

it("allows reviewed pending operating/model costs without changing holds or finality, including after restart", async () => {
  const { ledger, file, limits } = await fixture(true);
  await ledger.reserve("request", identity, "2", bound);
  await ledger.observe({ observationId: "partial", requestId: "request", source: "provider", provider: "fixture", currency: "USD",
    route: "direct", classification: "estimated", pricingVersion: "fixture", costUsd: "0.1", final: false });
  await ledger.finish("request", "cancelled");
  await ledger.close();
  const original = await readFile(file, "utf8");
  const report = await readEvalOperationsReport(file);
  expect(report).toMatchObject({ unresolvedRequests: 5, boundedUnresolvedRequests: 5, knownUsd: "0.100000000", heldUsd: "4.900000000", committedUsd: "5.000000000" });
  expect(evalAccountingStatus(report)).toBe("provisional");
  expect(accountingFindings(report)).toEqual([]);
  const rendered = renderEvalOperationsReport(report);
  expect(rendered).toContain("Accounting status: provisional");
  expect(rendered).toContain("requires later reconciliation");
  expect(rendered).not.toContain(evidence.evidenceSha256);
  const resumed = await openEvalCostLedger(file, limits);
  try { expect(resumed.snapshot()).toMatchObject({ boundedUnresolvedRequests: 5, heldUsd: "4.900000000" }); }
  finally { await resumed.close(); }
  expect(await readFile(file, "utf8")).toBe(original);
});

it("keeps legacy reservations and legacy reports unqualified instead of inferring a bound from dollars", async () => {
  const { ledger, file } = await fixture();
  try {
    await ledger.reserve("request", identity, "2");
    await ledger.finish("request", "cancelled");
    const report = await readEvalOperationsReport(file);
    expect(evalAccountingStatus(report)).toBe("blocked");
    expect(accountingFindings(report)).toEqual(["accounting_incomplete"]);
    if (report.status === "unavailable") throw new Error("Missing fixture report");
    delete report.boundedUnresolvedRequests;
    validateEvalOperationsReport(report);
    expect(evalAccountingStatus(report)).toBe("blocked");
    expect(() => validateEvalOperationsReport({ ...report, boundedUnresolvedRequests: 2 })).toThrow();
  } finally { await ledger.close(); }
});

it.each(["inflight", "invalidated", "partial-over-bound", "conflict", "over-budget"])("blocks %s even with reviewed bound evidence", async reason => {
  const { ledger, file } = await fixture();
  try {
    await ledger.reserve("request", identity, "2", bound);
    if (reason === "invalidated") await ledger.invalidateBound("request");
    if (reason !== "inflight") await ledger.finish("request", "cancelled");
    if (["partial-over-bound", "conflict", "over-budget"].includes(reason)) {
      await ledger.observe({ observationId: "first", requestId: "request", source: "provider", provider: "fixture", currency: "USD", route: "direct",
        classification: "reported", costUsd: reason === "over-budget" ? "21" : "3", final: reason !== "partial-over-bound" });
    }
    if (reason === "conflict") await ledger.observe({ observationId: "second", requestId: "request", source: "provider", provider: "fixture",
      currency: "USD", route: "direct", classification: "reported", costUsd: "4", final: true });
    const report = await readEvalOperationsReport(file);
    expect(evalAccountingStatus(report)).toBe("blocked");
    expect(accountingFindings(report)).toContain("accounting_incomplete");
    if (reason === "over-budget") expect(accountingFindings(report)).toContain("accounting_over_budget");
    expect(report).toMatchObject({ boundedUnresolvedRequests: 0 });
  } finally { await ledger.close(); }
});

it("lets a later complete receipt settle the original reservation without treating the provisional hold as a charge", async () => {
  const { ledger, file } = await fixture();
  try {
    await ledger.reserve("request", identity, "2", bound);
    await ledger.finish("request", "cancelled");
    expect(evalAccountingStatus(await readEvalOperationsReport(file))).toBe("provisional");
    await ledger.observe({ observationId: "invoice", requestId: "request", source: "invoice", provider: "fixture", currency: "USD",
      route: "direct", classification: "reconciled", costUsd: "0.2", final: true });
    const report = await readEvalOperationsReport(file);
    expect(evalAccountingStatus(report)).toBe("receipts_complete");
    expect(report).toMatchObject({ boundedUnresolvedRequests: 0, knownUsd: "0.200000000", heldUsd: "0.000000000" });
  } finally { await ledger.close(); }
});

it("rejects malformed or mismatched evidence before creating a reservation", async () => {
  const { ledger } = await fixture();
  try {
    for (const invalid of [ { ...bound, calculationSha256: "missing" }, { ...bound, basis: "operating_allowance" },
      { ...bound, evidence: { ...evidence, scope: "current_day" } }, { ...bound, evidence: { ...evidence, evidenceSha256: "bad" } },
      { ...bound, evidence: { ...evidence, privateField: "not-allowed" } } ]) {
      await expect(ledger.reserve("request", identity, "2", invalid as never)).rejects.toThrow();
    }
    expect(ledger.snapshot().requests).toHaveLength(0);
  } finally { await ledger.close(); }
});

it("does not accept null as reviewed operating-bound evidence", async () => {
  const { ledger, limits } = await fixture(true);
  await ledger.close();
  limits.overhead!.components[0]!.provisionalBound = null as never;
  const directory = await mkdtemp(path.join(tmpdir(), "provisional-malformed-")); directories.push(directory);
  await expect(openEvalCostLedger(path.join(directory, "ledger.jsonl"), limits)).rejects.toThrow("Invalid reviewed cost bound evidence");
});
