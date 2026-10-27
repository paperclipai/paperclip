import { expect, it, vi } from "vitest";
import { buildBraintrustExperiment, experimentEvidenceHash, type BraintrustExperimentReceipt } from "./braintrust-experiment.js";
import { braintrustTraceIndexQuery, verifyBraintrustIndexing } from "./braintrust-indexing.js";
import { buildRunnerCampaign } from "./history.js";
import { runnerMatrix } from "./catalog.js";
import { emptyFeedbackSummary } from "./feedback.js";
import type { RunnerE2EResult } from "./types.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const config = { projectId, apiKey: "private-key-canary" };
const aggregate = { records: 2500, roots: 1, finalizations: 1, native_api_records: 2, complaints: 1, suggestions: 1 };

function fixture(profile = "runner-codex") {
  const cell = runnerMatrix.find(row => row.id === `feedback-persistence.${profile}.local.complaint-and-suggestion`)!;
  const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: cell.id,
    suiteId: cell.suite.id, suiteDefinitionHash: cell.suiteDefinitionHash,
    accountingIdentity: { campaignId: "indexed-pilot", attemptId: "first" }, source: { sha: "a".repeat(40), ref: null, workflowRunUrl: null },
    attempt: 1, status: "passed", cleanup: "passed", profileId: cell.profile.id, caseId: cell.task.id,
    environmentId: cell.environment.id, provider: cell.profile.provider, model: cell.profile.model, runtimeMode: cell.profile.expectedRuntimeMode,
    startedAt: "2026-10-20T00:00:00.000Z", finishedAt: "2026-10-20T00:00:01.000Z", durationMs: 1000,
    feedback: { ...emptyFeedbackSummary(), collection: "complete", invocationCollection: "complete", complaints: 1, suggestions: 1 },
    tracing: { projectId, traceId: "a".repeat(32), spanId: "b".repeat(16), status: "accepted", verification: "unverified", nativeConfiguration: "configured",
      finalization: { spanId: "c".repeat(16), status: "accepted", outcome: "passed", verification: "unverified" } } };
  const originals = [result];
  const campaign = buildRunnerCampaign({ campaignId: "indexed-pilot", generatedAt: result.finishedAt, expected: [cell.id], results: originals, attempts: originals });
  const plan = buildBraintrustExperiment(projectId, campaign, originals);
  const experiment: BraintrustExperimentReceipt = { version: 1, projectId, experimentId: "22222222-2222-4222-8222-222222222222", name: plan.name,
    payloadHash: plan.payloadHash, evidenceHash: experimentEvidenceHash(campaign), status: "accepted", acceptedRows: 1, expectedRows: 1, verification: "unverified" };
  return { originals, campaign, plan, experiment };
}

it.each(["runner-codex", "runner-acpx-claude"])("verifies %s native records and original experiment grades without fetching content", async profile => {
  const { originals, campaign, plan, experiment } = fixture(profile);
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [aggregate] })).mockResolvedValueOnce(Response.json({ data: plan.events }));
  const receipt = await verifyBraintrustIndexing(config, campaign, originals, experiment, transport);
  expect(receipt.status).toBe("verified");
  expect(receipt.traces[0]).toMatchObject({ records: 2500, nativeApiRecords: 2, complaints: 1 });
  expect(receipt.experiment.indexedRows).toBe(1);
  expect(transport).toHaveBeenCalledTimes(2);
  const sql = JSON.parse(String(transport.mock.calls[0]![1]!.body)).query;
  expect(sql).toContain(`root_span_id = '${"a".repeat(32)}'`);
  expect(sql).toContain(profile === "runner-codex" ? "codex.api_request" : "claude_code.llm_request");
  expect(sql).not.toMatch(/arguments|prompt|response|tool_input|tool_result_size/);
  expect(JSON.stringify(receipt)).not.toContain(config.apiKey);
});

