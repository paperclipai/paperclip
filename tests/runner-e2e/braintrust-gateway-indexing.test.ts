import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { verifyBraintrustGatewayIndexing } from "./braintrust-gateway-indexing.js";
import { openEvalCostLedger, readEvalCostLedger } from "./cost-ledger.js";
import { forwardEvalRequest, type EvalGatewayReceipt, type EvalGatewayRoute } from "./eval-gateway.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const config = { projectId: "11111111-1111-4111-8111-111111111111", apiKey: "private-key-canary" };
async function fixture(count = 1, headers = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "gateway-index-test-")); directories.push(directory);
  const ledgerPath = path.join(directory, "ledger.jsonl"), deadlineAt = Date.now() + 60_000;
  const limits = { campaignId: "campaign", maxUsd: "1", deadlineAt: new Date(deadlineAt).toISOString(), maxRequests: 20, maxConcurrent: 1 };
  const ledger = await openEvalCostLedger(ledgerPath, limits);
  await mkdir(`${ledgerPath}.requests`);
  const route: EvalGatewayRoute = { ...config, provider: "openai", mode: "braintrust", endpointName: "OPENAI_API_KEY",
    maximumInputTokens: 1000, maximumOutputTokens: 100, timeoutMs: 2000,
    price: { provider: "openai", model: "fixture", version: "fixture-1", sourceUrl: "https://provider.invalid/prices", inputUsdPerMillion: "2",
      cachedReadUsdPerMillion: "1", outputUsdPerMillion: "10", cacheWrite30mUsdPerMillion: "2", cacheWrite12hUsdPerMillion: "2" } };
  const rows: Array<Record<string, unknown>> = [], receipts: EvalGatewayReceipt[] = [];
  for (let i = 0; i < count; i++) {
    const rowId = randomUUID();
    receipts.push(await forwardEvalRequest({ ledger, identity: { executionId: "hello", attemptId: "attempt", phase: i === 0 ? "setup" : "agent" }, route,
      payload: { model: "fixture", input: "private-prompt-canary" }, deadlineAt,
      onHeaders: () => {}, onChunk: async () => {},
      persist: async receipt => { await writeFile(path.join(`${ledgerPath}.requests`, `${receipt.requestId}.json`), JSON.stringify(receipt)); },
      transport: async () => {
        if (!headers) throw new Error("private-upstream-error-canary");
        return Response.json({ object: "response", status: "completed", id: `provider-response-${i}`, model: "fixture",
          usage: { input_tokens: 10, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 2 }, output_tokens: 5 } },
        { headers: { "x-bt-used-endpoint": "OPENAI_API_KEY", "x-bt-span-id": rowId } });
      },
    }));
    rows.push({ id: rowId, span_id: randomUUID(), root_span_id: randomUUID(), provider: "openai", model: "fixture" });
  }
  await ledger.close();
  return { input: { ledgerPath, campaignId: "campaign", expected: [{ executionId: "hello", provider: "openai" as const, model: "fixture" }] },
    ledgerPath, rows, receipts, limits, receiptFile: (index = 0) => path.join(`${ledgerPath}.requests`, `${receipts[index]!.requestId}.json`) };
}

it("joins setup and agent requests by returned row ID without adding indexed costs to the journal", async () => {
  const f = await fixture(2), before = await readFile(f.ledgerPath, "utf8");
  const transport = vi.fn<typeof fetch>(async () => Response.json({ data: f.rows }));
  const result = await verifyBraintrustGatewayIndexing(config, f.input, transport);
  expect(result).toMatchObject({ status: "verified", expectedRequests: 2, verifiedRequests: 2 });
  expect(result.requests.map(row => row.phase)).toEqual(["setup", "agent"]);
  expect(result.requests[0]).toMatchObject({ gatewayRowId: f.rows[0]!.id, spanId: f.rows[0]!.span_id,
    traceId: f.rows[0]!.root_span_id, campaignMetadataPresent: false });
  const sql = JSON.parse(String(transport.mock.calls[0]![1]!.body)).query;
  expect(sql).toContain(`WHERE id IN ('${f.rows[0]!.id}'`);
  expect(sql).not.toContain("WHERE span_id");
  expect(sql).not.toMatch(/[, ]metadata[, ]|input|output|prompt|completion/);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(await readFile(f.ledgerPath, "utf8")).toBe(before);
  expect(JSON.stringify(result)).not.toMatch(/costUsd|private-|apiKey/);
});

