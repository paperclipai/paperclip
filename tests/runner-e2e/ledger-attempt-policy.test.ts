import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openEvalCostLedger, readEvalCostLedger, type EvalSpendLimits } from "./cost-ledger.js";
import { adoptLegacyEvalAttemptPolicy, type LegacyAttemptAuditFile } from "./ledger-attempt-policy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const limits: EvalSpendLimits = { campaignId: "legacy-pilot", maxUsd: "1", deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 3, maxConcurrent: 1 };
const identity = { executionId: "claude.local.fixture", attemptId: "old-request-attempt", phase: "agent" as const };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function fixture(overrides: Partial<EvalSpendLimits> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-eval-attempts-")); roots.push(root);
  const file = path.join(root, "ledger.jsonl");
  const originalLimits = { ...limits, ...overrides };
  const ledger = await openEvalCostLedger(file, originalLimits);
  await ledger.reserve("cancelled-request", identity, "0.6");
  await ledger.observe({ observationId: "partial", requestId: "cancelled-request", source: "provider", provider: "anthropic",
    currency: "USD", route: "direct", classification: "reported", costUsd: "0.2", final: false });
  await ledger.finish("cancelled-request", "cancelled");
  await ledger.close();
  const evidencePath = path.join(root, "reviewed-attempts.md");
  const evidence = "Reviewed retained campaigns, including the earlier zero-request startup failure.";
  await writeFile(evidencePath, evidence);
  const loaded = await readEvalCostLedger(file);
  const audit: LegacyAttemptAuditFile = { version: 1, ledgerPath: file, evidencePath, evidenceSha256: hash(evidence),
    previousJournalHash: loaded.previous, maxAttemptsPerExecution: 3,
    priorAttempts: [identity, { executionId: identity.executionId, attemptId: "old-zero-request-attempt" }]
      .map(({ executionId, attemptId }) => ({ executionId, attemptId })) };
  return { file, audit, originalLimits, before: loaded.state.snapshot(), prefix: await readFile(file, "utf8") };
}

it("appends an audited policy without rewriting charges, held reservations, or original limits", async () => {
  const { file, audit, before, prefix, originalLimits } = await fixture();
  const migrated = await adoptLegacyEvalAttemptPolicy(audit);
  expect((await readFile(file, "utf8")).startsWith(prefix)).toBe(true);
  expect(migrated.limits).toEqual({ ...originalLimits, maxAttemptsPerExecution: 3 });
  expect({ ...migrated.accounting, admittedAttempts: [] }).toEqual(before);
  expect(migrated.accounting.admittedAttempts).toEqual(audit.priorAttempts);
  const resumed = await openEvalCostLedger(file, migrated.limits);
  try {
    await resumed.admitAttempt(identity.executionId, "new-attempt");
    await expect(resumed.admitAttempt(identity.executionId, "extra-attempt")).rejects.toThrow("attempt cap");
    await expect(resumed.reserve("new-request", { ...identity, attemptId: "new-attempt" }, "0.5")).rejects.toThrow("spending cap");
    await resumed.reserve("new-request", { ...identity, attemptId: "new-attempt" }, "0.4");
    expect(resumed.snapshot().committedUsd).toBe("1.000000000");
  } finally { await resumed.close(); }
  const replayed = await readEvalCostLedger(file);
  expect(replayed.state.snapshot().admittedAttempts).toHaveLength(3);
  expect(replayed.state.snapshot().knownUsd).toBe("0.200000000");
  await expect(openEvalCostLedger(file, originalLimits)).rejects.toThrow("limits changed");
  await expect(openEvalCostLedger(file, { ...migrated.limits, maxUsd: "2" })).rejects.toThrow("limits changed");
});

it("requires all recorded request identities and rejects duplicate or foreign attempts", async () => {
  const { file, audit, prefix } = await fixture();
  await expect(adoptLegacyEvalAttemptPolicy({ ...audit, priorAttempts: [] })).rejects.toThrow("omits a recorded request");
  await expect(adoptLegacyEvalAttemptPolicy({ ...audit, priorAttempts: [audit.priorAttempts[0]!, audit.priorAttempts[0]!] })).rejects.toThrow("Invalid legacy attempt identity");
  await expect(adoptLegacyEvalAttemptPolicy({ ...audit, priorAttempts: [{ ...audit.priorAttempts[0]!, executionId: "other-cell" }] })).rejects.toThrow("omits a recorded request");
  expect(await readFile(file, "utf8")).toBe(prefix);
});