it.each(["roots", "finalizations", "native_api_records", "complaints", "suggestions"])("does not pass a trace missing %s", async missing => {
  const { originals, campaign, plan, experiment } = fixture();
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [{ ...aggregate, [missing]: 0 }] })).mockResolvedValueOnce(Response.json({ data: plan.events }));
  const receipt = await verifyBraintrustIndexing(config, campaign, originals, experiment, transport, { rounds: 1 });
  expect(receipt.status).toBe("incomplete");
  expect(receipt.experiment.status).toBe("verified");
});

it("retries delayed indexing without re-querying already verified records", async () => {
  const { originals, campaign, plan, experiment } = fixture();
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [{ ...aggregate, roots: 0 }] }))
    .mockResolvedValueOnce(Response.json({ data: plan.events })).mockResolvedValueOnce(Response.json({ data: [aggregate] }));
  const pause = vi.fn(async () => {});
  const receipt = await verifyBraintrustIndexing(config, campaign, originals, experiment, transport, { pause });
  expect(receipt.status).toBe("verified");
  expect(transport).toHaveBeenCalledTimes(3);
  expect(pause).toHaveBeenCalledTimes(1);
});

it("treats an empty aggregate as missing indexing, without inventing native activity", async () => {
  const { originals, campaign, plan, experiment } = fixture();
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [{ records: 0, roots: null,
    finalizations: null, native_api_records: null, complaints: null, suggestions: null }] })).mockResolvedValueOnce(Response.json({ data: plan.events }));
  const receipt = await verifyBraintrustIndexing(config, campaign, originals, experiment, transport, { rounds: 1 });
  expect(receipt.status).toBe("incomplete");
  expect(receipt.traces[0]).toMatchObject({ status: "incomplete", records: 0, nativeApiRecords: 0 });
});

it.each(["missing", "extra", "duplicate", "grade-changed", "wrong-revision", "wrong-attempt"])("rejects %s indexed experiment evidence", async fault => {
  const { originals, campaign, plan, experiment } = fixture();
  const rows = structuredClone(plan.events);
  if (fault === "missing") rows.pop();
  if (fault === "extra") rows.push({ ...rows[0]!, id: "other" });
  if (fault === "duplicate") rows.push(rows[0]!);
  if (fault === "grade-changed") rows[0]!.scores.product_pass = 0;
  if (fault === "wrong-revision") rows[0]!.input.source_revision = "b".repeat(40);
  if (fault === "wrong-attempt") rows[0]!.metadata.attempt_id = "other";
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [aggregate] })).mockResolvedValueOnce(Response.json({ data: rows }));
  const receipt = await verifyBraintrustIndexing(config, campaign, originals, experiment, transport, { rounds: 1 });
  expect(receipt.status).toBe("incomplete");
  expect(receipt.traces[0]!.status).toBe("verified");
});

it.each(["rejected", "malformed", "oversized", "invalid-counts"])("retains %s query failures without raw error content", async fault => {
  const { originals, campaign, experiment } = fixture();
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => fault === "rejected" ? new Response("private-response-canary", { status: 401 })
    : fault === "malformed" ? new Response("private-response-canary")
      : fault === "oversized" ? new Response("private-response-canary".repeat(100_000))
        : Response.json({ data: [{ ...aggregate, records: -1 }] }));
  const receipt = await verifyBraintrustIndexing(config, campaign, originals, experiment, transport, { rounds: 1 });
  expect(receipt.status).toBe("unavailable");
  expect(JSON.stringify(receipt)).not.toMatch(/private-response-canary|private-key-canary/);
});

it("honors cancellation before making a query", async () => {
  const { originals, campaign, experiment } = fixture();
  const transport = vi.fn<typeof fetch>();
  const receipt = await verifyBraintrustIndexing(config, campaign, originals, experiment, transport, { signal: AbortSignal.abort() });
  expect(receipt.status).toBe("unavailable");
  expect(transport).not.toHaveBeenCalled();
});

it("rejects foreign or malformed trace identities before constructing a query", () => {
  const { originals } = fixture();
  originals[0]!.tracing!.traceId = "injected'";
  expect(() => braintrustTraceIndexQuery(projectId, originals[0]!)).toThrow();
});
