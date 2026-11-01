import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvalSpendState, openEvalCostLedger, readEvalCostLedger, type EvalCostObservation, type EvalSpendLimits } from "./cost-ledger.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const limits = (overrides: Partial<EvalSpendLimits> = {}): EvalSpendLimits => ({ campaignId: "pilot", maxUsd: "1", deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 10, maxConcurrent: 2, ...overrides });
const identity = { executionId: "codex.local.fixture", attemptId: "attempt-1", phase: "setup" as const };
const observation = (overrides: Partial<EvalCostObservation> = {}): EvalCostObservation => ({ observationId: "receipt", requestId: "request", source: "provider", provider: "openai", model: "fixture", providerRequestId: "provider-request", currency: "USD", route: "direct", classification: "reported", costUsd: "0.000000123", final: true, ...overrides });
async function fixture(overrides: Partial<EvalSpendLimits> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-cost-ledger-")); roots.push(root);
  const file = path.join(root, "costs.jsonl");
  return { file, ledger: await openEvalCostLedger(file, limits(overrides)) };
}

it("persists a reservation before dispatch and counts setup spending with nanodollar precision", async () => {
  const { file, ledger } = await fixture();
  try {
    await ledger.reserve("request", identity, "0.1");
    const beforeDispatch = (await readEvalCostLedger(file)).state.snapshot();
    expect(beforeDispatch).toMatchObject({ committedUsd: "0.100000000", heldUsd: "0.100000000", unknownRequests: 1 });
    await ledger.observe(observation());
    await ledger.finish("request", "succeeded");
    expect(ledger.snapshot()).toMatchObject({ knownUsd: "0.000000123", committedUsd: "0.000000123", heldUsd: "0.000000000",
      requests: [{ phase: "setup", receiptComplete: true }] });
  } finally { await ledger.close(); }
  expect((await readEvalCostLedger(file)).state.snapshot().knownUsd).toBe("0.000000123");
});

it("serializes competing admissions so concurrent requests cannot oversubscribe a cap", async () => {
  const { ledger } = await fixture();
  try {
    const admitted = await Promise.allSettled([ledger.reserve("one", identity, "0.6"), ledger.reserve("two", identity, "0.6")]);
    expect(admitted.map(value => value.status)).toEqual(["fulfilled", "rejected"]);
    expect(ledger.snapshot().committedUsd).toBe("0.600000000");
  } finally { await ledger.close(); }
});

