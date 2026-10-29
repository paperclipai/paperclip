import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeScheduledCampaign } from "./scheduled-finalization.js";
import { verifyBraintrustGatewayIndexing } from "./braintrust-gateway-indexing.js";
import { runnerMatrix } from "./catalog.js";
import { buildRunnerCampaign } from "./history.js";
import { emptyFeedbackSummary } from "./feedback.js";
import type { RunnerE2EResult } from "./types.js";

vi.mock("./braintrust-gateway-indexing.js", () => ({ verifyBraintrustGatewayIndexing: vi.fn() }));
vi.mock("./braintrust-indexing.js", () => ({ verifyBraintrustIndexing: vi.fn(async () => ({ status: "verified" })) }));
vi.mock("./ingestion-usage.js", () => ({ collectScheduledIngestion: vi.fn(async () => ({ status: "complete" })) }));
vi.mock("./experiment-ingestion.js", () => ({ openExperimentIngestion: vi.fn(async () => ({ transport: vi.fn(), close: async () => {} })) }));
vi.mock("./braintrust-experiment.js", async importOriginal => ({ ...await importOriginal<typeof import("./braintrust-experiment.js")>(), importBraintrustExperiment: vi.fn() }));
const directories: string[] = [];
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it.each(["verified", "incomplete", "unavailable"] as const)("retains %s gateway coverage independently of native indexing", async status => {
  const workspace = await mkdtemp(path.join(tmpdir(), "scheduled-gateway-index-")); directories.push(workspace);
  const directory = path.join(workspace, "tests/runner-e2e/results/scheduled"), manifestPath = path.join(directory, "manifest.json");
  const campaignId = "scheduled-gateway-fixture", projectId = "11111111-1111-4111-8111-111111111111";
  const cell = runnerMatrix.find(row => row.id === "core-compatibility.runner-acpx-claude.local.message-marker")!;
  const root = path.join(workspace, "tests/runner-e2e/results", campaignId), resultPath = path.join(root, ...cell.id.split("."), "attempt-1");
  await mkdir(directory, { recursive: true }); await mkdir(resultPath, { recursive: true });
  const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: cell.id,
    suiteId: cell.suite.id, suiteDefinitionHash: cell.suiteDefinitionHash,
    accountingIdentity: { campaignId, attemptId: "one" }, source: { sha: "a".repeat(40), ref: null, workflowRunUrl: null },
    attempt: 1, status: "passed", cleanup: "passed", profileId: cell.profile.id, caseId: cell.task.id,
    environmentId: cell.environment.id, provider: cell.profile.provider, model: cell.profile.model, runtimeMode: cell.profile.expectedRuntimeMode,
    startedAt: "2026-10-24T00:00:00.000Z", finishedAt: "2026-10-24T00:00:01.000Z", durationMs: 1000,
    feedback: { ...emptyFeedbackSummary(), collection: "complete", invocationCollection: "complete" },
    tracing: { projectId, traceId: "a".repeat(32), spanId: "b".repeat(16), status: "accepted", verification: "unverified", nativeConfiguration: "configured",
      finalization: { spanId: "c".repeat(16), status: "accepted", outcome: "passed", verification: "unverified" } } };
  const campaign = buildRunnerCampaign({ campaignId, generatedAt: result.finishedAt, expected: [cell.id], results: [result], attempts: [result] });
  const ledgerPath = path.join(directory, "ledger.jsonl");
  await writeFile(manifestPath, JSON.stringify({ limits: { campaignId }, ledgerPath, executionIds: [cell.id], projectId, route: "braintrust",
    models: [{ provider: "anthropic", price: { model: cell.profile.model } }] }));
  await writeFile(path.join(root, "campaign.json"), JSON.stringify(campaign));
  await writeFile(path.join(resultPath, "result.json"), JSON.stringify(result));
  const indexReceipt = { version: 1 as const, projectId, campaignId, checkedAt: result.finishedAt,
    ledgerCheckpoint: "d".repeat(64), status, expectedRequests: 2, verifiedRequests: status === "verified" ? 2 : 1, requests: [] };
  vi.mocked(verifyBraintrustGatewayIndexing).mockResolvedValue(indexReceipt);
  const findings = await finalizeScheduledCampaign({ GITHUB_WORKSPACE: workspace, PAPERCLIP_E2E_OPERATIONS_MANIFEST: manifestPath,
    PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID: projectId, BRAINTRUST_API_KEY: "private-key-canary" });
  expect(findings.includes("gateway_indexing_incomplete")).toBe(status !== "verified");
  expect(findings).not.toContain("trace_or_experiment_indexing_incomplete");
  expect(JSON.parse(await readFile(path.join(directory, "gateway-indexing-receipt.json"), "utf8"))).toEqual(indexReceipt);
  expect(JSON.parse(await readFile(path.join(directory, "findings.json"), "utf8"))).toMatchObject({ nativeIndexVerification: "verified", gatewayIndexVerification: status });
  expect(verifyBraintrustGatewayIndexing).toHaveBeenCalledWith(expect.objectContaining({ projectId }), {
    ledgerPath, campaignId, expected: [{ executionId: cell.id, provider: "anthropic", model: cell.profile.model }],
  });
});
