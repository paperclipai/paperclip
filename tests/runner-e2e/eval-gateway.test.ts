import { costBoundConfigurationSha256 } from "./cost-bound-evidence.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { openEvalCostLedger, readEvalCostLedger } from "./cost-ledger.js";
import { beginEvalAgentPhase, createEvalAttemptPhase, readEvalAttemptPhase } from "./attempt-phase.js";
import { boundedEvalPayload, evalRequestReservation, EvalUsageStream, forwardEvalRequest, startEvalGateway, type EvalGatewayRoute, type EvalGatewayReceipt } from "./eval-gateway.js";
const directories: string[] = [], closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
const identity = { executionId: "hello", attemptId: "attempt", phase: "agent" as const };
const route: EvalGatewayRoute = { provider: "openai", mode: "braintrust", apiKey: "private-upstream-fixture", projectId: "11111111-1111-4111-8111-111111111111", endpointName: "OPENAI_API_KEY",
  maximumInputTokens: 1000, maximumOutputTokens: 100, timeoutMs: 2000,
  price: { provider: "openai", model: "fixture", version: "fixture-1", sourceUrl: "https://provider.invalid/prices", inputUsdPerMillion: "2", cachedReadUsdPerMillion: "1", outputUsdPerMillion: "10", cacheWrite30mUsdPerMillion: "2", cacheWrite12hUsdPerMillion: "2" } };
