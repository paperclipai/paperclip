import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openEvalCostLedger } from "./cost-ledger.js";
import { startEvalOtlpRelay } from "./eval-otlp-relay.js";
import { EVAL_FINALIZATION_LIMITS } from "./eval-finalization-relay.js";
import { openExperimentIngestion } from "./experiment-ingestion.js";
import { collectScheduledIngestion } from "./ingestion-usage.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "scheduled-ingestion-")); roots.push(root);
  const input = { ledgerPath: path.join(root, "ledger.jsonl"), campaignId: "campaign", projectId, executionIds: ["fixture.local"] };
  const ledger = await openEvalCostLedger(input.ledgerPath, { campaignId: input.campaignId, maxUsd: "1",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), maxRequests: 1, maxConcurrent: 1, maxAttemptsPerExecution: 1 });
  try { await ledger.admitAttempt(input.executionIds[0]!, "attempt"); } finally { await ledger.close(); }
  const name = createHash("sha256").update("attempt").digest("hex"), files: string[] = [];
  for (const kind of ["native", "finalization"] as const) {
    const receiptPath = path.join(`${input.ledgerPath}.otlp`, `${name}${kind === "finalization" ? "-finalization" : ""}.jsonl`);
    files.push(receiptPath);
    const relay = await startEvalOtlpRelay({ ...input, attemptId: "attempt", apiKey: "private-fixture", receiptPath,
      deadlineAt: Date.now() + 60_000, ...(kind === "finalization" ? { limits: EVAL_FINALIZATION_LIMITS } : {}),
      transport: async () => Response.json({}) });
    try {
      expect((await fetch(relay.baseUrl + "/v1/traces", { method: "POST", body: "{}",
        headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" } })).status).toBe(200);
    } finally { await relay.close(); }
  }
  const experiment = await openExperimentIngestion({ ...input, receiptPath: `${input.ledgerPath}.experiment-ingestion.jsonl`,
    deadlineAt: Date.now() + 60_000, transport: async () => Response.json({}) });
  const body = JSON.stringify({ project_id: projectId });
  try { await experiment.transport("https://api.braintrust.dev/v1/experiment", { method: "POST", body }); }
  finally { await experiment.close(); }
  return { input, files, expectedBytes: 4 + Buffer.byteLength(body) };
}

it("reconciles real durable receipts for all three transport paths without inventing vendor billing", async () => {
  const f = await fixture(), usage = await collectScheduledIngestion(f.input);
  expect(usage).toMatchObject({ status: "complete", observedAdmittedPayloadBytes: f.expectedBytes,
    totalAdmittedPayloadBytes: f.expectedBytes, billedCostUsd: null, billingStatus: "unreconciled", missingExecutions: [] });
  expect(usage.receipts.map(row => row.kind)).toEqual(["native", "finalization", "experiment"]);
  expect(usage.receipts[0]).toMatchObject({ admittedExpandedSourceBytes: 2, admittedRecords: 0 });
  expect(usage.receipts.every(row => "receiptSha256" in row && /^[a-f0-9]{64}$/.test(row.receiptSha256!))).toBe(true);
  expect(usage.ledgerHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(usage)).not.toContain("private-fixture");
});

it.each(["missing", "unclosed", "unresolved", "foreign-project", "bad-total", "bad-expanded-total", "missing-record-count", "duplicate-outcome"])(
  "retains other measured traffic and an unknown total for a %s receipt", async reason => {
    const f = await fixture(), file = f.files[0]!;
    if (reason === "missing") await rm(file);
    else {
      const rows = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      if (reason === "unclosed") rows.pop();
      if (reason === "unresolved") rows[2].outcome = "uncertain";
      if (reason === "foreign-project") rows[0].projectId = "22222222-2222-4222-8222-222222222222";
      if (reason === "bad-total") rows.at(-1).admittedBytes = 0;
      if (reason === "bad-expanded-total") rows.at(-1).admittedExpandedBytes = 0;
      if (reason === "missing-record-count") delete rows[1].recordCount;
      if (reason === "duplicate-outcome") rows.splice(3, 0, rows[2]);
      await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    }
    const usage = await collectScheduledIngestion(f.input);
    expect(usage).toMatchObject({ status: "incomplete", totalAdmittedPayloadBytes: null, billedCostUsd: null });
    expect(usage.observedAdmittedPayloadBytes).toBeGreaterThan(0);
    expect(usage.receipts[0]!.status).not.toBe("complete");
    expect(usage.receipts.slice(1).every(row => row.status === "complete")).toBe(true);
  });

it("binds the expected receipt set to admitted attempts and retains unstarted selections", async () => {
  const f = await fixture();
  expect(await collectScheduledIngestion({ ...f.input, executionIds: [...f.input.executionIds, "missing.local"] }))
    .toMatchObject({ status: "incomplete", missingExecutions: ["missing.local"], totalAdmittedPayloadBytes: null });
  await expect(collectScheduledIngestion({ ...f.input, executionIds: [] })).rejects.toThrow("selection");
  await expect(collectScheduledIngestion({ ...f.input, executionIds: ["foreign.local"] })).rejects.toThrow("Foreign ingestion attempt");
  await expect(collectScheduledIngestion({ ...f.input, campaignId: "foreign" })).rejects.toThrow("campaign mismatch");
});

it("keeps historical native receipts with the larger policy limits readable", async () => {
  const f = await fixture(), file = f.files[0]!;
  const rows = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  rows[0].limits.maxExpandedBytes = 256 * 1024 * 1024;
  rows[0].limits.maxRecords = 16_384;
  await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  expect(await collectScheduledIngestion(f.input)).toMatchObject({ status: "complete",
    totalAdmittedPayloadBytes: f.expectedBytes, billedCostUsd: null });
});

it("keeps version 1 transport receipts readable without inventing expanded data measurements", async () => {
  const f = await fixture(), file = f.files[0]!;
  const rows = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  rows[0].version = 1; delete rows[0].sizing;
  delete rows[0].limits.maxExpandedBytes; delete rows[0].limits.maxRecords;
  for (const row of rows) {
    delete row.expandedBytes; delete row.recordCount;
    delete row.admittedExpandedBytes; delete row.admittedRecords;
  }
  await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const usage = await collectScheduledIngestion(f.input);
  expect(usage).toMatchObject({ status: "complete", billedCostUsd: null });
  expect(usage.receipts[0]).toMatchObject({ admittedPayloadBytes: 2, admittedExpandedSourceBytes: null, admittedRecords: null });
});

it.each(["outcome", "closed"])("retains the verified prefix and digest when the final %s line is truncated", async kind => {
  const f = await fixture(), file = f.files[0]!;
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  const prefix = lines.slice(0, kind === "outcome" ? 2 : 3);
  const truncated = prefix.join("\n") + '\n{"type":"' + kind;
  await writeFile(file, truncated);
  const usage = await collectScheduledIngestion(f.input);
  expect(usage).toMatchObject({ status: "incomplete", observedAdmittedPayloadBytes: f.expectedBytes, totalAdmittedPayloadBytes: null });
  expect(usage.receipts[0]).toMatchObject({ status: "incomplete", admittedRequests: 1, admittedPayloadBytes: 2,
    unresolvedRequests: kind === "outcome" ? 1 : 0, receiptSha256: createHash("sha256").update(truncated).digest("hex") });
});
