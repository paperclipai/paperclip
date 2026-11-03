import { expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBraintrustExperiment, experimentEvidenceHash, importBraintrustExperiment, renderBraintrustExperiment, type BraintrustExperimentReceipt } from "./braintrust-experiment.js";
import { regenerateRunnerDashboard } from "./dashboard-regenerate.js";
import { buildRunnerCampaign } from "./history.js";
import { runnerMatrix } from "./catalog.js";
import { emptyFeedbackSummary } from "./feedback.js";
import { openExperimentIngestion } from "./experiment-ingestion.js";
import type { RunnerE2ECampaign, RunnerE2EResult } from "./types.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const experimentId = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const cell = runnerMatrix.find(cell => cell.id === "core-compatibility.runner-codex.local.message-marker")!;
  const first: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: cell.id,
    suiteId: cell.suite.id, suiteDefinitionHash: cell.suiteDefinitionHash,
    accountingIdentity: { campaignId: "retained-pilot", attemptId: "first" }, source: { sha: "a".repeat(40), ref: null, workflowRunUrl: null },
    attempt: 1, status: "failed", cleanup: "passed", profileId: cell.profile.id, caseId: cell.task.id,
    environmentId: cell.environment.id, provider: cell.profile.provider, model: cell.profile.model, runtimeMode: cell.profile.expectedRuntimeMode,
    startedAt: "2026-10-20T00:00:00.000Z", finishedAt: "2026-10-20T00:00:01.000Z", durationMs: 1000,
    error: "private-canary-error", usage: { privateCanary: "private-canary-usage" }, feedback: emptyFeedbackSummary() };
  const second: RunnerE2EResult = { ...structuredClone(first), source: { ...first.source!, sha: "b".repeat(40) },
    accountingIdentity: { campaignId: "retained-pilot", attemptId: "second" }, attempt: 2, status: "passed", error: undefined,
    startedAt: "2026-10-20T00:01:00.000Z", finishedAt: "2026-10-20T00:01:01.000Z",
    tracing: { projectId, traceId: "c".repeat(32), spanId: "d".repeat(16), status: "accepted", verification: "unverified", nativeConfiguration: "configured" } };
  const originals = [first, second];
  const campaign = buildRunnerCampaign({ campaignId: "retained-pilot", generatedAt: second.finishedAt,
    expected: [cell.id], results: [second], attempts: originals });
  return { campaign, originals };
}

it("imports all attempts with their own source and original grades, excluding private evidence and duplicate cost metrics", () => {
  const { campaign, originals } = fixture();
  const plan = buildBraintrustExperiment(projectId, campaign, originals);
  expect(plan.events).toHaveLength(2);
  expect(plan.events.map(row => row.scores.product_pass).sort()).toEqual([0, 1]);
  expect(plan.events.map(row => row.input.source_revision).sort()).toEqual(["a".repeat(40), "b".repeat(40)]);
  expect(JSON.stringify(plan)).not.toMatch(/private-canary|estimated_cost|prompt_tokens/);
  expect(plan.events.every(row => row.metadata.request_ledger === null)).toBe(true);
  expect(plan.events.find(row => row.metadata.attempt_id === "second")!.metadata.trace).toMatchObject({ root_span_id: "c".repeat(32) });
  expect(buildBraintrustExperiment(projectId, { ...campaign, generatedAt: "2026-10-21T00:00:00Z" }, [...originals].reverse())).toEqual(plan);
  expect(buildBraintrustExperiment(projectId, campaign, [...originals, originals[0]!])).toEqual(plan);
});