const usage = { object: "response", status: "completed", id: "provider-response", model: "fixture", usage: { input_tokens: 10, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 2 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } } };
const response = () => Response.json(usage, { headers: { "x-bt-used-endpoint": "OPENAI_API_KEY", "x-bt-cached": "MISS", "x-bt-request-id": "gateway-request", "x-bt-span-id": "gateway-span" } });
async function fixture(maxUsd = "1", maxConcurrent = 2) {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-forward-test-")); directories.push(dir);
  const file = path.join(dir, "ledger.jsonl"), deadlineAt = Date.now() + 30_000;
  const ledger = await openEvalCostLedger(file, { campaignId: "campaign", maxUsd, deadlineAt: new Date(deadlineAt).toISOString(), maxRequests: 10, maxConcurrent });
  closes.push(() => ledger.close());
  const receipts: EvalGatewayReceipt[] = [];
  return { ledger, file, deadlineAt, identity, route, receipts, payload: { model: "fixture", input: "hello", max_output_tokens: 500 },
    persist: async (receipt: EvalGatewayReceipt) => { receipts.push(structuredClone(receipt)); }, onHeaders: vi.fn(), onChunk: vi.fn(async () => {}) };
}
it("fsyncs reservation before dispatch, pins gateway routing, and replaces reservation with one estimate", async () => {
  const f = await fixture();
  let captured: RequestInit | undefined;
  let reservedBeforeDispatch = false;
  const transport = vi.fn<typeof fetch>(async (_url, init) => { captured = init; reservedBeforeDispatch = (await readEvalCostLedger(f.file)).state.snapshot().inflight === 1; return response(); });
  const result = await forwardEvalRequest({ ...f, transport });
  expect(reservedBeforeDispatch).toBe(true);
  expect(transport.mock.calls[0]![0]).toBe("https://gateway.braintrust.dev/responses");
  expect(captured).toMatchObject({ redirect: "error", headers: { authorization: `Bearer ${route.apiKey}`, "x-bt-use-cache": "never", "cache-control": "no-cache, no-store", "x-bt-project-id": route.projectId, "x-bt-endpoint-name": route.endpointName, "x-bt-parent": result.braintrustParent } });
  expect(JSON.parse(captured!.body as string)).toMatchObject({ max_output_tokens: 100, service_tier: "default" });
  expect(result).toMatchObject({ outcome: "succeeded", costUsd: "0.000068000", final: true, usageComplete: true, gatewaySpanId: "gateway-span" });
  expect(f.ledger.snapshot()).toMatchObject({ knownUsd: "0.000068000", heldUsd: "0.000000000", inflight: 0 });
  expect(await readFile(f.file, "utf8")).not.toContain(route.apiKey);
});
it.each(["openai", "anthropic"] as const)("correlates %s gateway logs before response headers even when the client cancels", async provider => {
  const f = await fixture();
  const selectedRoute: EvalGatewayRoute = provider === "openai" ? route : { ...route, provider, endpointName: "ANTHROPIC_API_KEY",
    price: { ...route.price, provider, cacheWrite5mUsdPerMillion: "2", cacheWrite1hUsdPerMillion: "4" } };
  const parents: string[] = [];
  const initialReceipts: EvalGatewayReceipt[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const receipt = await forwardEvalRequest({ ...f, route: selectedRoute, signal: controller.signal,
      transport: async (_url, init) => {
        parents.push(new Headers(init?.headers).get("x-bt-parent")!);
        initialReceipts.push(structuredClone(f.receipts.at(-1)!));
        controller.abort();
        throw new DOMException("client disconnected", "AbortError");
      },
    });
    expect(receipt).toMatchObject({ outcome: "cancelled", errorCode: "request_cancelled", costUsd: null, final: false });
    expect(receipt.gatewaySpanId).toBeUndefined();
  }
  expect(parents[0]).not.toBe(parents[1]);
  for (const [index, encoded] of parents.entries()) {
    const bytes = Buffer.from(encoded, "base64");
    expect([...bytes.subarray(0, 3)]).toEqual([4, 2, 0]);
    expect(JSON.parse(bytes.subarray(3).toString())).toEqual({ object_id: route.projectId, propagated_event: { metadata: {
      paperclip_eval_request_id: initialReceipts[index]!.requestId, paperclip_eval_campaign_id: "campaign",
      paperclip_eval_execution_id: identity.executionId, paperclip_eval_attempt_id: identity.attemptId, paperclip_eval_phase: "agent",
    } } });
    expect(initialReceipts[index]).toMatchObject({ braintrustParent: encoded, final: false, costUsd: null });
  }
  expect(f.ledger.snapshot()).toMatchObject({ inflight: 0, unknownRequests: 2, knownUsd: "0.000000000" });
  expect(f.ledger.snapshot().heldUsd).not.toBe("0.000000000");
  expect(JSON.stringify(initialReceipts)).not.toContain(route.apiKey);
});
it("keeps Braintrust request metadata out of direct provider requests", async () => {
  const f = await fixture();
  let headers: Headers | undefined;
  const receipt = await forwardEvalRequest({ ...f, route: { ...route, mode: "direct" }, transport: async (_url, init) => {
    headers = new Headers(init?.headers); return response();
  } });
  expect(headers!.has("x-bt-parent")).toBe(false);
  expect(receipt).not.toHaveProperty("braintrustParent");
});
it("stops at the campaign cap before any upstream request", async () => {
  const f = await fixture("0.002"), transport = vi.fn<typeof fetch>();
  expect(evalRequestReservation(route)).toBe("0.003000000");
  await expect(forwardEvalRequest({ ...f, transport })).rejects.toThrow("spending cap");
  expect(transport).not.toHaveBeenCalled();
});
it.each((["direct", "braintrust"] as const).flatMap(mode => (["alias", "snapshot"] as const).map(model => ({ mode, model }))))(
  "retains request-policy cost provenance for $model responses without changing the $mode cache policy", async ({ mode, model }) => {
  const f = await fixture();
  const pricedRoute = { ...route, mode, price: { ...route.price, model: "gpt-5.6-sol", inputUsdPerMillion: "4", cachedReadUsdPerMillion: "0.4",
    outputUsdPerMillion: "20", cacheWrite30mUsdPerMillion: "5", cacheWrite12hUsdPerMillion: "10", responseModels: ["gpt-5.6-sol-reviewed-snapshot"] } };
  const payload = { ...f.payload, model: pricedRoute.price.model, prompt_cache_retention: "24h", stream: true };
  const body = { ...usage, model: model === "alias" ? pricedRoute.price.model : pricedRoute.price.responseModels[0],
    usage: { ...usage.usage, input_tokens_details: { cache_write_tokens: 6, cached_tokens: 2 } } };
  const transport = vi.fn<typeof fetch>(async () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: body })}\n\n`, {
    headers: { "content-type": "text/event-stream", "x-bt-used-endpoint": "OPENAI_API_KEY", "x-bt-cached": "MISS" },
  }));
  const receipt = await forwardEvalRequest({ ...f, route: pricedRoute, payload, transport });
  expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toEqual({ ...payload, max_output_tokens: 100, service_tier: "default" });
  expect(receipt).toMatchObject({ outcome: "succeeded", final: true, costUsd: "0.000138800", usage: { cacheWrite30m: 6, cacheWrite12h: 0,
    cacheWriteAttribution: { source: "request_policy", version: "openai-prompt-cache-2026-10-20", ttl: "30m" } } });
  expect(f.receipts.at(-1)).toEqual(receipt);
  expect(f.ledger.snapshot()).toMatchObject({ knownUsd: "0.000138800", heldUsd: "0.000000000", inflight: 0 });
  expect((await readEvalCostLedger(f.file)).state.snapshot()).toMatchObject({ knownUsd: "0.000138800", heldUsd: "0.000000000", unknownRequests: 0 });
});
it("retains cancelled and provider-error requests as unknown, including repeated retries", async () => {
  const f = await fixture();
  const first = await forwardEvalRequest({ ...f, transport: async () => { throw new Error(route.apiKey); } });
  const second = await forwardEvalRequest({ ...f, transport: async () => Response.json({ error: "private-provider-message" }, { status: 429 }) });
  expect(first).toMatchObject({ outcome: "failed", errorCode: "request_failed", costUsd: null });
  expect(second).toMatchObject({ outcome: "failed", errorCode: "upstream_rejected", costUsd: null });
  expect(first.requestId).not.toBe(second.requestId);
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.006000000", knownUsd: "0.000000000", unknownRequests: 2 });
  expect(JSON.stringify(f.receipts)).not.toMatch(/private-upstream|private-provider-message/);
});
it.each([
  { model: "other" }, { model: "fixture", background: true }, { model: "fixture", service_tier: "priority" },
  { model: "fixture", tools: [{ type: "web_search" }] }, { model: "fixture", input: [{ type: "input_image", image_url: "https://image.invalid" }] },
  { model: "fixture", speed: "fast" }, { model: "fixture", inference_geo: "us" },
])("rejects unpriced request shapes before admission", async payload => {
  const f = await fixture(), transport = vi.fn<typeof fetch>();
  await expect(forwardEvalRequest({ ...f, payload, transport })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled(); expect(f.ledger.snapshot().requests).toHaveLength(0);
});
it("admits local function and custom tools inside a Codex namespace", async () => {
  const f = await fixture();
  const tools = [{ type: "namespace", name: "local", tools: [
    { type: "function", name: "read_task", parameters: { type: "object" } },
    { type: "custom", name: "apply_patch" },
  ] }];
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    expect(JSON.parse(init!.body as string).tools).toEqual(tools);
    return response();
  });
  const result = await forwardEvalRequest({ ...f, payload: { ...f.payload, tools }, transport });
  expect(result.outcome).toBe("succeeded");
  expect(transport).toHaveBeenCalledOnce();
});
it("validates the native daemon's namespace envelope before reserving and forwarding", async () => {
  const f = await fixture();
  const localTool = (name: string) => ({ type: "function", name, description: "Synthetic local tool",
    parameters: { type: "object", properties: {}, additionalProperties: false }, strict: true });
  const tools = [...Array.from({ length: 7 }, (_, index) => localTool(`local_${index}`)),
    { type: "namespace", name: "local_tools", description: "Synthetic local namespace",
      tools: Array.from({ length: 5 }, (_, index) => localTool(`operation_${index}`)) }];
  const payload = Object.freeze({ ...f.payload, tools });
  const normalized = boundedEvalPayload(payload, { provider: route.provider, price: route.price, maximumOutputTokens: 100 });
  expect(normalized).toEqual({ ...payload, max_output_tokens: 100, service_tier: "default" });
  expect(payload).not.toHaveProperty("service_tier");
  expect(payload.max_output_tokens).toBe(500);
  expect(f.ledger.snapshot().requests).toHaveLength(0);
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    expect(JSON.parse(init!.body as string)).toEqual(normalized);
    expect((await readEvalCostLedger(f.file)).state.snapshot().inflight).toBe(1);
    return response();
  });
  const receipt = await forwardEvalRequest({ ...f, payload, transport });
  expect(receipt).toMatchObject({ outcome: "succeeded", costUsd: "0.000068000", final: true });
  expect(transport).toHaveBeenCalledOnce();
});
it.each([
  { type: "namespace", name: " ", tools: [{ type: "function", name: "local" }] },
  { type: "namespace", name: "local", description: {}, tools: [{ type: "function", name: "local" }] },
  { type: "namespace", name: "local", tools: [] },
  { type: "namespace", name: "local", tools: null },
  { type: "namespace", name: "local", tools: [null] },
  { type: ["function"], name: "local" },
  { type: ["custom"], name: "local" },
  { type: "namespace", name: "local", tools: [{ type: ["function"], name: "local" }] },
  { type: "namespace", name: "local", tools: [{ type: ["custom"], name: "local" }] },
  ...[undefined, null, 7, "", " "].flatMap(name => ["function", "custom"].flatMap(type =>
    [{ type, name }, { type: "namespace", name: "local", tools: [{ type, name }] }])),
  { type: "namespace", name: "local", tools: [{ type: "function", name: "local" }], future_hosted_tool: true },
  { type: "namespace", name: "local", tools: [{ type: "namespace", name: "nested", tools: [{ type: "function", name: "local" }] }] },
  ...["web_search", "file_search", "image_generation", "code_interpreter", "computer", "mcp", "unknown"].map(type =>
    ({ type: "namespace", name: "local", tools: [{ type }] })),
])("rejects malformed, nested, or hosted namespace tools before any side effects", async tool => {
  const f = await fixture(), transport = vi.fn<typeof fetch>(), persist = vi.fn();
  const payload = { ...f.payload, tools: [tool] };
  expect(() => boundedEvalPayload(payload, f.route)).toThrow("unqualified_hosted_tool");
  await expect(forwardEvalRequest({ ...f, payload, transport, persist })).rejects.toThrow("unqualified_hosted_tool");
  expect(transport).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  expect(f.ledger.snapshot().requests).toHaveLength(0);
});
it.each(["flat", "namespace"] as const)("bounds the total %s tool definitions including namespace wrappers", async shape => {
  const f = await fixture(), transport = vi.fn<typeof fetch>(), persist = vi.fn();
  const tool = { type: "function", name: "local_tool" };
  const tools = shape === "flat" ? Array.from({ length: 1024 }, () => tool)
    : [{ type: "namespace", name: "local", tools: Array.from({ length: 1023 }, () => tool) }];
  expect(boundedEvalPayload({ ...f.payload, tools }, f.route).tools).toEqual(tools);
  const payload = { ...f.payload, tools: [...tools, tool] };
  await expect(forwardEvalRequest({ ...f, payload, transport, persist })).rejects.toThrow("unqualified_hosted_tool");
  expect(transport).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  expect(f.ledger.snapshot().requests).toHaveLength(0);
});
it("keeps Anthropic custom tools and output limits separate from OpenAI namespaces", () => {
  const anthropic = { provider: "anthropic" as const, price: { ...route.price, provider: "anthropic" as const }, maximumOutputTokens: 100 };
  const tools = [{ name: "local_tool", input_schema: { type: "object" } }, { type: "custom", name: "other_tool" }];
  expect(boundedEvalPayload({ model: "fixture", tools, max_tokens: 500 }, anthropic))
    .toEqual({ model: "fixture", tools, max_tokens: 100, service_tier: "standard_only" });
  expect(() => boundedEvalPayload({ model: "fixture", tools: [{ type: "namespace", name: "local", tools }] }, anthropic))
    .toThrow("unqualified_hosted_tool");
});
it.each([
  { type: "namespace", name: "local", tools: [{ type: "web_search" }] },
  { type: "namespace", name: "local", tools: [{ type: "namespace", name: "nested", tools: [{ type: "web_search" }] }] },
  { type: "namespace", name: "local" },
  { type: "namespace", name: "local", tools: [{ type: "custom", name: "x", tools: [{ type: "web_search" }] }] },
  { type: "namespace", name: "local", tools: [{ type: "function", name: "x", tools: [{ type: "web_search" }] }] },
  { type: "custom", name: "x", tools: [{ type: "web_search" }] },
])("rejects unqualified tools inside namespaces before reservation", async tool => {
  const f = await fixture(), transport = vi.fn<typeof fetch>();
  await expect(forwardEvalRequest({ ...f, payload: { ...f.payload, tools: [tool] }, transport })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled(); expect(f.ledger.snapshot().requests).toHaveLength(0);
});
it("does not dispatch when the private pre-request receipt cannot be persisted", async () => {
  const f = await fixture(), transport = vi.fn<typeof fetch>();
  await expect(forwardEvalRequest({ ...f, persist: async () => { throw new Error("disk unavailable"); }, transport })).rejects.toThrow("disk unavailable");
  expect(transport).not.toHaveBeenCalled();
  expect(f.ledger.snapshot()).toMatchObject({ unknownRequests: 1, heldUsd: "0.003000000" });
});
it("parses actual fragmented SSE without summing cumulative counters", async () => {
  const f = await fixture();
  const wire = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hello 👋" })}\r\n\r\ndata: ${JSON.stringify({ type: "response.completed", response: usage })}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const bytes = Buffer.from(wire);
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3)); controller.close(); } });
  const result = await forwardEvalRequest({ ...f, transport: async () => new Response(body, { headers: { "content-type": "text/event-stream", "x-bt-used-endpoint": "OPENAI_API_KEY" } }) });
  expect(result).toMatchObject({ costUsd: "0.000068000", final: true });
  expect(f.onChunk.mock.calls.length).toBeGreaterThan(1);
  const truncated = new EvalUsageStream(() => {});
  expect(() => truncated.push(Buffer.from('data: {"type":"response.completed"}'), true)).toThrow("incomplete_usage_stream");
});
it.each([{ "x-bt-cached": "HIT" }, { "x-bt-used-endpoint": "FOREIGN" }, { "x-bt-failover-to": "fixture/FOREIGN" }])("rejects cached/failover/foreign route evidence without releasing the reservation", async headers => {
  const f = await fixture();
  const result = await forwardEvalRequest({ ...f, transport: async () => Response.json(usage, { headers: Object.fromEntries(Object.entries({ "x-bt-used-endpoint": "OPENAI_API_KEY", ...headers }).filter((pair): pair is [string, string] => pair[1] !== undefined)) }) });
  expect(result).toMatchObject({ outcome: "failed", errorCode: "gateway_route_not_qualified", costUsd: null });
  expect(f.onChunk).not.toHaveBeenCalled();
  expect(f.ledger.snapshot().heldUsd).toBe("0.003000000");
});
it("uses the loopback gateway through real HTTP while withholding upstream credentials from the client", async () => {
  const f = await fixture();
  const transport = vi.fn<typeof fetch>(async () => response());
  const gateway = await startEvalGateway({ ...f, transport }); closes.push(() => gateway.close());
  const denied = await fetch(`${gateway.baseUrl}/v1/responses`, { method: "POST", body: "{}" });
  expect(denied.status).toBe(401); expect(transport).not.toHaveBeenCalled();
  const accepted = await fetch(`${gateway.baseUrl}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, body: JSON.stringify(f.payload) });
  expect(accepted.status).toBe(200); expect(await accepted.json()).toEqual(usage);
  expect(gateway.token).not.toBe(route.apiKey);
  expect(accepted.headers.get("x-paperclip-eval-request-id")).toBeTruthy();
  expect([...accepted.headers.values()].join(" ")).not.toContain(route.apiKey);
});
it.each([
  { status: 400, type: "text/plain", body: "private fixture rejection" },
  { status: 503, type: "text/html", body: "<html>private fixture rejection</html>" },
  { status: 400, type: "application/json", body: "invalid JSON fixture rejection" },
])("finishes non-JSON upstream errors without truncating the client response: $status $type", async error => {
  const f = await fixture();
  const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(error.body, { status: error.status, headers: { "content-type": error.type } }))
    .mockImplementation(async () => response());
  const gateway = await startEvalGateway({ ...f, transport }); closes.push(() => gateway.close());
  const request = () => fetch(`${gateway.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}` }, body: JSON.stringify(f.payload) });
  const rejected = await request();
  expect(rejected.status).toBe(error.status);
  expect(await rejected.text()).toBe(error.body);
  expect(f.receipts.at(-1)).toMatchObject({ outcome: "failed", errorCode: "upstream_rejected", costUsd: null, usageComplete: false });
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.003000000", unknownRequests: 1, inflight: 0 });
  expect(JSON.stringify(f.receipts)).not.toContain(error.body);
  expect(await (await request()).json()).toEqual(usage);
  expect(transport).toHaveBeenCalledTimes(2);
});
it("still fails successful responses with invalid usage JSON and holds their reservation", async () => {
  const f = await fixture();
  const result = await forwardEvalRequest({ ...f, transport: async () => new Response("invalid successful response", {
    headers: { "content-type": "application/json", "x-bt-used-endpoint": "OPENAI_API_KEY" },
  }) });
  expect(result).toMatchObject({ outcome: "failed", errorCode: "request_failed", costUsd: null });
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.003000000", unknownRequests: 1, inflight: 0 });
});

