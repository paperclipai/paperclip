import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { EvalSpendState, openEvalCostLedger, readEvalCostLedger, type EvalSpendLimits } from "./cost-ledger.js";
import { EVAL_OVERHEAD_COMPONENTS, operatingReservationBound, scheduledOperatingOverhead, validateOperatingOverhead, type EvalOperatingOverhead } from "./operating-overhead.js";
import { evalAccountingStatus, evalReadinessStatus, readEvalOperationsReport, renderEvalOperationsReport } from "./operations-report.js";

import { costBoundConfigurationSha256 } from "./cost-bound-evidence.js";

const now = Date.parse("2026-10-21T00:00:00Z");
const allowance = (): EvalOperatingOverhead => ({ version: 1, reference: "fixture-only", runner: "aws-fleet",
  verifiedAt: "2026-10-20T00:00:00Z", expiresAt: "2026-11-19T00:00:00Z",
  components: EVAL_OVERHEAD_COMPONENTS.map(component => ({ component, maxUsd: "1", reference: `fixture-${component}` })) });
const currentAllowance = (time = Date.now()): EvalOperatingOverhead => ({ ...allowance(),
  verifiedAt: new Date(time - 86_400_000).toISOString(), expiresAt: new Date(time + 30 * 86_400_000).toISOString() });
const runner = "ubuntu-latest";
const modelIdentity = { executionId: "claude.local.fixture", attemptId: "attempt-1", phase: "agent" as const };

