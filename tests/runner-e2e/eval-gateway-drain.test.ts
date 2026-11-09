import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openEvalCostLedger, readEvalCostLedger } from "./cost-ledger.js";
import { startEvalRemoteBridge } from "./eval-remote-gateway.js";
import { forwardEvalRequest, startEvalGateway, type EvalGatewayReceipt, type EvalGatewayRoute } from "./eval-gateway.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(provider: "openai" | "anthropic" = "openai", timeoutMs = 2000) {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-drain-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ledger.jsonl"), deadlineAt = Date.now() + 30_000;
  const ledger = await openEvalCostLedger(file, { campaignId: "drain", maxUsd: "1", deadlineAt: new Date(deadlineAt).toISOString(), maxRequests: 2, maxConcurrent: 1 });
  cleanups.push(() => ledger.close());
  const route: EvalGatewayRoute = { provider, mode: "braintrust", apiKey: "private-upstream", projectId: "11111111-1111-4111-8111-111111111111",
    endpointName: "DEDICATED", maximumInputTokens: 1000, maximumOutputTokens: 100, timeoutMs,
    price: { provider, model: "fixture", version: "fixture-v1", sourceUrl: "https://provider.invalid/prices", inputUsdPerMillion: "2", cachedReadUsdPerMillion: "1",
      outputUsdPerMillion: "10", cacheWrite30mUsdPerMillion: "2", cacheWrite12hUsdPerMillion: "2", cacheWrite5mUsdPerMillion: "2", cacheWrite1hUsdPerMillion: "2" } };
  const receipts: EvalGatewayReceipt[] = [];
  return { file, ledger, deadlineAt, route, identity: { executionId: "execution", attemptId: "attempt", phase: "agent" as const }, receipts,
    persist: async (receipt: EvalGatewayReceipt) => { receipts.push(structuredClone(receipt)); } };
}

function finalResponse(provider: "openai" | "anthropic") {
  return Response.json(provider === "openai"
    ? { object: "response", status: "completed", id: "provider-response", model: "fixture", usage: { input_tokens: 10,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 5 } }
    : { type: "message", id: "provider-response", model: "fixture", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } },
  { headers: { "x-bt-used-endpoint": "DEDICATED", "x-bt-cached": "MISS" } });
}

function request(gateway: Awaited<ReturnType<typeof startEvalGateway>>, provider = "openai", signal?: AbortSignal) {
  return fetch(`${gateway.baseUrl}/${provider === "openai" ? "responses" : "messages"}`, { method: "POST", signal,
    headers: { authorization: `Bearer ${gateway.token}` }, body: JSON.stringify({ model: "fixture", input: "hello", messages: [] }) }).catch(error => error);
}

it.each(["openai", "anthropic"] as const)("retains late %s usage after a client disconnect and gateway shutdown without retrying", async provider => {
  const f = await fixture(provider), started = deferred<void>(), release = deferred<void>();
  let upstreamSignal!: AbortSignal;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    upstreamSignal = init!.signal!;
    started.resolve();
    await Promise.race([release.promise, new Promise<never>((_resolve, reject) => upstreamSignal.addEventListener("abort", () => reject(upstreamSignal.reason), { once: true }))]);
    return finalResponse(provider);
  });
  const gateway = await startEvalGateway({ ...f, transport }); cleanups.push(() => gateway.close());
  const client = new AbortController(), result = request(gateway, provider, client.signal);
  await started.promise;
  client.abort();
  const closing = gateway.close();
  release.resolve();
  await closing;
  expect(await result).not.toBeInstanceOf(Response);
  expect(transport).toHaveBeenCalledOnce();
  expect(f.receipts.at(-1)).toMatchObject({ outcome: "cancelled", clientDisconnected: true, final: true, usageComplete: true, costUsd: "0.000070000" });
  expect(f.ledger.snapshot()).toMatchObject({ knownUsd: "0.000070000", heldUsd: "0.000000000", inflight: 0, unknownRequests: 0 });
  expect((await readEvalCostLedger(f.file)).state.snapshot()).toEqual(f.ledger.snapshot());
  await gateway.close();
});