it("retains a pre-header failure as missing coverage and preserves its hold", async () => {
  const f = await fixture(1, false), transport = vi.fn<typeof fetch>();
  const before = (await readEvalCostLedger(f.ledgerPath)).state.snapshot();
  const result = await verifyBraintrustGatewayIndexing(config, f.input, transport);
  expect(result).toMatchObject({ status: "incomplete", expectedRequests: 1, verifiedRequests: 0 });
  expect(result.requests[0]?.reason).toBe("missing_gateway_row_id");
  expect(transport).not.toHaveBeenCalled();
  expect((await readEvalCostLedger(f.ledgerPath)).state.snapshot()).toEqual(before);
  expect(before.heldUsd).not.toBe("0.000000000");
});

it.each(["missing", "malformed", "oversized", "wrong-request", "wrong-route", "wrong-model"])("reports a %s private receipt", async fault => {
  const f = await fixture(), transport = vi.fn<typeof fetch>();
  if (fault === "missing") await rm(f.receiptFile());
  else if (fault === "malformed") await writeFile(f.receiptFile(), "private-error-canary");
  else if (fault === "oversized") await writeFile(f.receiptFile(), "x".repeat(262_145));
  else await writeFile(f.receiptFile(), JSON.stringify({ ...f.receipts[0],
    ...(fault === "wrong-request" ? { requestId: randomUUID() } : fault === "wrong-route" ? { route: "direct" }
      : { usage: { ...f.receipts[0]!.usage, model: "other" } }) }));
  const result = await verifyBraintrustGatewayIndexing(config, f.input, transport);
  expect(result.status).not.toBe("verified");
  expect(transport).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("private-");
});

it.each(["wrong-provider", "wrong-model", "invalid-trace", "duplicate", "foreign-row"])("rejects %s indexed evidence", async fault => {
  const f = await fixture();
  if (fault === "wrong-provider") f.rows[0]!.provider = "anthropic";
  if (fault === "wrong-model") f.rows[0]!.model = "other";
  if (fault === "invalid-trace") f.rows[0]!.root_span_id = "private-token-canary";
  if (fault === "duplicate") f.rows.push(f.rows[0]!);
  if (fault === "foreign-row") f.rows[0]!.id = randomUUID();
  const result = await verifyBraintrustGatewayIndexing(config, f.input, async () => Response.json({ data: f.rows }), { rounds: 1 });
  expect(result.status).not.toBe("verified");
  expect(result.verifiedRequests).toBe(0);
  expect(JSON.stringify(result)).not.toContain("private-");
});

it.each(["request_id", "campaign_id", "execution_id", "attempt_id", "phase"])("rejects a conflicting %s even when other campaign metadata is absent", async field => {
  const f = await fixture(), before = await readFile(f.ledgerPath, "utf8");
  f.rows[0]![field] = "different-work";
  const transport = vi.fn<typeof fetch>(async () => Response.json({ data: f.rows }));
  const result = await verifyBraintrustGatewayIndexing(config, f.input, transport);
  expect(result).toMatchObject({ status: "incomplete", expectedRequests: 1, verifiedRequests: 0 });
  expect(result.requests[0]?.reason).toBe("indexed_identity_conflict");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(await readFile(f.ledgerPath, "utf8")).toBe(before);
});