it("imports retained grades through the scheduled transport allowance without changing the evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bounded-experiment-import-"));
  const { campaign, originals } = fixture(), before = structuredClone({ campaign, originals });
  const plan = buildBraintrustExperiment(projectId, campaign, originals), receiptPath = path.join(root, "ingestion.jsonl");
  const meter = await openExperimentIngestion({ projectId, campaignId: campaign.campaignId, receiptPath, deadlineAt: Date.now() + 60_000,
    transport: async (url, init) => String(url).endsWith("/experiment")
      ? Response.json({ ...JSON.parse(String(init!.body)), id: experimentId })
      : String(url).endsWith("/insert") ? Response.json({ row_ids: plan.events.map(row => row.id) }) : Response.json({}) });
  try {
    expect(await importBraintrustExperiment({ projectId, apiKey: "private-fixture" }, campaign, originals, async () => {}, meter.transport))
      .toMatchObject({ status: "accepted", acceptedRows: 2, expectedRows: 2 });
    await meter.close();
    const rows = (await readFile(receiptPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows.at(-1)).toMatchObject({ admittedRequests: 3, admittedScores: 4, unresolvedRequests: 0 });
    expect({ campaign, originals }).toEqual(before);
  } finally { await meter.close(); await rm(root, { recursive: true, force: true }); }
});