it("rejects changed evidence and changed journal checkpoints without appending", async () => {
  const { file, audit, prefix, originalLimits } = await fixture();
  await expect(adoptLegacyEvalAttemptPolicy({ ...audit, evidenceSha256: "a".repeat(64) })).rejects.toThrow("evidence changed");
  expect(await readFile(file, "utf8")).toBe(prefix);
  const writer = await openEvalCostLedger(file, originalLimits);
  try {
    await writer.observe({ observationId: "late", requestId: "cancelled-request", source: "invoice", provider: "anthropic",
      currency: "USD", route: "direct", classification: "reconciled", costUsd: "0.1", final: true });
    await expect(writer.adoptLegacyAttemptPolicy({ previousJournalHash: audit.previousJournalHash, evidenceSha256: audit.evidenceSha256,
      maxAttemptsPerExecution: 3, priorAttempts: audit.priorAttempts })).rejects.toThrow("checkpoint changed");
  } finally { await writer.close(); }
  await expect(adoptLegacyEvalAttemptPolicy(audit)).rejects.toThrow("checkpoint changed");
  expect((await readEvalCostLedger(file)).state.limits.maxAttemptsPerExecution).toBeUndefined();
});

it("refuses concurrent writers and unfinished requests", async () => {
  const { file, audit, originalLimits } = await fixture();
  const writer = await openEvalCostLedger(file, originalLimits);
  try {
    await expect(adoptLegacyEvalAttemptPolicy(audit)).rejects.toThrow("writer lock");
    await writer.reserve("inflight", identity, "0.1");
  } finally { await writer.close(); }
  const changed = await readEvalCostLedger(file);
  await expect(adoptLegacyEvalAttemptPolicy({ ...audit, previousJournalHash: changed.previous })).rejects.toThrow("stopped requests");
  expect((await readEvalCostLedger(file)).state.snapshot().inflight).toBe(1);
});

it("does not change established caps or admit extra attempts after an over-cap history", async () => {
  const { file, audit } = await fixture();
  const migrated = await adoptLegacyEvalAttemptPolicy({ ...audit, maxAttemptsPerExecution: 1 });
  const writer = await openEvalCostLedger(file, migrated.limits);
  try { await expect(writer.admitAttempt(identity.executionId, "extra")).rejects.toThrow("attempt cap"); }
  finally { await writer.close(); }
  await expect(adoptLegacyEvalAttemptPolicy({ ...audit, previousJournalHash: migrated.journalHash, maxAttemptsPerExecution: 10 })).rejects.toThrow("already established");
});

it("preserves an expired campaign deadline during a historical audit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "expired-eval-attempts-")); roots.push(root);
  const file = path.join(root, "ledger.jsonl"), evidencePath = path.join(root, "audit.md");
  const writer = await openEvalCostLedger(file, { ...limits, deadlineAt: "2000-01-01T00:00:00Z" });
  await writer.close(); await writeFile(evidencePath, "No launched attempts.");
  const original = await readEvalCostLedger(file);
  const migrated = await adoptLegacyEvalAttemptPolicy({ version: 1, ledgerPath: file, evidencePath, evidenceSha256: hash("No launched attempts."),
    previousJournalHash: original.previous, maxAttemptsPerExecution: 1, priorAttempts: [] });
  const resumed = await openEvalCostLedger(file, migrated.limits);
  try { await expect(resumed.admitAttempt("cell", "attempt")).rejects.toThrow("deadline"); }
  finally { await resumed.close(); }
});

it("rejects extra policy fields instead of accepting limit changes or private notes", async () => {
  const { file, audit, prefix } = await fixture();
  await expect(adoptLegacyEvalAttemptPolicy({ ...audit, maxUsd: "100" } as LegacyAttemptAuditFile)).rejects.toThrow("Invalid legacy attempt audit file");
  await expect(adoptLegacyEvalAttemptPolicy({ ...audit, priorAttempts: [{ ...audit.priorAttempts[0]!, note: "private" }] } as unknown as LegacyAttemptAuditFile)).rejects.toThrow("Unknown ledger field");
  expect(await readFile(file, "utf8")).toBe(prefix);
});