it.each(["absent", "partial", "complete"])("allows %s campaign metadata when no identity contradicts the receipt", async coverage => {
  const f = await fixture();
  Object.assign(f.rows[0]!, { request_id: null, campaign_id: null, execution_id: null, attempt_id: null, phase: null });
  if (coverage !== "absent") f.rows[0]!.request_id = f.receipts[0]!.requestId;
  if (coverage === "complete") Object.assign(f.rows[0]!, { campaign_id: "campaign", execution_id: "hello", attempt_id: "attempt", phase: "setup" });
  const result = await verifyBraintrustGatewayIndexing(config, f.input, async () => Response.json({ data: f.rows }));
  expect(result).toMatchObject({ status: "verified", expectedRequests: 1, verifiedRequests: 1 });
  expect(result.requests[0]?.campaignMetadataPresent).toBe(coverage === "complete");
});

it("refuses to attribute one gateway row to two charged requests", async () => {
  const f = await fixture(2), transport = vi.fn<typeof fetch>();
  await writeFile(f.receiptFile(1), JSON.stringify({ ...f.receipts[1], gatewaySpanId: f.receipts[0]!.gatewaySpanId }));
  const result = await verifyBraintrustGatewayIndexing(config, f.input, transport);
  expect(result.requests.map(row => row.reason)).toEqual(["duplicate_gateway_row_id", "duplicate_gateway_row_id"]);
  expect(result.status).toBe("incomplete");
  expect(transport).not.toHaveBeenCalled();
});

it("queries delayed rows again without querying rows already found", async () => {
  const f = await fixture(2), pause = vi.fn(async () => {});
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [f.rows[0]] }))
    .mockResolvedValueOnce(Response.json({ data: [f.rows[1]] }));
  const result = await verifyBraintrustGatewayIndexing(config, f.input, transport, { pause });
  expect(result.status).toBe("verified");
  expect(transport).toHaveBeenCalledTimes(2);
  const second = JSON.parse(String(transport.mock.calls[1]![1]!.body)).query;
  expect(second).not.toContain(f.rows[0]!.id);
  expect(second).toContain(f.rows[1]!.id);
});

it.each(["rejected", "malformed", "oversized", "cancelled"])("keeps %s lookup failures visible without response bodies", async fault => {
  const f = await fixture();
  const transport = vi.fn<typeof fetch>(async () => fault === "rejected" ? new Response("private-canary", { status: 401 })
    : fault === "oversized" ? new Response("private-canary".repeat(100_000)) : new Response("private-canary"));
  const result = await verifyBraintrustGatewayIndexing(config, f.input, transport, { rounds: 1,
    ...(fault === "cancelled" ? { signal: AbortSignal.abort() } : {}) });
  expect(result.status).toBe("unavailable");
  expect(JSON.stringify(result)).not.toContain("private-canary");
  if (fault === "cancelled") expect(transport).not.toHaveBeenCalled();
});

it.each(["receipt", "journal"])("rejects evidence when the %s changes during lookup", async kind => {
  const f = await fixture();
  const transport = vi.fn<typeof fetch>(async () => {
    if (kind === "receipt") await writeFile(f.receiptFile(), JSON.stringify({ ...f.receipts[0], gatewaySpanId: randomUUID() }));
    else {
      const ledger = await openEvalCostLedger(f.ledgerPath, f.limits);
      await ledger.reserve(randomUUID(), { executionId: "hello", attemptId: "another", phase: "setup" }, "0.01");
      await ledger.close();
    }
    return Response.json({ data: f.rows });
  });
  const result = await verifyBraintrustGatewayIndexing(config, f.input, transport);
  expect(result.status).toBe("unavailable");
  expect(result.verifiedRequests).toBe(0);
  expect(result.requests[0]?.reason).toBe(kind === "receipt" ? "receipt_changed" : "ledger_changed");
});

it("rejects a mismatched campaign or selection before lookup", async () => {
  const f = await fixture(), transport = vi.fn<typeof fetch>();
  await expect(verifyBraintrustGatewayIndexing(config, { ...f.input, campaignId: "other" }, transport)).rejects.toThrow("campaign mismatch");
  await expect(verifyBraintrustGatewayIndexing(config, { ...f.input, expected: [{ ...f.input.expected[0]!, executionId: "other" }] }, transport)).rejects.toThrow("selection mismatch");
  expect(transport).not.toHaveBeenCalled();
});