it.each(["missing", "foreign", "modified-grade", "ambiguous-source", "missing-source", "foreign-trace", "missing-hash"])("rejects %s evidence before network requests", async (kind) => {
  const { campaign, originals } = fixture();
  if (kind === "missing") originals.pop();
  if (kind === "foreign") originals[0]!.accountingIdentity!.campaignId = "other";
  if (kind === "modified-grade") originals[0]!.status = "passed";
  if (kind === "ambiguous-source") originals.push({ ...originals[0]!, source: { ...originals[0]!.source!, sha: "c".repeat(40) } });
  if (kind === "missing-source") originals[0]!.source = undefined;
  if (kind === "foreign-trace") originals[1]!.tracing!.projectId = experimentId;
  if (kind === "missing-hash") originals[0]!.suiteDefinitionHash = undefined;
  const transport = vi.fn<typeof fetch>();
  await expect(importBraintrustExperiment({ projectId, apiKey: "key" }, campaign, originals, async () => {}, transport)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it("changes experiment identity for changed evidence while keeping unknown accounting unknown", () => {
  const { campaign, originals } = fixture();
  const before = buildBraintrustExperiment(projectId, campaign, originals);
  campaign.accounting!.missingAttempts = 1;
  const after = buildBraintrustExperiment(projectId, campaign, originals);
  expect(after.payloadHash).not.toBe(before.payloadHash);
  expect(after.metadata.request_ledger).toBeNull();
  expect(after.metadata.missing_attempts).toBe(1);
});

it("imports carried-forward receipts with their original campaign, revision, and grades", () => {
  const { campaign, originals } = fixture();
  const report = { ...campaign, campaignId: "later-ci-attempt" };
  const before = structuredClone(originals);
  const plan = buildBraintrustExperiment(projectId, report, originals);
  expect(plan.metadata.campaign_id).toBe("later-ci-attempt");
  expect(plan.events.every(row => row.metadata.campaign_id === "retained-pilot")).toBe(true);
  expect(plan.events.map(row => row.input.source_revision).sort()).toEqual(["a".repeat(40), "b".repeat(40)]);
  expect(plan.events.map(row => row.scores.product_pass).sort()).toEqual([0, 1]);
  expect(plan.events.map(row => row.id)).toEqual(buildBraintrustExperiment(projectId, campaign, originals).events.map(row => row.id));
  expect(originals).toEqual(before);
  const wrong = structuredClone(originals);
  wrong[0]!.accountingIdentity!.campaignId = report.campaignId;
  expect(() => buildBraintrustExperiment(projectId, report, wrong)).toThrow();
});

it("imports original grades when report evidence validation changes the selected outcome", () => {
  const { campaign, originals } = fixture();
  const adjusted = structuredClone(campaign);
  adjusted.results[0]!.status = "failed";
  adjusted.results[0]!.error = "Missing final-state.png";
  const plan = buildBraintrustExperiment(projectId, adjusted, originals);
  expect(plan.events.find(row => row.metadata.attempt_id === "second")!.scores.product_pass).toBe(1);
  expect(plan).toEqual(buildBraintrustExperiment(projectId, campaign, originals));
  expect(adjusted.results[0]!.status).toBe("failed");
  const changed = structuredClone(originals);
  changed[1]!.status = "failed";
  expect(() => buildBraintrustExperiment(projectId, adjusted, changed)).toThrow();
});

it("accepts current catalog model names including Cursor qualification parameters", () => {
  for (const model of new Set(runnerMatrix.map(cell => cell.profile.model))) {
    const { campaign, originals } = fixture();
    const changed = originals.map(original => ({ ...original, model }));
    const selected = { ...campaign, results: campaign.results.map(result => ({ ...result, model })) };
    const plan = buildBraintrustExperiment(projectId, selected, changed);
    expect(plan.events.every(row => row.input.model === model)).toBe(true);
  }
});

it.each(["", "model\nprivate", "model\u0000private", "model<private>", "a".repeat(257)])("rejects malformed model names %j", model => {
  const { campaign, originals } = fixture();
  expect(() => buildBraintrustExperiment(projectId, campaign, originals.map(result => ({ ...result, model })))).toThrow();
});

it("keeps precise ledger amounts and reservations separate from trace metrics and unobserved attempts", () => {
  const { campaign, originals } = fixture();
  campaign.operations = { version: 1, scope: "shared_gateway_ledger", ledgerCampaignId: campaign.campaignId,
    journalHash: "c".repeat(64), records: 5, deadlineAt: "2026-10-21T01:00:00Z", limitUsd: "100.000000000",
    knownUsd: "0.000000001", heldUsd: "4.000000000", committedUsd: "4.000000001", requests: 1,
    unresolvedRequests: 1, conflictingRequests: 0, inflight: 0,
    breakdown: { estimated: "0.000000001", reported: "0.000000000", reconciled: "0.000000000", allocated: "0.000000000" },
    attempts: [{ executionId: originals[0]!.executionId, attemptId: "first", requests: 1, unresolvedRequests: 1,
      knownUsd: "0.000000001", heldUsd: "4.000000000" }] };
  const plan = buildBraintrustExperiment(projectId, campaign, originals);
  expect(plan.metadata.request_ledger).toMatchObject({ known_usd: "0.000000001", additional_held_usd: "4.000000000" });
  expect(plan.events.find(row => row.metadata.attempt_id === "first")!.metadata.request_ledger).toMatchObject({ unresolved_requests: 1 });
  expect(plan.events.find(row => row.metadata.attempt_id === "second")!.metadata.request_ledger).toBeNull();
  expect(plan.events.every(row => Object.keys(row.metrics).sort().join() === "end,start")).toBe(true);
  const carried = buildBraintrustExperiment(projectId, {
    ...campaign, campaignId: "later-ci-attempt",
    operations: { ...campaign.operations, ledgerCampaignId: "later-ci-attempt" },
  }, originals);
  expect(carried.metadata.request_ledger).toMatchObject({ requests: 1 });
  expect(carried.events.every(row => row.metadata.request_ledger === null)).toBe(true);
});

function receiver(campaign: ReturnType<typeof fixture>["campaign"], originals: RunnerE2EResult[]) {
  const plan = buildBraintrustExperiment(projectId, campaign, originals);
  return vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url).startsWith("https://api.braintrust.dev/v1/")).toBe(true);
    expect(init?.redirect).toBe("error");
    if (String(url).endsWith("/summarize")) return Response.json({ experiment_name: plan.name,
      project_url: "https://www.braintrust.dev/app/Example/p/Evals", experiment_url: `https://www.braintrust.dev/app/Example/p/Evals/experiments/${plan.name}` });
    const sent = JSON.parse(String(init?.body));
    if (String(url).endsWith("/experiment")) {
      expect(sent).toMatchObject({ public: false, ensure_new: false, project_id: projectId, name: plan.name });
      return Response.json({ ...sent, id: experimentId });
    }
    return Response.json({ row_ids: sent.events.map((row: { id: string }) => row.id) });
  });
}