it("reserves the highest cache-write and long-context rates before dispatch", () => {
  expect(evalRequestReservation({ ...route, price: { ...route.price, cacheWrite12hUsdPerMillion: "5",
    longContext: { aboveInputTokens: 100, rates: { inputUsdPerMillion: "4", cachedReadUsdPerMillion: "2", cacheWrite30mUsdPerMillion: "5", cacheWrite12hUsdPerMillion: "10", outputUsdPerMillion: "15" } } } })).toBe("0.011500000");
  expect(() => evalRequestReservation({ ...route, price: { ...route.price, cacheWrite12hUsdPerMillion: undefined } })).toThrow("both provider cache-write");
});
it("propagates cancellation to an in-flight upstream request and retains its reservation", async () => {
  const f = await fixture(), controller = new AbortController();
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    controller.abort();
    init!.signal!.throwIfAborted();
    throw new Error("unreachable");
  });
  const receipt = await forwardEvalRequest({ ...f, signal: controller.signal, transport });
  expect(receipt).toMatchObject({ outcome: "cancelled", errorCode: "request_cancelled", final: false, costUsd: null });
  expect(transport).toHaveBeenCalledOnce();
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.003000000", unknownRequests: 1, inflight: 0 });
});
it("does not release a reservation for an otherwise final response missing cache-write usage", async () => {
  const f = await fixture(), body = structuredClone(usage);
  delete (body.usage.input_tokens_details as any).cache_write_tokens;
  const receipt = await forwardEvalRequest({ ...f, transport: async () => Response.json(body, { headers: { "x-bt-used-endpoint": "OPENAI_API_KEY" } }) });
  expect(receipt).toMatchObject({ outcome: "succeeded", usageComplete: false, final: true, costUsd: null });
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.003000000", unknownRequests: 1 });
});
it.each([{ version: "prices with spaces" }, { model: "model with spaces" }])("rejects invalid ledger price identities before reserving or dispatching", async invalid => {
  const f = await fixture(), transport = vi.fn<typeof fetch>();
  const price = { ...route.price, ...invalid };
  await expect(forwardEvalRequest({ ...f, route: { ...route, price }, payload: { model: price.model }, transport })).rejects.toThrow("price identity");
  expect(transport).not.toHaveBeenCalled();
  expect(f.ledger.snapshot().requests).toHaveLength(0);
});
it("retains invalid reasoning counters privately and finishes an unknown charge", async () => {
  const f = await fixture(), body = structuredClone(usage);
  body.usage.output_tokens_details.reasoning_tokens = 6;
  const receipt = await forwardEvalRequest({ ...f, transport: async () => Response.json(body, { headers: { "x-bt-used-endpoint": "OPENAI_API_KEY" } }) });
  expect(receipt).toMatchObject({ outcome: "succeeded", errorCode: "invalid_usage", usageComplete: false, final: true, costUsd: null,
    usage: { tokens: { output: 5, reasoning: 6 } } });
  expect(f.receipts.at(-1)).toEqual(receipt);
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.003000000", unknownRequests: 1, inflight: 0 });
  const journal = await readFile(f.file, "utf8");
  expect(journal).not.toContain('"reasoning":6');
  expect(journal).toContain('"type":"finish"');
});
it("retains malformed provider identifiers without losing the final receipt or ledger finish", async () => {
  const f = await fixture();
  const receipt = await forwardEvalRequest({ ...f, transport: async () => Response.json({ ...usage, model: "unexpected model name" },
    { headers: { "x-bt-used-endpoint": "OPENAI_API_KEY", "x-request-id": "request with spaces" } }) });
  expect(receipt).toMatchObject({ providerRequestId: "request with spaces", usage: { model: "unexpected model name" }, final: true, costUsd: null });
  expect(f.receipts.at(-1)).toEqual(receipt);
  expect(f.ledger.snapshot()).toMatchObject({ heldUsd: "0.003000000", unknownRequests: 1, inflight: 0 });
});
it("admits later HTTP requests after temporary concurrency exhaustion", async () => {
  const f = await fixture("1", 1);
  let admitted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { admitted = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const transport = vi.fn<typeof fetch>(async () => { admitted(); await blocked; return response(); });
  const gateway = await startEvalGateway({ ...f, transport }); closes.push(() => gateway.close());
  const request = () => fetch(`${gateway.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}` }, body: JSON.stringify(f.payload) });
  const first = request(); await started;
  try {
    const denied = await request();
    expect(denied.status).toBe(429); expect(transport).toHaveBeenCalledOnce();
  } finally { release(); }
  expect(await (await first).json()).toEqual(usage);
  const later = await request();
  expect(later.status).toBe(200); expect(await later.json()).toEqual(usage);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(f.ledger.snapshot()).toMatchObject({ inflight: 0, unknownRequests: 0 });
});
it("rejects malformed, interrupted and unqualified uploads without disabling later valid requests", async () => {
  const f = await fixture(), transport = vi.fn<typeof fetch>(async () => response());
  const gateway = await startEvalGateway({ ...f, transport }); closes.push(() => gateway.close());
  const headers = { authorization: `Bearer ${gateway.token}` };
  for (const body of ["{", JSON.stringify({ model: "other" }), JSON.stringify({ model: "fixture", tools: [{ type: "web_search" }] })]) {
    const rejected = await fetch(`${gateway.baseUrl}/responses`, { method: "POST", headers, body });
    expect(rejected.status).toBe(400); await rejected.text();
  }
  await new Promise<void>((resolve, reject) => {
    const socket = connect(Number(new URL(gateway.baseUrl).port), "127.0.0.1");
    socket.on("error", reject); socket.on("close", () => resolve()); socket.resume();
    socket.on("connect", () => socket.end(`POST /responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${gateway.token}\r\nContent-Length: 100\r\n\r\n{`));
  });
  expect(transport).not.toHaveBeenCalled(); expect(f.ledger.snapshot().requests).toHaveLength(0);
  const valid = await fetch(`${gateway.baseUrl}/responses`, { method: "POST", headers, body: JSON.stringify(f.payload) });
  expect(valid.status).toBe(200); expect(await valid.json()).toEqual(usage);
  expect(transport).toHaveBeenCalledOnce(); expect(f.ledger.snapshot().requests).toHaveLength(1);
});
it("still disables the HTTP gateway after a receipt persistence failure", async () => {
  const f = await fixture(), transport = vi.fn<typeof fetch>(async () => response());
  const gateway = await startEvalGateway({ ...f, transport, persist: async () => { throw new Error("storage failure"); } }); closes.push(() => gateway.close());
  for (let i = 0; i < 2; i++) {
    const denied = await fetch(`${gateway.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}` }, body: JSON.stringify(f.payload) });
    expect(denied.status).toBe(503); await denied.text();
  }
  expect(transport).not.toHaveBeenCalled(); expect(f.ledger.snapshot().requests).toHaveLength(1);
});
it("applies the request deadline while waiting for downstream backpressure", async () => {
  const f = await fixture();
  const receipt = await forwardEvalRequest({ ...f, route: { ...f.route, timeoutMs: 50 }, transport: async () => response(),
    onChunk: async (_chunk, signal) => {
      signal.throwIfAborted();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  expect(receipt).toMatchObject({ outcome: "cancelled", errorCode: "request_cancelled" });
  expect(f.ledger.snapshot()).toMatchObject({ inflight: 0, unknownRequests: 1, heldUsd: "0.003000000" });
});
it("forwards Claude's Messages beta query without admitting unrelated endpoints or queries", async () => {
  const f = await fixture();
  const anthropicRoute: EvalGatewayRoute = { ...route, provider: "anthropic", mode: "direct", price: { provider: "anthropic", model: "fixture",
    version: "fixture", sourceUrl: "https://provider.invalid/prices", inputUsdPerMillion: "2", cachedReadUsdPerMillion: "1", outputUsdPerMillion: "10",
    cacheWrite5mUsdPerMillion: "2.5", cacheWrite1hUsdPerMillion: "4" } };
  const body = { type: "message", model: "fixture", usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  const transport = vi.fn<typeof fetch>(async () => Response.json(body));
  const gateway = await startEvalGateway({ ...f, route: anthropicRoute, transport }); closes.push(() => gateway.close());
  const request = (pathname: string) => fetch(gateway.baseUrl + pathname, { method: "POST", headers: { "x-api-key": gateway.token, "anthropic-beta": "fixture-beta" }, body: JSON.stringify({ model: "fixture", messages: [] }) });
  expect((await request("/v1/messages?beta=true&extra=true")).status).toBe(404);
  const accepted = await request("/v1/messages?beta=true");
  expect(accepted.status).toBe(200); expect(await accepted.json()).toEqual(body);
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages?beta=true");
  expect(transport.mock.calls[0]![1]!.headers).toMatchObject({ "anthropic-beta": "fixture-beta" });
  expect(f.ledger.snapshot()).toMatchObject({ unknownRequests: 0, inflight: 0 });
});

it("attributes setup at admission, preserves it during execution, and blocks missing phase evidence", async () => {
  const f = await fixture();
  const phasePath = path.join(path.dirname(f.file), "phase.json");
  await createEvalAttemptPhase(phasePath, identity);
  const env = { PAPERCLIP_E2E_GATEWAY_PHASE_PATH: phasePath, PAPERCLIP_E2E_ACCOUNTING_ATTEMPT_ID: identity.attemptId };
  let started!: () => void, release!: () => void, calls = 0;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const continuation = new Promise<void>(resolve => { release = resolve; });
  const gateway = await startEvalGateway({ ...f, resolveIdentity: () => readEvalAttemptPhase(phasePath, identity),
    transport: async () => {
      calls++;
      if (calls === 1) { started(); await continuation; }
      return Response.json({ ...usage, id: `provider-${calls}` }, { headers: { "x-bt-used-endpoint": "OPENAI_API_KEY" } });
    },
  });
  closes.push(() => gateway.close());
  const send = () => fetch(`${gateway.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}` }, body: JSON.stringify(f.payload) });
  const first = send();
  await firstStarted;
  await beginEvalAgentPhase(identity.executionId, env);
  release();
  expect((await first).status).toBe(200);
  expect((await send()).status).toBe(200);
  expect(f.ledger.snapshot().requests.map(request => request.phase)).toEqual(["setup", "agent"]);
  await writeFile(phasePath, JSON.stringify({ version: 1, ...identity, attemptId: "foreign-attempt" }));
  expect((await send()).status).toBe(503);
  expect(calls).toBe(2);
  expect((await readEvalCostLedger(f.file)).state.snapshot().requests.map(request => request.phase)).toEqual(["setup", "agent"]);
});

it("refuses missing or unreviewed attribution checkpoints before request dispatch", async () => {
  const f = await fixture(), transport = vi.fn<typeof fetch>();
  const phasePath = path.join(path.dirname(f.file), "missing-phase.json");
  const gateway = await startEvalGateway({ ...f, transport, resolveIdentity: () => readEvalAttemptPhase(phasePath, identity) });
  closes.push(() => gateway.close());
  const response = await fetch(`${gateway.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}` }, body: JSON.stringify(f.payload) });
  expect(response.status).toBe(503);
  expect(transport).not.toHaveBeenCalled();
  expect(f.ledger.snapshot().requests).toEqual([]);
  await expect(beginEvalAgentPhase(identity.executionId, { PAPERCLIP_E2E_GATEWAY_BASE_URL: gateway.baseUrl })).rejects.toThrow("Missing eval phase");
  await createEvalAttemptPhase(phasePath, identity);
  await expect(createEvalAttemptPhase(phasePath, identity)).rejects.toThrow();
  await writeFile(phasePath, JSON.stringify({ version: 1, ...identity, providerResponse: "private" }));
  await expect(readEvalAttemptPhase(phasePath, identity)).rejects.toThrow("Invalid eval phase");
});

