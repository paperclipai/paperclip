import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { openEvalCostLedger, readEvalCostLedger } from "./cost-ledger.js";
import { EVAL_OVERHEAD_COMPONENTS, type EvalOperatingOverhead } from "./operating-overhead.js";
import { importOperatingReceipt, operatingReceiptObservation, type EvalOperatingReceipt } from "./operating-receipts.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});

const evidence = Buffer.from("fixture-only infrastructure receipt");
const overhead: EvalOperatingOverhead = { version: 1, runner: "github-hosted", reference: "fixture-allowance",
  verifiedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-11-01T00:00:00Z",
  components: EVAL_OVERHEAD_COMPONENTS.map(component => ({ component, maxUsd: "1", reference: `fixture-${component}` })) };
const receipt = (fields: Partial<EvalOperatingReceipt> = {}): EvalOperatingReceipt => ({ version: 2, costBasis: "component_cumulative", campaignId: "fixture",
  allowanceReference: overhead.reference, component: "artifact_storage", evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
  windowStartedAt: "2026-10-01T00:00:00Z", windowEndedAt: "2026-10-02T00:00:00Z", coverage: "partial",
  source: "infrastructure", provider: "fixture", classification: "estimated", costUsd: "0.2", pricingVersion: "fixture-pricing", ...fields });
const now = Date.parse("2026-10-03T00:00:00Z");

it("binds operating observations to the campaign, allowance, evidence and closed observation window", () => {
  expect(operatingReceiptObservation(receipt(), "fixture", overhead, evidence, now)).toMatchObject({ requestId: "overhead:artifact_storage", final: false });
  for (const changed of [receipt({ campaignId: "other" }), receipt({ allowanceReference: "other" }), receipt({ evidenceSha256: "0".repeat(64) }),
    receipt({ windowEndedAt: "2026-10-04T00:00:00Z" }), receipt({ windowStartedAt: "2026-10-03T00:00:00Z" }),
    receipt({ component: "model" as never }), receipt({ version: 1 as never }), receipt({ costBasis: undefined }),
    receipt({ costBasis: "window_charge" as never }), { ...receipt(), apiKey: "disallowed" }]) {
    expect(() => operatingReceiptObservation(changed, "fixture", overhead, evidence, now)).toThrow();
  }
  expect(() => operatingReceiptObservation(receipt(), "fixture", overhead, Buffer.from("different"), now)).toThrow();
});

it("does not upgrade missing or partial evidence to an invoice or completed receipt", () => {
  for (const changed of [receipt({ classification: "reconciled" }), receipt({ classification: "unknown" }),
    receipt({ classification: "unknown", costUsd: undefined, coverage: "complete" }), receipt({ pricingVersion: undefined }), receipt({ costUsd: "-1" })]) {
    expect(() => operatingReceiptObservation(changed, "fixture", overhead, evidence, now)).toThrow();
  }
  expect(operatingReceiptObservation(receipt({ classification: "unknown", costUsd: undefined }), "fixture", overhead, evidence, now))
    .toMatchObject({ classification: "unknown", final: false });
  expect(operatingReceiptObservation(receipt({ component: "shared_subscription", classification: "allocated", coverage: "complete" }), "fixture", overhead, evidence, now))
    .toMatchObject({ classification: "allocated", route: "subscription", final: true });
});

async function fixture(maxUsd = "20") {
  const directory = await mkdtemp(path.join(tmpdir(), "operating-receipts-"));
  const ledgerPath = path.join(directory, "ledger.jsonl");
  const ledger = await openEvalCostLedger(ledgerPath, { campaignId: "fixture", maxUsd, deadlineAt: "2099-01-01T00:00:00Z",
    maxRequests: 10, maxConcurrent: 1, maxAttemptsPerExecution: 1, overhead });
  await ledger.close();
  return { directory, ledgerPath };
}