it("retries identical evidence using the same private experiment and stable row IDs without invoking agents", async () => {
  const { campaign, originals } = fixture();
  const transport = receiver(campaign, originals), receipts: BraintrustExperimentReceipt[] = [];
  for (let i = 0; i < 2; i++) await importBraintrustExperiment({ projectId, apiKey: "private-key" }, campaign, originals,
    async receipt => { receipts.push(receipt); }, transport);
  expect(receipts.map(receipt => receipt.status)).toEqual(["created", "accepted", "accepted", "created", "accepted", "accepted"]);
  expect(receipts[2]).toEqual(receipts[5]);
  expect(receipts[1]).toMatchObject({ acceptedRows: 2, expectedRows: 2, verification: "unverified" });
  expect(transport.mock.calls[0]![1]!.body).toBe(transport.mock.calls[3]![1]!.body);
  expect(transport.mock.calls[1]![1]!.body).toBe(transport.mock.calls[4]![1]!.body);
});

it("preserves an evidence-bound experiment link through report regeneration and rejects stale or unsafe links", async () => {
  const { campaign, originals } = fixture();
  const receipt = await importBraintrustExperiment({ projectId, apiKey: "key" }, campaign, originals, async () => {}, receiver(campaign, originals));
  campaign.braintrustExperiment = receipt;
  const root = await mkdtemp(path.join(tmpdir(), "experiment-report-"));
  try {
    await writeFile(path.join(root, "normalized-results.json"), JSON.stringify(campaign));
    await regenerateRunnerDashboard({ bundle: root, historyFile: null });
    expect(JSON.parse(await readFile(path.join(root, "normalized-results.json"), "utf8")).braintrustExperiment).toEqual(receipt);
    expect(await readFile(path.join(root, "dashboard.html"), "utf8")).toContain(receipt.experimentUrl);
    expect(() => renderBraintrustExperiment({ ...campaign, braintrustExperiment: { ...receipt, experimentUrl: "https://untrusted.example/app/secret" } })).toThrow();
    expect(() => renderBraintrustExperiment({ ...campaign, braintrustExperiment: { ...receipt, privateNote: "private-canary" } as never })).toThrow();
    campaign.accounting!.missingAttempts++;
    expect(() => renderBraintrustExperiment(campaign)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rebuilds a report with a missing cell and its saved experiment without rerunning retained attempts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "experiment-missing-report-"));
  const repositoryRoot = path.resolve(import.meta.dirname, "../..");
  const original = fixture().originals[1]!;
  const missing = runnerMatrix.find(cell => cell.id !== original.executionId)!;
  const input = path.join(root, "input"), attempt = path.join(input, "attempt");
  const receiptPath = path.join(root, "experiment.json");
  async function report(output: string, savedReceipt?: string) {
    const result = await promisify(execFile)(process.execPath,
      [path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"), path.join(repositoryRoot, "tests/runner-e2e/report.ts")], {
        cwd: repositoryRoot,
        env: { ...process.env, PAPERCLIP_RUNNER_E2E_REPORT_ROOT: input, PAPERCLIP_RUNNER_E2E_REPORT_OUT: output,
          PAPERCLIP_E2E_CAMPAIGN_ID: "retained-pilot", PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([original.executionId, missing.id]),
          PAPERCLIP_E2E_BRAINTRUST_EXPERIMENT: savedReceipt },
      }).catch(error => error as { code: number; stderr: string });
    // Missing coverage still fails the campaign, but must not prevent rendering it.
    expect(result).toMatchObject({ code: 1 });
    expect(result.stderr).not.toContain("Invalid retained experiment evidence");
    return JSON.parse(await readFile(path.join(output, "normalized-results.json"), "utf8")) as RunnerE2ECampaign;
  }
  try {
    await mkdir(attempt, { recursive: true });
    const raw = JSON.stringify(original);
    await writeFile(path.join(attempt, "result.json"), raw);
    await writeFile(path.join(attempt, "final-state.png"), "fixture-png");
    await writeFile(path.join(attempt, "evidence-manifest.json"), JSON.stringify({ files: ["final-state.png"], leaks: [], missing: [] }));
    const before = await report(path.join(root, "before"));
    const receipt = await importBraintrustExperiment({ projectId, apiKey: "fixture-key" }, before, [original], async () => {}, receiver(before, [original]));
    await writeFile(receiptPath, JSON.stringify(receipt));
    const after = await report(path.join(root, "after"), receiptPath);
    expect(after.results.find(result => result.attempt === 0)!.startedAt).not.toBe(before.results.find(result => result.attempt === 0)!.startedAt);
    expect(after.braintrustExperiment).toEqual(receipt);
    expect(after.accounting).toEqual(before.accounting);
    expect(await readFile(path.join(root, "after", "index.html"), "utf8")).toContain(receipt.experimentUrl);
    expect(await readFile(path.join(attempt, "result.json"), "utf8")).toBe(raw);
    const changed = structuredClone(after);
    changed.results.find(result => result.attempt > 0)!.startedAt = "2026-10-20T00:00:30.000Z";
    expect(() => renderBraintrustExperiment(changed)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("checkpoints accepted batches before a later insert fails", async () => {
  const base = fixture().originals[0]!;
  const originals = Array.from({ length: 101 }, (_, i) => ({ ...base, attempt: i + 1,
    accountingIdentity: { campaignId: "retained-pilot", attemptId: `attempt-${i}` } }));
  const campaign = buildRunnerCampaign({ campaignId: "retained-pilot", generatedAt: base.finishedAt,
    expected: [base.executionId], results: [originals[100]!], attempts: originals });
  const normal = receiver(campaign, originals), receipts: BraintrustExperimentReceipt[] = [];
  let calls = 0;
  await expect(importBraintrustExperiment({ projectId, apiKey: "key" }, campaign, originals,
    async receipt => { receipts.push(receipt); }, async (url, init) => {
      if (++calls === 3) throw new Error("private-network-error");
      return normal(url, init);
    })).rejects.toThrow("Remote details withheld");
  expect(receipts).toHaveLength(2);
  expect(receipts[1]).toMatchObject({ status: "created", acceptedRows: 100, expectedRows: 101 });
  const previous = structuredClone(receipts[1]!);
  calls = 0;
  await expect(importBraintrustExperiment({ projectId, apiKey: "key" }, campaign, originals,
    async receipt => { receipts.push(receipt); }, async (url, init) => {
      if (++calls === 2) throw new Error("retry insert failed");
      return normal(url, init);
    }, previous)).rejects.toThrow("Remote details withheld");
  expect(receipts).toHaveLength(2);
  expect(receipts.at(-1)).toEqual(previous);
  await importBraintrustExperiment({ projectId, apiKey: "key" }, campaign, originals,
    async receipt => { receipts.push(receipt); }, normal, previous);
  expect(receipts.slice(2).map(receipt => receipt.acceptedRows)).toEqual([100, 101, 101]);
  expect(receipts.at(-1)!.status).toBe("accepted");
});

it.each(["source", "definition"])("rejects a saved link and original import after selected %s provenance changes", async kind => {
  const { campaign, originals } = fixture();
  const receipt = await importBraintrustExperiment({ projectId, apiKey: "key" }, campaign, originals, async () => {}, receiver(campaign, originals));
  const changed = structuredClone(campaign);
  changed.braintrustExperiment = receipt;
  if (kind === "source") changed.results[0]!.source!.sha = "e".repeat(40);
  else changed.results[0]!.suiteDefinitionHash = "f".repeat(64);
  expect(() => renderBraintrustExperiment(changed)).toThrow();
  expect(() => buildBraintrustExperiment(projectId, changed, originals)).toThrow();
  expect(buildBraintrustExperiment(projectId, campaign, originals).events.map(row => row.input.source_revision).sort())
    .toEqual(["a".repeat(40), "b".repeat(40)]);
});

it("propagates a failed receipt save after successful summary lookup while retaining the accepted checkpoint", async () => {
  const { campaign, originals } = fixture(), receipts: BraintrustExperimentReceipt[] = [];
  await expect(importBraintrustExperiment({ projectId, apiKey: "key" }, campaign, originals, async receipt => {
    if (receipt.experimentUrl) throw new Error("disk write failed");
    receipts.push(receipt);
  }, receiver(campaign, originals))).rejects.toThrow("import incomplete");
  expect(receipts.at(-1)).toMatchObject({ status: "accepted", acceptedRows: 2 });
  expect(receipts.at(-1)!.experimentUrl).toBeUndefined();
});

it("rejects conflicting retry receipts before overwriting saved evidence", async () => {
  const { campaign, originals } = fixture();
  const receipt = await importBraintrustExperiment({ projectId, apiKey: "key" }, campaign, originals, async () => {}, receiver(campaign, originals));
  const persist = vi.fn(), transport = vi.fn<typeof fetch>();
  await expect(importBraintrustExperiment({ projectId, apiKey: "key" }, campaign, originals, persist, transport,
    { ...receipt, projectId: experimentId })).rejects.toThrow();
  expect(persist).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it.each(["public", "wrong-project", "wrong-hash", "partial-insert", "receiver-error", "oversized"])("retains safe incomplete status for %s", async kind => {
  const { campaign, originals } = fixture(), receipts: BraintrustExperimentReceipt[] = [];
  const normal = receiver(campaign, originals);
  const transport: typeof fetch = async (url, init) => {
    const response = await normal(url, init), value = await response.json() as Record<string, unknown>;
    if (String(url).endsWith("/experiment")) {
      if (kind === "public") value.public = true;
      if (kind === "wrong-project") value.project_id = experimentId;
      if (kind === "wrong-hash") value.metadata = { payload_hash: "a".repeat(64) };
      if (kind === "oversized") return new Response("x".repeat(1_048_577));
    } else {
      if (kind === "partial-insert") value.row_ids = [];
      if (kind === "receiver-error") return new Response("private-upstream-failure", { status: 503 });
    }
    return Response.json(value);
  };
  await expect(importBraintrustExperiment({ projectId, apiKey: "private-key" }, campaign, originals,
    async receipt => { receipts.push(receipt); }, transport)).rejects.toThrow("Remote details withheld");
  expect(receipts.some(receipt => receipt.status === "accepted")).toBe(false);
  expect(JSON.stringify(receipts)).not.toMatch(/private-key|private-upstream/);
  if (["partial-insert", "receiver-error"].includes(kind)) expect(receipts[0]).toMatchObject({ status: "created", acceptedRows: 0 });
});


it("preserves retained experiment identity when adding journal-derived token presentation", async () => {
  const { openEvalCostLedger } = await import("./cost-ledger.js");
  const { readEvalOperationsReport } = await import("./operations-report.js");
  const { campaign, originals } = fixture();
  const root = await mkdtemp(path.join(tmpdir(), "experiment-token-presentation-")), file = path.join(root, "ledger.jsonl");
  const ledger = await openEvalCostLedger(file, { campaignId: campaign.campaignId, maxUsd: "1", deadlineAt: "2099-01-01T00:00:00Z", maxRequests: 2, maxConcurrent: 1 });
  try {
    await ledger.reserve("setup", { executionId: originals[0]!.executionId, attemptId: "first", phase: "setup" }, "0.2");
    await ledger.observe({ observationId: "usage", requestId: "setup", provider: "fixture", source: "gateway", currency: "USD", route: "direct", classification: "reported", costUsd: "0.05", final: true,
      tokens: { input: 1, cachedRead: 2, cachedWrite: 3, output: 4 } });
    await ledger.finish("setup", "cancelled");
    const enriched = await readEvalOperationsReport(file);
    if (enriched.status === "unavailable") throw new Error("Expected token report");
    campaign.operations = structuredClone(enriched);
    delete campaign.operations.modelAccounting!.tokenUsage;
    const legacyHash = experimentEvidenceHash(campaign);
    const receipt = await importBraintrustExperiment({ projectId, apiKey: "key" }, campaign, originals, async () => {}, receiver(campaign, originals));
    campaign.braintrustExperiment = receipt;
    campaign.operations = enriched;
    expect(experimentEvidenceHash(campaign)).toBe(legacyHash);
    expect(renderBraintrustExperiment(campaign)).toContain("2/2 rows accepted");
    campaign.operations.journalHash = "f".repeat(64);
    expect(() => renderBraintrustExperiment(campaign)).toThrow("Invalid retained");
  } finally { await ledger.close(); await rm(root, { recursive: true, force: true }); }
});