const provisionalBound = { version: 1 as const, scope: "full_lifecycle" as const, evidenceSha256: "a".repeat(64),
  configurationSha256: costBoundConfigurationSha256({ provider: route.provider, mode: route.mode, price: route.price,
    maximumInputTokens: route.maximumInputTokens, maximumOutputTokens: route.maximumOutputTokens, reservation: evalRequestReservation(route) }) };
it.each(["json", "sse"] as const)("prices a declared exact response snapshot from forwarded %s bytes and replays the ledger", async format => {
  const f = await fixture();
  const selected = { ...route, price: { ...route.price, model: "gpt-5.4-mini", responseModels: ["gpt-5.4-mini-2026-03-17"], version: "snapshot-fixture-2" } };
  const bound = { ...provisionalBound, configurationSha256: costBoundConfigurationSha256({
    provider: selected.provider, mode: selected.mode, price: selected.price,
    maximumInputTokens: selected.maximumInputTokens, maximumOutputTokens: selected.maximumOutputTokens, reservation: evalRequestReservation(selected),
  }) };
  const returned = { ...usage, model: selected.price.responseModels[0] };
  const wire = Buffer.from(format === "sse" ? `data: ${JSON.stringify({ type: "response.completed", response: returned })}\r\n\r\ndata: [DONE]\r\n\r\n` : JSON.stringify(returned));
  const forwarded: Uint8Array[] = [];
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    expect(JSON.parse(init!.body as string).model).toBe(selected.price.model);
    expect((await readEvalCostLedger(f.file)).state.snapshot().inflight).toBe(1);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      for (let index = 0; index < wire.length; index += 3) controller.enqueue(wire.subarray(index, index + 3));
      controller.close();
    } }), { headers: { "content-type": format === "sse" ? "text/event-stream" : "application/json", "x-bt-used-endpoint": selected.endpointName! } });
  });
  const receipt = await forwardEvalRequest({ ...f, route: { ...selected, provisionalBound: bound },
    payload: { ...f.payload, model: selected.price.model }, transport, onChunk: async chunk => { forwarded.push(chunk); } });
  expect(Buffer.concat(forwarded)).toEqual(wire);
  expect(receipt).toMatchObject({ outcome: "succeeded", costUsd: "0.000068000", usageComplete: true, final: true, usage: { model: returned.model } });
  expect(f.receipts.at(-1)).toEqual(receipt);
  const replay = (await readEvalCostLedger(f.file)).state;
  expect(replay.snapshot()).toMatchObject({ knownUsd: "0.000068000", heldUsd: "0.000000000", unknownRequests: 0, boundedUnresolvedRequests: 0, inflight: 0 });
  const request = [...replay.requests.values()][0]!;
  expect(request.boundInvalidated).not.toBe(true);
  expect(request.observations).toEqual(expect.arrayContaining([expect.objectContaining({
    classification: "estimated", model: returned.model, costUsd: "0.000068000", pricingVersion: selected.price.version,
  })]));
  expect(transport).toHaveBeenCalledOnce();
});