it("retains private source evidence, imports idempotently and keeps partial holds until invoice reconciliation", async () => {
  const { directory, ledgerPath } = await fixture();
  try {
    expect(await importOperatingReceipt(ledgerPath, receipt(), evidence)).toMatchObject({ knownUsd: "0.200000000", heldUsd: "3.800000000", unknownRequests: 4 });
    const before = await readFile(ledgerPath, "utf8");
    await importOperatingReceipt(ledgerPath, Object.fromEntries(Object.entries(receipt()).reverse()) as unknown as EvalOperatingReceipt, evidence);
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
    const retained = path.join(`${ledgerPath}.overhead`, `${receipt().evidenceSha256}.evidence`);
    expect(await readFile(retained)).toEqual(evidence);
    expect((await stat(retained)).mode & 0o777).toBe(0o600);
    expect(await readdir(`${ledgerPath}.overhead`)).toHaveLength(2);
    expect(await importOperatingReceipt(ledgerPath, receipt({ source: "invoice", classification: "reconciled", costUsd: "0.3", coverage: "complete" }), evidence))
      .toMatchObject({ knownUsd: "0.300000000", heldUsd: "3.000000000", unknownRequests: 3 });
    expect(await importOperatingReceipt(ledgerPath, receipt({ source: "invoice", classification: "reconciled", costUsd: "0.4", coverage: "complete" }), evidence))
      .toMatchObject({ knownUsd: "0.400000000", heldUsd: "3.600000000", conflictingRequests: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("fails before ledger mutation when retained evidence is corrupt or another writer owns the journal", async () => {
  const { directory, ledgerPath } = await fixture();
  try {
    await importOperatingReceipt(ledgerPath, receipt(), evidence);
    const before = await readFile(ledgerPath, "utf8");
    await writeFile(path.join(`${ledgerPath}.overhead`, `${receipt().evidenceSha256}.evidence`), "corrupted");
    await expect(importOperatingReceipt(ledgerPath, receipt({ costUsd: "0.5" }), evidence)).rejects.toThrow("conflicts");
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
    const loaded = await readEvalCostLedger(ledgerPath), writer = await openEvalCostLedger(ledgerPath, loaded.state.limits);
    try { await expect(importOperatingReceipt(ledgerPath, receipt(), evidence)).rejects.toThrow("writer lock"); }
    finally { await writer.close(); }
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("rejects separate partial windows and accounts for their cumulative total before admitting more work", async () => {
  const { directory, ledgerPath } = await fixture("4.5");
  try {
    await importOperatingReceipt(ledgerPath, receipt({ source: "invoice", classification: "reconciled", costUsd: "0.8" }), evidence);
    const before = await readFile(ledgerPath, "utf8");
    await expect(importOperatingReceipt(ledgerPath, receipt({ source: "invoice", classification: "reconciled", costUsd: "0.8",
      windowStartedAt: "2026-10-02T00:00:00Z", windowEndedAt: "2026-10-03T00:00:00Z" }), evidence)).rejects.toThrow("cumulative component window");
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
    expect(await importOperatingReceipt(ledgerPath, receipt({ source: "invoice", classification: "reconciled", costUsd: "1.6",
      windowEndedAt: "2026-10-03T00:00:00Z" }), evidence)).toMatchObject({ knownUsd: "1.600000000", heldUsd: "3.000000000", committedUsd: "4.600000000", overBudget: true });
    const loaded = await readEvalCostLedger(ledgerPath), writer = await openEvalCostLedger(ledgerPath, loaded.state.limits);
    try {
      await writer.admitAttempt("fixture-cell", "next");
      await expect(writer.reserve("next", { executionId: "fixture-cell", attemptId: "next", phase: "agent" }, "0.01"))
        .rejects.toThrow("spending cap reached");
    } finally { await writer.close(); }
    await expect(importOperatingReceipt(ledgerPath, receipt({ costUsd: "0.9" }), evidence)).rejects.toThrow("cumulative component window");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(["partial", "complete"] as const)("rejects a larger cumulative estimate hidden by an earlier %s invoice", async coverage => {
  const { directory, ledgerPath } = await fixture("4.5");
  try {
    await importOperatingReceipt(ledgerPath, receipt({ source: "invoice", classification: "reconciled", costUsd: "0.8", coverage }), evidence);
    const before = await readFile(ledgerPath, "utf8"), retained = await readdir(`${ledgerPath}.overhead`);
    await expect(importOperatingReceipt(ledgerPath, receipt({ costUsd: "1.6", coverage,
      windowEndedAt: "2026-10-03T00:00:00Z" }), evidence)).rejects.toThrow("would understate the cumulative total");
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
    expect(await readdir(`${ledgerPath}.overhead`)).toEqual(retained);
    const updated = await importOperatingReceipt(ledgerPath, receipt({ source: "invoice", classification: "reconciled", costUsd: "1.6", coverage,
      windowEndedAt: "2026-10-03T00:00:00Z" }), evidence);
    expect(updated).toMatchObject({ knownUsd: "1.600000000", committedUsd: "4.600000000", overBudget: true });
    const loaded = await readEvalCostLedger(ledgerPath), writer = await openEvalCostLedger(ledgerPath, loaded.state.limits);
    try {
      await writer.admitAttempt("fixture-cell", "next");
      await expect(writer.reserve("next", { executionId: "fixture-cell", attemptId: "next", phase: "agent" }, "0.01"))
        .rejects.toThrow(coverage === "complete" ? "receipts conflict" : "spending cap reached");
    } finally { await writer.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(["evidence", "receipt.json"])("retries must persist the existing %s file before recording its charge", async suffix => {
  const { directory, ledgerPath } = await fixture();
  const before = await readFile(ledgerPath, "utf8"), originalOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
  const value = receipt(), canonical = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  const observation = operatingReceiptObservation(value, "fixture", overhead, evidence, now);
  await mkdir(`${ledgerPath}.overhead`, { mode: 0o700 });
  await writeFile(path.join(`${ledgerPath}.overhead`, suffix === "evidence" ? `${value.evidenceSha256}.evidence`
    : `${observation.observationId.split(":")[1]}.receipt.json`), suffix === "evidence" ? evidence : `${JSON.stringify(canonical, null, 2)}\n`, { mode: 0o600 });
  let syncs = 0;
  const opened = vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith(`.${suffix}`)) {
      const originalSync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        if (++syncs <= 2) throw new Error("fixture file sync failure");
        await originalSync();
      });
    }
    return handle;
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(importOperatingReceipt(ledgerPath, receipt(), evidence)).rejects.toThrow("file sync failure");
      expect(await readFile(ledgerPath, "utf8")).toBe(before);
    }
    expect(await importOperatingReceipt(ledgerPath, receipt(), evidence)).toMatchObject({ knownUsd: "0.200000000", heldUsd: "3.800000000" });
    expect(syncs).toBe(3);
  } finally {
    opened.mockImplementation(originalOpen);
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["evidence", "receipt.json"])("recovers an incomplete %s write without publishing corrupt evidence or requiring manual deletion", async suffix => {
  const { directory, ledgerPath } = await fixture();
  const before = await readFile(ledgerPath, "utf8"), originalOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
  let injected = false;
  const opened = vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (!injected && String(args[0]).includes(`.${suffix}.`) && String(args[0]).endsWith(".tmp")) {
      const originalWrite = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementation(async () => {
        injected = true;
        await originalWrite("partial");
        throw new Error("fixture partial write");
      });
    }
    return handle;
  });
  try {
    await expect(importOperatingReceipt(ledgerPath, receipt(), evidence)).rejects.toThrow("partial write");
    expect(injected).toBe(true);
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
    expect((await readdir(`${ledgerPath}.overhead`)).some(name => name.endsWith(`.${suffix}`) || name.endsWith(".tmp"))).toBe(false);
    expect(await importOperatingReceipt(ledgerPath, receipt(), evidence)).toMatchObject({ knownUsd: "0.200000000", heldUsd: "3.800000000" });
    expect(await readdir(`${ledgerPath}.overhead`)).toHaveLength(2);
  } finally {
    opened.mockImplementation(originalOpen);
    await rm(directory, { recursive: true, force: true });
  }
});

it("retains the hold when the first evidence directory cannot be persisted in its parent", async () => {
  const { directory, ledgerPath } = await fixture();
  const before = await readFile(ledgerPath, "utf8"), originalOpen = (await vi.importActual<typeof fs>("node:fs/promises")).open;
  let parentSyncs = 0;
  const opened = vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === directory && args[1] === "r") {
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        parentSyncs++;
        throw new Error("fixture parent directory sync failure");
      });
    }
    return handle;
  });
  try {
    await expect(importOperatingReceipt(ledgerPath, receipt(), evidence)).rejects.toThrow("parent directory sync failure");
    expect(parentSyncs).toBe(1);
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
    expect((await readEvalCostLedger(ledgerPath)).state.snapshot()).toMatchObject({ knownUsd: "0.000000000", heldUsd: "4.000000000" });
  } finally {
    opened.mockImplementation(originalOpen);
    await rm(directory, { recursive: true, force: true });
  }
});