it("durably caps attempts including zero-request failures and rejects unadmitted requests", async () => {
  const cap = limits({ maxAttemptsPerExecution: 2 });
  const { file, ledger } = await fixture({ maxAttemptsPerExecution: 2 });
  await expect(ledger.reserve("request", identity, "0.1")).rejects.toThrow("no admitted attempt");
  await ledger.admitAttempt(identity.executionId, "attempt-1");
  await ledger.close();
  const resumed = await openEvalCostLedger(file, cap);
  try {
    await expect(resumed.admitAttempt(identity.executionId, "attempt-1")).rejects.toThrow("already admitted");
    const competing = await Promise.allSettled([
      resumed.admitAttempt(identity.executionId, "attempt-2"),
      resumed.admitAttempt(identity.executionId, "attempt-3"),
    ]);
    expect(competing.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    await resumed.reserve("request", { ...identity, attemptId: "attempt-2" }, "0.1");
    await resumed.admitAttempt("another.cell", "another-attempt");
    await expect(resumed.reserve("wrong-cell", { ...identity, attemptId: "another-attempt" }, "0.1")).rejects.toThrow("no admitted attempt");
    expect((await readEvalCostLedger(file)).state.snapshot().admittedAttempts).toHaveLength(3);
  } finally { await resumed.close(); }
  await expect(openEvalCostLedger(file, limits({ maxAttemptsPerExecution: 3 }))).rejects.toThrow("limits changed");
});

it("holds unknown/cancelled charges after restart and counts failed retries independently", async () => {
  const { file, ledger } = await fixture();
  await ledger.reserve("request", identity, "0.5");
  await ledger.finish("request", "cancelled");
  await ledger.close();
  const resumed = await openEvalCostLedger(file, limits());
  try {
    expect(resumed.snapshot()).toMatchObject({ inflight: 0, unknownRequests: 1, committedUsd: "0.500000000" });
    await resumed.reserve("retry", { ...identity, attemptId: "attempt-2" }, "0.5");
    await resumed.observe(observation({ observationId: "retry-cost", requestId: "retry", providerRequestId: "provider-retry", costUsd: "0.2" }));
    await resumed.finish("retry", "failed");
    expect(resumed.snapshot()).toMatchObject({ knownUsd: "0.200000000", heldUsd: "0.500000000", committedUsd: "0.700000000" });
    await resumed.observe(observation({ costUsd: "0.3" }));
    expect(resumed.snapshot()).toMatchObject({ knownUsd: "0.500000000", heldUsd: "0.000000000" });
  } finally { await resumed.close(); }
});

it("deduplicates provider/gateway/native observations and preserves invoice adjustments", async () => {
  const { ledger } = await fixture();
  try {
    await ledger.reserve("request", identity, "1");
    await ledger.observe(observation({ source: "gateway", classification: "estimated", pricingVersion: "2026-10-20", costUsd: "0.3" }));
    await ledger.observe(observation({ source: "gateway", classification: "estimated", pricingVersion: "2026-10-20", costUsd: "0.3" }));
    await ledger.observe(observation({ observationId: "native", source: "native_otlp", costUsd: "0.2" }));
    await ledger.observe(observation({ observationId: "invoice", source: "invoice", classification: "reconciled", costUsd: "0.15" }));
    await ledger.finish("request", "succeeded");
    expect(ledger.snapshot()).toMatchObject({ knownUsd: "0.150000000", breakdown: { estimated: "0.000000000", reported: "0.000000000", reconciled: "0.150000000" } });
    await expect(ledger.observe(observation({ costUsd: "0.7" }))).rejects.toThrow("identity conflict");
  } finally { await ledger.close(); }
});

it("retains partial costs and contradictory receipts without freeing their reservations", async () => {
  const { ledger } = await fixture();
  try {
    await ledger.reserve("request", identity, "0.5");
    await ledger.observe(observation({ final: false, costUsd: "0.2" }));
    await ledger.finish("request", "failed");
    expect(ledger.snapshot()).toMatchObject({ knownUsd: "0.200000000", heldUsd: "0.300000000", unknownRequests: 1 });
    await ledger.observe(observation({ observationId: "final1", costUsd: "0.3" }));
    await ledger.observe(observation({ observationId: "final2", costUsd: "0.4" }));
    expect(ledger.snapshot()).toMatchObject({ knownUsd: "0.400000000", heldUsd: "0.100000000", conflictingRequests: 1 });
    await expect(ledger.reserve("later", identity, "0.1")).rejects.toThrow("receipts conflict");
  } finally { await ledger.close(); }
});

it("rejects ambiguous request joins and stops on measured overshoot", async () => {
  const { ledger } = await fixture();
  try {
    await ledger.reserve("request", identity, "0.1");
    await ledger.reserve("another", identity, "0.1");
    await ledger.observe(observation({ costUsd: "1.1" }));
    await expect(ledger.observe(observation({ observationId: "duplicate-request", requestId: "another" }))).rejects.toThrow("another reservation");
    expect(ledger.snapshot().overBudget).toBe(true);
    await ledger.finish("request", "succeeded");
    await expect(ledger.reserve("later", identity, "0.1")).rejects.toThrow("spending cap");
  } finally { await ledger.close(); }
});

it("enforces deadlines, request count, concurrency, and explicit pricing/usage invariants", async () => {
  const expired = await fixture({ deadlineAt: "2000-01-01T00:00:00Z" });
  await expect(expired.ledger.reserve("request", identity, "0.1")).rejects.toThrow("deadline");
  await expired.ledger.close();
  const { ledger } = await fixture({ maxRequests: 2, maxConcurrent: 1 });
  try {
    await ledger.reserve("request", identity, "0.1");
    await expect(ledger.reserve("two", identity, "0.1")).rejects.toThrow("concurrency");
    await expect(ledger.observe(observation({ classification: "estimated" }))).rejects.toThrow("pricing provenance");
    await expect(ledger.observe(observation({ tokens: { output: 1, reasoning: 2 } }))).rejects.toThrow("token usage");
    await ledger.finish("request", "failed");
    await ledger.reserve("two", identity, "0.1");
    await ledger.finish("two", "failed");
    await expect(ledger.reserve("three", identity, "0.1")).rejects.toThrow("request cap");
  } finally { await ledger.close(); }
});

it("fails closed on concurrent writers, changed limits, incomplete writes, and tampering", async () => {
  const { file, ledger } = await fixture();
  await expect(openEvalCostLedger(file, limits())).rejects.toThrow("writer lock");
  await ledger.reserve("request", identity, "0.1");
  await ledger.close();
  await expect(openEvalCostLedger(file, limits({ maxUsd: "2" }))).rejects.toThrow("limits changed");
  const contents = await readFile(file, "utf8");
  await writeFile(file, contents.slice(0, -1));
  await expect(readEvalCostLedger(file)).rejects.toThrow("incomplete");
  await writeFile(file, contents.replace('"maxUsd":"1"', '"maxUsd":"2"'));
  await expect(readEvalCostLedger(file)).rejects.toThrow("integrity");
});

it("rejects accidental raw payload fields and accepts equivalent receipt key order", async () => {
  const { file, ledger } = await fixture();
  try {
    await ledger.reserve("request", identity, "0.1");
    await expect(ledger.observe({ ...observation(), rawResponse: "private response" } as EvalCostObservation)).rejects.toThrow("Unknown ledger field");
    await ledger.observe(observation());
    await ledger.observe(Object.fromEntries(Object.entries(observation()).reverse()) as unknown as EvalCostObservation);
    expect(await readFile(file, "utf8")).not.toContain("private response");
  } finally { await ledger.close(); }
});

it("does not let a terminal estimate erase a stronger partial provider charge", async () => {
  const { ledger } = await fixture();
  try {
    await ledger.reserve("request", identity, "0.8");
    await ledger.observe(observation({ observationId: "provider-partial", final: false, costUsd: "0.6" }));
    await ledger.observe(observation({ observationId: "gateway-final", source: "gateway", classification: "estimated", pricingVersion: "fixture", costUsd: "0.1" }));
    await ledger.finish("request", "succeeded");
    expect(ledger.snapshot()).toMatchObject({ knownUsd: "0.600000000", heldUsd: "0.200000000", unknownRequests: 1, breakdown: { reported: "0.600000000", estimated: "0.000000000" } });
    await expect(ledger.reserve("next", identity, "0.3")).rejects.toThrow("spending cap");
    await ledger.observe(observation({ observationId: "provider-final", costUsd: "0.65" }));
    expect(ledger.snapshot()).toMatchObject({ knownUsd: "0.650000000", heldUsd: "0.000000000", unknownRequests: 0 });
  } finally { await ledger.close(); }
});

it("replays admissions when the deadline crosses between validation and journal writing", async () => {
  const admittedAt = Date.parse("2098-12-31T23:59:59.999Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(admittedAt);
  const { file, ledger } = await fixture();
  const validate = EvalSpendState.prototype.validate;
  const validation = vi.spyOn(EvalSpendState.prototype, "validate").mockImplementation(function (this: EvalSpendState, event, now) {
    validate.call(this, event, now);
    vi.setSystemTime(admittedAt + 2);
  });
  try {
    await ledger.reserve("request", identity, "0.1");
    validation.mockRestore();
    expect((await readEvalCostLedger(file)).state.snapshot().committedUsd).toBe("0.100000000");
    const records = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records[1].at).toBe(new Date(admittedAt).toISOString());
  } finally {
    validation.mockRestore();
    vi.useRealTimers();
    await ledger.close();
  }
});