it.each(["listed-partial", "unlisted-snapshot", "unlisted-suffix", "no-mapping"] as const)("preserves unknown usage and the correct bound for %s response bytes", async reason => {
  const f = await fixture();
  const selected = { ...route, price: { ...route.price, model: "gpt-5.4-mini",
    ...(reason === "no-mapping" ? {} : { responseModels: ["gpt-5.4-mini-2026-03-17"] }) } };
  const bound = { ...provisionalBound, configurationSha256: costBoundConfigurationSha256({
    provider: selected.provider, mode: selected.mode, price: selected.price,
    maximumInputTokens: selected.maximumInputTokens, maximumOutputTokens: selected.maximumOutputTokens, reservation: evalRequestReservation(selected),
  }) };
  const model = reason === "unlisted-snapshot" ? "gpt-5.4-mini-2026-03-18"
    : reason === "unlisted-suffix" ? "gpt-5.4-mini-2026-03-17-extra" : "gpt-5.4-mini-2026-03-17";
  const returned = { ...usage, model, ...(reason === "listed-partial" ? { status: "in_progress", usage: undefined } : {}) };
  const receipt = await forwardEvalRequest({ ...f, route: { ...selected, provisionalBound: bound }, payload: { ...f.payload, model: selected.price.model },
    transport: async () => new Response(JSON.stringify(returned), { headers: { "x-bt-used-endpoint": selected.endpointName! } }) });
  expect(receipt.costUsd).toBeNull();
  const replay = (await readEvalCostLedger(f.file)).state;
  expect(replay.snapshot()).toMatchObject({ knownUsd: "0.000000000", heldUsd: "0.003000000", unknownRequests: 1,
    boundedUnresolvedRequests: reason === "listed-partial" ? 1 : 0, inflight: 0 });
  expect([...replay.requests.values()][0]!.boundInvalidated === true).toBe(reason !== "listed-partial");
});