it.each(["aws-fleet", "local"] as const)("keeps %s overhead inside the same cap through model completion and a journal restart", async runnerKind => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-overhead-"));
  const file = path.join(directory, "ledger.jsonl");
  const limits: EvalSpendLimits = { campaignId: "fixture", maxUsd: "20", deadlineAt: "2099-01-01T00:00:00Z",
    maxRequests: 10, maxConcurrent: 1, maxAttemptsPerExecution: 1, overhead: { ...currentAllowance(), runner: runnerKind } };
  try {
    const ledger = await openEvalCostLedger(file, limits);
    try {
      expect((await readEvalCostLedger(file)).state.snapshot()).toMatchObject({ knownUsd: "0.000000000", heldUsd: "4.000000000", inflight: 0, unknownRequests: 4 });
      await ledger.admitAttempt(modelIdentity.executionId, modelIdentity.attemptId);
      await expect(ledger.reserve("too-large", modelIdentity, "17")).rejects.toThrow("spending cap");
      await ledger.reserve("model", modelIdentity, "16");
      await ledger.observe({ observationId: "model-receipt", requestId: "model", source: "provider", provider: "anthropic",
        currency: "USD", route: "direct", classification: "reported", costUsd: "1", final: true });
      await ledger.finish("model", "succeeded");
      expect(ledger.snapshot()).toMatchObject({ knownUsd: "1.000000000", heldUsd: "4.000000000", committedUsd: "5.000000000" });
    } finally { await ledger.close(); }
    const changed = structuredClone(limits); changed.overhead!.components[0]!.maxUsd = "0";
    await expect(openEvalCostLedger(file, changed)).rejects.toThrow("limits changed");
    const resumed = await openEvalCostLedger(file, limits);
    try {
      await resumed.finish("overhead:ci_compute", "cancelled");
      expect(resumed.snapshot().heldUsd).toBe("4.000000000");
      await resumed.observe({ observationId: "ci-partial", requestId: "overhead:ci_compute", source: "infrastructure", provider: "aws",
        currency: "USD", route: "infrastructure", classification: "estimated", pricingVersion: "fixture", costUsd: "0.2", final: false });
      expect(resumed.snapshot()).toMatchObject({ knownUsd: "1.200000000", heldUsd: "3.800000000", committedUsd: "5.000000000", unknownRequests: 4 });
      await resumed.observe({ observationId: "ci-invoice", requestId: "overhead:ci_compute", source: "invoice", provider: "aws",
        currency: "USD", route: "infrastructure", classification: "reconciled", costUsd: "0.5", final: true });
      expect(resumed.snapshot()).toMatchObject({ knownUsd: "1.500000000", heldUsd: "3.000000000", committedUsd: "4.500000000", unknownRequests: 3 });
    } finally { await resumed.close(); }
    const report = await readEvalOperationsReport(file);
    expect(report).toMatchObject({ requests: 5, unresolvedRequests: 3, knownUsd: "1.500000000", heldUsd: "3.000000000" });
    expect(renderEvalOperationsReport(report)).toContain("campaign-overhead");
    expect(renderEvalOperationsReport(report)).toContain("Held reservations are not charges");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("stops further model admission when a later infrastructure receipt exceeds the shared cap", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-overhead-overrun-"));
  try {
    const ledger = await openEvalCostLedger(path.join(directory, "ledger.jsonl"), { campaignId: "overrun", maxUsd: "20",
      deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 10, maxConcurrent: 1, maxAttemptsPerExecution: 1, overhead: currentAllowance() });
    try {
      await ledger.admitAttempt(modelIdentity.executionId, modelIdentity.attemptId);
      await ledger.observe({ observationId: "late-invoice", requestId: "overhead:ci_compute", source: "invoice", provider: "aws",
        currency: "USD", route: "infrastructure", classification: "reconciled", costUsd: "21", final: true });
      expect(ledger.snapshot()).toMatchObject({ overBudget: true, committedUsd: "24.000000000" });
      await expect(ledger.reserve("next", modelIdentity, "0.1")).rejects.toThrow("spending cap");
    } finally { await ledger.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("requires each cost category once and rejects unknown policy fields or missing provenance", () => {
  expect(validateOperatingOverhead(allowance(), "20")).toBe(4_000_000_000n);
  expect(() => validateOperatingOverhead({ ...allowance(), components: allowance().components.slice(1) }, "20")).toThrow("Incomplete");
  const duplicate = allowance(); duplicate.components[0] = duplicate.components[1]!;
  expect(() => validateOperatingOverhead(duplicate, "20")).toThrow("component");
  expect(() => validateOperatingOverhead({ ...allowance(), apiKey: "never-allowed" } as never, "20")).toThrow("fields");
  const missing = allowance(); missing.components[0]!.reference = "";
  expect(() => validateOperatingOverhead(missing, "20")).toThrow("component");
  expect(() => validateOperatingOverhead(null as never, "20")).toThrow("fields");
  expect(() => validateOperatingOverhead({ ...allowance(), expiresAt: "2027-10-20T00:00:00Z" }, "20")).toThrow("Incomplete");
  expect(() => validateOperatingOverhead(allowance(), "4")).toThrow("no model allowance");
});

it("requires fresh reviewed allowances tied to the actual CI runner before scheduled work", () => {
  const hosted = { ...allowance(), runner: "github-hosted" as const };
  const raw = JSON.stringify(hosted);
  expect(scheduledOperatingOverhead(raw, runner, "20", now)).toEqual(hosted);
  expect(() => scheduledOperatingOverhead(undefined, runner, "20", now)).toThrow("Missing reviewed");
  expect(() => scheduledOperatingOverhead("not json", runner, "20", now)).toThrow("JSON");
  expect(() => scheduledOperatingOverhead(JSON.stringify(allowance()), runner, "20", now)).toThrow("runner");
  expect(() => scheduledOperatingOverhead(JSON.stringify({ ...hosted, runner: "local" }), runner, "20", now)).toThrow("runner");
  expect(() => scheduledOperatingOverhead(raw, "runs-on/fleet=paperclip-public-pr-x64/env=public-ci", "20", now)).toThrow("runner");
  expect(() => scheduledOperatingOverhead(raw, "unrecognized", "20", now)).toThrow("runner");
  expect(() => scheduledOperatingOverhead(raw, runner, "20", Date.parse("2026-10-19T23:59:59Z"))).toThrow("needs review");
  expect(() => scheduledOperatingOverhead(raw, runner, "20", Date.parse("2026-11-18T20:00:00Z"))).toThrow("needs review");
});

it("does not turn a zero allowance into an observed zero charge", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-overhead-zero-"));
  const overhead = allowance(); overhead.components[0]!.maxUsd = "0";
  try {
    const ledger = await openEvalCostLedger(path.join(directory, "ledger.jsonl"), { campaignId: "zero", maxUsd: "20",
      deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 10, maxConcurrent: 1, maxAttemptsPerExecution: 1, overhead });
    try {
      expect(ledger.snapshot().requests.find(row => row.requestId === "overhead:ci_compute"))
        .toMatchObject({ costUsd: null, classification: "unknown", receiptComplete: false, reservedUsd: "0.000000000" });
    } finally { await ledger.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("stops new admission after allowance expiry while preserving late invoice reconciliation", () => {
  const state = new EvalSpendState({ campaignId: "expired", maxUsd: "20", deadlineAt: "2099-01-01T00:00:00Z",
    maxRequests: 10, maxConcurrent: 1, maxAttemptsPerExecution: 1, overhead: allowance() });
  const admitted = { type: "attempt" as const, executionId: modelIdentity.executionId, attemptId: modelIdentity.attemptId };
  state.validate(admitted, now); state.apply(admitted);
  const expiredAt = Date.parse(allowance().expiresAt);
  expect(() => state.validate({ ...admitted, attemptId: "next" }, expiredAt)).toThrow("needs review");
  expect(() => state.validate({ type: "reserve", requestId: "model", identity: modelIdentity, maxUsd: "1" }, expiredAt)).toThrow("needs review");
  expect(() => state.validate({ type: "observe", observation: { observationId: "late-invoice", requestId: "overhead:ci_compute",
    source: "invoice", provider: "aws", currency: "USD", route: "infrastructure", classification: "reconciled", costUsd: "0.5", final: true } }, expiredAt)).not.toThrow();
});


it("separates model readiness from unresolved overhead without releasing holds or masking model gaps", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-model-readiness-"));
  const file = path.join(directory, "ledger.jsonl");
  const overhead = { ...currentAllowance(), accountingReadiness: "model_requests" as const };
  const ledger = await openEvalCostLedger(file, { campaignId: "model-readiness", maxUsd: "20",
    deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 10, maxConcurrent: 1, maxAttemptsPerExecution: 1, overhead });
  try {
    expect(evalReadinessStatus(await readEvalOperationsReport(file))).toBe("blocked");
    await ledger.admitAttempt(modelIdentity.executionId, modelIdentity.attemptId);
    await ledger.reserve("model", modelIdentity, "2");
    expect(evalReadinessStatus(await readEvalOperationsReport(file))).toBe("blocked");
    await ledger.finish("model", "cancelled");
    expect(evalReadinessStatus(await readEvalOperationsReport(file))).toBe("blocked");
    await ledger.observe({ observationId: "model-final", requestId: "model", source: "provider", provider: "anthropic",
      currency: "USD", route: "direct", classification: "reported", costUsd: "0.5", final: true });
    const report = await readEvalOperationsReport(file);
    expect(evalAccountingStatus(report)).toBe("blocked");
    expect(evalReadinessStatus(report)).toBe("receipts_complete");
    expect(evalReadinessStatus({ ...report, accountingReadiness: undefined } as never)).toBe("blocked");
    expect(report).toMatchObject({ accountingReadiness: "model_requests", heldUsd: "4.000000000",
      committedUsd: "4.500000000", modelAccounting: { requests: 1, knownUsd: "0.500000000", unresolvedRequests: 0 } });
    expect(renderEvalOperationsReport(report)).toContain("Operating costs remain separately unreconciled");
    await ledger.observe({ observationId: "overrun", requestId: "overhead:ci_compute", source: "invoice", provider: "aws",
      currency: "USD", route: "infrastructure", classification: "reconciled", costUsd: "21", final: true });
    expect(evalReadinessStatus(await readEvalOperationsReport(file))).toBe("blocked");
  } finally { await ledger.close(); await rm(directory, { recursive: true, force: true }); }
});

it("rejects unknown readiness policies instead of silently loosening accounting", () => {
  expect(() => validateOperatingOverhead({ ...allowance(), accountingReadiness: "ignore_costs" } as never, "20"))
    .toThrow("Invalid accounting readiness policy");
});

it("binds optional readiness policy to reviewed operating evidence without changing legacy hash recipes", () => {
  for (const accountingReadiness of [undefined, "model_requests"] as const) {
    const value = { ...allowance(), ...(accountingReadiness ? { accountingReadiness } : {}) };
    const component = value.components[0]!;
    const calculation = { reference: value.reference, runner: value.runner, verifiedAt: value.verifiedAt,
      expiresAt: value.expiresAt, component: { ...component }, ...(accountingReadiness ? { accountingReadiness } : {}) };
    component.provisionalBound = { version: 1, scope: "full_lifecycle", evidenceSha256: "a".repeat(64),
      configurationSha256: costBoundConfigurationSha256(calculation) };
    expect(operatingReservationBound(value, component)?.calculationSha256).toBe(component.provisionalBound.configurationSha256);
    const changed = { ...value, accountingReadiness: accountingReadiness ? undefined : "model_requests" as const };
    expect(() => operatingReservationBound(changed, component)).toThrow("Reviewed cost bound configuration changed");
  }
});