it("stops accepting work during drain and retains the hold if five-second grace expires", async () => {
  const f = await fixture("openai", 30_000), started = deferred<void>();
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    started.resolve();
    await new Promise<never>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    return finalResponse("openai");
  });
  const gateway = await startEvalGateway({ ...f, transport }); cleanups.push(() => gateway.close());
  const first = request(gateway); await started.promise;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let finished = false;
  const closing = gateway.close().then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(4900);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  await closing; vi.useRealTimers();
  expect(await first).not.toBeInstanceOf(Response);
  expect(await request(gateway)).not.toBeInstanceOf(Response);
  expect(transport).toHaveBeenCalledOnce();
  expect(f.receipts.at(-1)).toMatchObject({ outcome: "cancelled", clientDisconnected: true, final: false, costUsd: null });
  expect(f.ledger.snapshot()).toMatchObject({ inflight: 0, unknownRequests: 1, heldUsd: "0.003000000" });
});

it("keeps the original provider deadline when shutdown grace is longer", async () => {
  const f = await fixture("openai", 50), started = deferred<void>();
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    started.resolve();
    await new Promise<never>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
    return finalResponse("openai");
  });
  const gateway = await startEvalGateway({ ...f, transport }); cleanups.push(() => gateway.close());
  const first = request(gateway); await started.promise;
  const before = Date.now(); await gateway.close();
  expect(Date.now() - before).toBeLessThan(1000);
  await first;
  expect(f.ledger.snapshot()).toMatchObject({ inflight: 0, unknownRequests: 1, heldUsd: "0.003000000" });
});

it("does not dispatch a disconnected request still resolving its identity", async () => {
  const f = await fixture(), resolving = deferred<void>(), identity = deferred<typeof f.identity>();
  const transport = vi.fn<typeof fetch>(async () => finalResponse("openai"));
  const gateway = await startEvalGateway({ ...f, transport, resolveIdentity: async () => { resolving.resolve(); return identity.promise; } });
  cleanups.push(() => gateway.close());
  const first = request(gateway); await resolving.promise;
  const closing = gateway.close(); identity.resolve(f.identity); await closing; await first;
  expect(transport).not.toHaveBeenCalled();
  expect(f.ledger.snapshot().requests).toHaveLength(0);
});

it("drains an existing SSE stream after the client stops reading", async () => {
  const f = await fixture(), release = deferred<void>();
  const complete = { object: "response", status: "completed", id: "stream-response", model: "fixture",
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 5 } };
  const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'));
      void release.promise.then(() => {
        controller.enqueue(Buffer.from(`data: ${JSON.stringify({ type: "response.completed", response: complete })}\n\n`));
        controller.close();
      });
    },
  }), { headers: { "content-type": "text/event-stream", "x-bt-used-endpoint": "DEDICATED" } }));
  const gateway = await startEvalGateway({ ...f, transport }); cleanups.push(() => gateway.close());
  const response = await request(gateway);
  expect(response).toBeInstanceOf(Response);
  const reader = response.body.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
  const closing = gateway.close(); release.resolve(); await closing;
  expect(transport).toHaveBeenCalledOnce();
  expect(f.receipts.at(-1)).toMatchObject({ outcome: "cancelled", clientDisconnected: true, final: true, costUsd: "0.000070000" });
  expect(f.ledger.snapshot()).toMatchObject({ inflight: 0, unknownRequests: 0, heldUsd: "0.000000000" });
});