it("does not admit a declared response snapshot as the request model", async () => {
  const f = await fixture(), transport = vi.fn<typeof fetch>(), persist = vi.fn();
  const selected = { ...route, price: { ...route.price, responseModels: ["fixture-2026-03-17"] } };
  await expect(forwardEvalRequest({ ...f, route: selected, payload: { ...f.payload, model: selected.price.responseModels[0] }, transport, persist })).rejects.toThrow("unqualified_model");
  expect(transport).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  expect(f.ledger.snapshot().requests).toHaveLength(0);
});
it("retains a reviewed model bound through a partial response and durable reload without releasing the hold", async () => {
  const f = await fixture();
  const receipt = await forwardEvalRequest({ ...f, route: { ...route, provisionalBound }, transport: async () => {
    expect((await readEvalCostLedger(f.file)).state.requests.values().next().value?.bound?.evidence).toEqual(provisionalBound);
    return Response.json({ object: "response", status: "in_progress", model: "fixture" },
      { headers: { "x-bt-used-endpoint": route.endpointName! } });
  } });
  expect(receipt).toMatchObject({ costUsd: null, final: false });
  expect((await readEvalCostLedger(f.file)).state.snapshot()).toMatchObject({ boundedUnresolvedRequests: 1, heldUsd: "0.003000000" });
});
it.each(["no-headers", "route", "failover", "model", "input-limit", "output-limit"])("disqualifies a model bound on %s evidence", async reason => {
  const f = await fixture();
  await forwardEvalRequest({ ...f, route: { ...route, provisionalBound }, transport: async () => {
    if (reason === "no-headers") throw new Error("No response headers");
    return Response.json({ object: "response", status: "in_progress", model: reason === "model" ? "other" : "fixture",
      usage: { input_tokens: reason === "input-limit" ? 1001 : 10, input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
        output_tokens: reason === "output-limit" ? 101 : 0 } },
      { headers: { "x-bt-used-endpoint": reason === "route" ? "OTHER" : route.endpointName!,
        ...(reason === "failover" ? { "x-bt-failover-to": "OTHER" } : {}) } });
  } });
  const replay = (await readEvalCostLedger(f.file)).state;
  expect(replay.snapshot()).toMatchObject({ boundedUnresolvedRequests: 0, unknownRequests: 1, inflight: 0 });
  expect([...replay.requests.values()][0]!.boundInvalidated).toBe(true);
});

it("refuses a changed model limit, rate or response mapping with a stale reviewed bound before dispatch", async () => {
  const f = await fixture(), transport = vi.fn<typeof fetch>();
  for (const changed of [{ ...route, maximumInputTokens: 500 }, { ...route, price: { ...route.price, inputUsdPerMillion: "20" } },
    { ...route, price: { ...route.price, responseModels: ["fixture-2026-03-17"] } }]) {
    await expect(forwardEvalRequest({ ...f, route: { ...changed, provisionalBound }, transport })).rejects.toThrow("configuration changed");
  }
  expect(transport).not.toHaveBeenCalled();
  expect(f.ledger.snapshot().requests).toHaveLength(0);
});

it("disqualifies excessive reported input even when missing cache details prevent pricing", async () => {
  const f = await fixture();
  await forwardEvalRequest({ ...f, route: { ...route, provisionalBound }, transport: async () => Response.json({
    object: "response", status: "completed", model: "fixture", usage: { input_tokens: 1001, output_tokens: 1 },
  }, { headers: { "x-bt-used-endpoint": route.endpointName! } }) });
  expect((await readEvalCostLedger(f.file)).state.snapshot()).toMatchObject({ boundedUnresolvedRequests: 0, unknownRequests: 1, heldUsd: "0.003000000" });
});