it("retains cancellation and final usage without closing the gateway", async () => {
  const f = await fixture(), started = deferred<void>(), release = deferred<void>();
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    started.resolve();
    await Promise.race([release.promise, new Promise<never>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }))]);
    return finalResponse("openai");
  });
  const gateway = await startEvalGateway({ ...f, transport }); cleanups.push(() => gateway.close());
  const client = new AbortController(), result = request(gateway, "openai", client.signal);
  await started.promise;
  client.abort(); await result;
  release.resolve();
  await vi.waitFor(() => expect(f.ledger.snapshot().inflight).toBe(0));
  expect(f.receipts.at(-1)).toMatchObject({ outcome: "cancelled", clientDisconnected: true, final: true, costUsd: "0.000070000" });
  expect(f.ledger.snapshot()).toMatchObject({ knownUsd: "0.000070000", heldUsd: "0.000000000", unknownRequests: 0 });
  expect(transport).toHaveBeenCalledOnce();
});

it.each(["persist", "observe", "finish"] as const)("records a disconnect during final %s without losing complete usage", async stage => {
  const f = await fixture(), reached = deferred<void>(), release = deferred<void>(), downstream = new AbortController();
  let blocked = false;
  const pause = async (current: typeof stage) => {
    if (current !== stage || blocked) return;
    blocked = true; reached.resolve(); await release.promise;
  };
  const ledger = { ...f.ledger,
    observe: async (...args: Parameters<typeof f.ledger.observe>) => { await pause("observe"); return f.ledger.observe(...args); },
    finish: async (...args: Parameters<typeof f.ledger.finish>) => { await pause("finish"); return f.ledger.finish(...args); },
  };
  const transport = vi.fn<typeof fetch>(async () => finalResponse("openai"));
  const result = forwardEvalRequest({ ...f, ledger, payload: { model: "fixture", input: "hello" }, downstreamSignal: downstream.signal,
    transport, onHeaders: () => {}, onChunk: async () => {}, persist: async receipt => {
      await f.persist(receipt); if (receipt.final) await pause("persist");
    } });
  await reached.promise; downstream.abort(); release.resolve();
  expect(await result).toMatchObject({ outcome: "cancelled", clientDisconnected: true, final: true, costUsd: "0.000070000" });
  expect(f.receipts.at(-1)).toMatchObject({ outcome: "cancelled", clientDisconnected: true, final: true });
  const events = (await readFile(f.file, "utf8")).trim().split("\n").map(line => JSON.parse(line).event);
  expect(events.filter(event => event.type === "finish").at(-1)).toMatchObject({ outcome: "cancelled" });
  expect(f.ledger.snapshot()).toMatchObject({ knownUsd: "0.000070000", heldUsd: "0.000000000", unknownRequests: 0 });
  expect(transport).toHaveBeenCalledOnce();
});

it("retains terminal usage when a remote bridge client disconnects during shutdown", async () => {
  const f = await fixture(), started = deferred<void>(), release = deferred<void>();
  const transport = vi.fn<typeof fetch>(async () => { started.resolve(); await release.promise; return finalResponse("openai"); });
  const gateway = await startEvalGateway({ ...f, transport }); cleanups.push(() => gateway.close());
  const bridge = await startEvalRemoteBridge({ gateway, deadlineAt: f.deadlineAt }); cleanups.push(() => bridge.close());
  const client = new AbortController();
  const result = fetch(bridge.baseUrl + "/responses", { method: "POST", signal: client.signal,
    headers: { authorization: `Bearer ${gateway.token}` }, body: JSON.stringify({ model: "fixture", input: "hello" }) }).catch(error => error);
  await started.promise; client.abort(); await bridge.close();
  const closing = gateway.close(); release.resolve(); await closing;
  expect(await result).not.toBeInstanceOf(Response);
  expect(transport).toHaveBeenCalledOnce();
  expect(f.receipts.at(-1)).toMatchObject({ clientDisconnected: true, final: true, usageComplete: true, costUsd: "0.000070000" });
  expect(f.ledger.snapshot()).toMatchObject({ knownUsd: "0.000070000", heldUsd: "0.000000000", unknownRequests: 0, inflight: 0 });
});
