import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { EVAL_OTLP_LIMITS, startEvalOtlpRelay } from "./eval-otlp-relay.js";
import { EvalAttemptTrace, exportBraintrustAttemptParent } from "./braintrust.js";
import { evalOtlpRejected, evalOtlpResponse } from "./eval-otlp-payload.js";
import { evalOtlpSchema } from "./eval-otlp-schema.js";

const projectId = "11111111-1111-4111-8111-111111111111", apiKey = "upstream-private-fixture";
const protobuf = createRequire(new URL("../../server/package.json", import.meta.url))("protobufjs") as typeof import("../../server/node_modules/protobufjs/index.js");
const message = (field: number, ...parts: Uint8Array[]) => Buffer.from(protobuf.Writer.create().uint32(field * 8 + 2).bytes(Buffer.concat(parts)).finish());
const roots: string[] = [], closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(closers.splice(0).map(close => close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.restoreAllMocks(); });
async function fixture(overrides: Partial<Parameters<typeof startEvalOtlpRelay>[0]> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "eval-otlp-")); roots.push(root);
  const policy = { projectId, apiKey, campaignId: "campaign", attemptId: "attempt", receiptPath: path.join(root, "receipts.jsonl"),
    deadlineAt: Date.now() + 60_000, ...overrides };
  const relay = await startEvalOtlpRelay(policy); closers.push(relay.close);
  const send = (body = "{}", headers: Record<string, string> = {}, endpoint = "/v1/traces") => fetch(relay.baseUrl + endpoint, {
    method: "POST", headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers }, body,
  });
  const records = async () => (await readFile(policy.receiptPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { relay, policy, send, records };
}

it("forwards real attempt protobuf over HTTP using only the controller credential and retains body-free receipts", async () => {
  const received: Array<{ authorization?: string; parent?: string; body: Buffer }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ authorization: req.headers.authorization, parent: req.headers["x-bt-parent"] as string, body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/x-protobuf" }); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  closers.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_bind_failed");
  const upstream = vi.fn<typeof fetch>((url, init) => {
    expect(String(url)).toBe("https://api.braintrust.dev/otel/v1/traces");
    expect(init?.redirect).toBe("error");
    return fetch(`http://127.0.0.1:${address.port}`, init);
  });
  const f = await fixture({ transport: upstream });
  const trace = new EvalAttemptTrace({ projectId, apiKey: f.relay.token, endpointBaseUrl: f.relay.baseUrl },
    { campaignId: "campaign", attemptId: "attempt", executionId: "fixture.local", provider: "fixture", model: "fixture", environment: "local" });
  trace.phase("setup");
  expect(await trace.export({ failed: false, runIds: [], cleanup: "passed", complaints: 0, suggestions: 0 })).toMatchObject({ status: "accepted" });
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ authorization: `Bearer ${apiKey}`, parent: `project_id:${projectId}` });
  expect(received[0]!.body.toString()).toContain("paperclip.eval.attempt");
  expect(received[0]!.body.toString()).not.toContain(f.relay.token);
  await f.relay.close();
  const records = await f.records();
  expect(records.map(row => row.type)).toEqual(["policy", "admitted", "outcome", "closed"]);
  expect(records[2]).toMatchObject({ outcome: "accepted", dispatched: true, httpStatus: 200, rejectedRecords: 0 });
  expect(records[3]).toMatchObject({ admittedRequests: 1, admittedBytes: received[0]!.body.length,
    attemptedForwardBytes: received[0]!.body.length, acceptedRequests: 1, incompleteRequests: 0 });
  expect(JSON.stringify(records)).not.toMatch(/upstream-private-fixture|paperclip.eval.attempt/);
  expect((await stat(f.policy.receiptPath)).mode & 0o777).toBe(0o600);
  await expect(startEvalOtlpRelay(f.policy)).rejects.toMatchObject({ code: "EEXIST" });
});

it("refuses token, endpoint, header and payload routing bypasses before contacting Braintrust", async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const f = await fixture({ transport: upstream });
  expect((await f.send("{}", { authorization: `Bearer ${apiKey}` })).status).toBe(401);
  expect((await f.send("{}", {}, "/../api/project")).status).toBe(404);
  expect((await f.send("{}", {}, "/v1/traces?target=other")).status).toBe(404);
  expect((await f.send("{}", { "x-bt-parent": "project_name:another" })).status).toBe(400);
  for (const attributes of [
    { resourceSpans: [{ resource: { attributes: [{ key: "braintrust.parent", value: { stringValue: "project_id:22222222-2222-4222-8222-222222222222" } }] } }] },
    { resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: [{ key: "braintrust.parent", value: { stringValue: "experiment_id:private" } }] }] }] }] },
  ]) expect((await f.send(JSON.stringify(attributes))).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
  const parent = exportBraintrustAttemptParent({ projectId, spanId: "1234567890abcdef", traceId: "abcdef0123456789abcdef0123456789" });
  expect((await f.send("{}", { "x-bt-parent": parent })).status).toBe(200);
  expect(upstream.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-bt-parent": parent });
});

it("counts decompressed payload bytes and refuses a compressed body above its allowance", async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const f = await fixture({ transport: upstream, limits: { ...EVAL_OTLP_LIMITS, maxRequestBytes: 1024 } });
  const body = JSON.stringify({ resourceLogs: [{ resource: { attributes: [{ key: "test", value: { stringValue: "private-content-canary" } }] } }] });
  const request = (bytes: Buffer) => fetch(f.relay.baseUrl + "/v1/logs", { method: "POST", body: Buffer.from(bytes),
    headers: { authorization: `Bearer ${f.relay.token}`, "content-type": "application/json", "content-encoding": "gzip" } });
  expect((await request(gzipSync(body))).status).toBe(200);
  expect((await request(gzipSync(JSON.stringify({ payload: "x".repeat(2048) })))).status).toBe(400);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(Buffer.from(upstream.mock.calls[0]![1]!.body as Uint8Array).toString()).toBe(body);
  const records = await f.records();
  expect(records[1]).toMatchObject({ signal: "logs", bodyBytes: Buffer.byteLength(body), wireBytes: gzipSync(body).length });
  expect(JSON.stringify(records)).not.toContain("private-content-canary");
});

it("rejects protobuf routing metadata and ambiguous singular fields before forwarding", async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const f = await fixture({ transport: upstream });
  const attribute = message(1, Buffer.from("braintrust.parent"));
  const foreign = message(2, message(1, Buffer.from("project_id:22222222-2222-4222-8222-222222222222")));
  const local = message(2, message(1, Buffer.from(`project_id:${projectId}`)));
  const resource = message(1, message(1, attribute, foreign));
  const bodies = [
    message(1, resource),
    message(1, resource, message(1)),
    message(1, message(1, message(1, attribute, foreign, local))),
    message(1, message(2, message(2, message(9, attribute, foreign)))),
    message(1, message(2, message(1, message(3, attribute, foreign)))),
  ];
  for (const body of bodies) {
    const response = await fetch(f.relay.baseUrl + "/v1/traces", { method: "POST", body: Buffer.from(body),
      headers: { authorization: `Bearer ${f.relay.token}`, "content-type": "application/x-protobuf" } });
    expect(response.status).toBe(400);
  }
  expect(upstream).not.toHaveBeenCalled();
});

it("canonicalizes duplicate JSON keys and refuses conflicting parent value aliases", async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const f = await fixture({ transport: upstream });
  const foreign = "project_id:22222222-2222-4222-8222-222222222222";
  const body = `{"resourceSpans":[{"resource":{"attributes":[{"key":"braintrust.parent","value":{"stringValue":"${foreign}","stringValue":"project_id:${projectId}"}}]}}]}`;
  expect((await f.send(body)).status).toBe(200);
  expect(Buffer.from(upstream.mock.calls[0]![1]!.body as Uint8Array).toString()).not.toContain(foreign);
  const ambiguous = JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "braintrust.parent",
    value: { stringValue: `project_id:${projectId}`, string_value: foreign } }] } }] });
  expect((await f.send(ambiguous)).status).toBe(400);
  expect(upstream).toHaveBeenCalledTimes(1);
});

it("does not dispatch when durable admission fails", async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const f = await fixture({ transport: upstream });
  const handle = await open(path.join(path.dirname(f.policy.receiptPath), "fixture"), "w");
  const sync = vi.spyOn(Object.getPrototypeOf(handle), "sync").mockRejectedValueOnce(new Error("fixture_disk_failure"));
  try {
    expect((await f.send()).status).toBe(503);
    expect((await f.send()).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
    await expect(f.relay.close()).rejects.toThrow("fixture_disk_failure");
  } finally { sync.mockRestore(); await handle.close(); }
});

it("bounds simultaneous exports without retrying the refused request", async () => {
  let entered!: () => void, release!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const upstream = vi.fn<typeof fetch>(async () => { entered(); await wait; return new Response(null, { status: 200 }); });
  const f = await fixture({ transport: upstream, limits: { ...EVAL_OTLP_LIMITS, maxConcurrent: 1 } });
  const first = f.send(); await active;
  try { expect((await f.send()).status).toBe(429); } finally { release(); }
  expect((await first).status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
});

it.each(["count", "bytes"])("retains failed attempts against the %s allowance without retrying or resetting", async kind => {
  const upstream = vi.fn<typeof fetch>(async () => new Response("private-vendor-error", { status: 503 }));
  const f = await fixture({ transport: upstream, limits: { ...EVAL_OTLP_LIMITS,
    ...(kind === "count" ? { maxRequests: 1 } : { maxTotalBytes: 3 }) } });
  const first = await f.send(); expect(first.status).toBe(502); expect(await first.text()).not.toContain("private-vendor-error");
  expect((await f.send()).status).toBe(429);
  expect((await f.send()).status).toBe(429);
  expect(upstream).toHaveBeenCalledTimes(1);
  await f.relay.close();
  const records = await f.records();
  expect(records.filter(row => row.type === "quota_exhausted")).toHaveLength(1);
  expect(records.find(row => row.type === "outcome")).toMatchObject({ outcome: "rejected", httpStatus: 503 });
  expect(records.at(-1)).toMatchObject({ admittedRequests: 1, admittedBytes: 2, incompleteRequests: 1 });
});

it.each(["traces", "logs"] as const)("preserves partial %s rejection without returning upstream diagnostic text", async signal => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({ partialSuccess: {
    [signal === "traces" ? "rejectedSpans" : "rejectedLogRecords"]: "2", errorMessage: "private-upstream-diagnostic" } }));
  const f = await fixture({ transport: upstream });
  const response = await f.send("{}", {}, `/v1/${signal}`);
  expect(response.status).toBe(200);
  const text = await response.text(); expect(text).not.toContain("private-upstream-diagnostic");
  expect(evalOtlpRejected(Buffer.from(text), "application/json", signal)).toBe(2);
  const protobuf = evalOtlpResponse(2, "application/x-protobuf", signal);
  expect(evalOtlpRejected(protobuf, "application/x-protobuf", signal)).toBe(2);
  expect((await f.records()).find(row => row.type === "outcome")).toMatchObject({ outcome: "partial", rejectedRecords: 2 });
});

it("aborts an in-flight export on close and retains its uncertain outcome", async () => {
  let started!: () => void, aborted = false;
  const active = new Promise<void>(resolve => { started = resolve; });
  const upstream = vi.fn<typeof fetch>(async (_url, init) => {
    started(); await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("fixture_abort")); }, { once: true }));
    return new Response(null, { status: 200 });
  });
  const f = await fixture({ transport: upstream });
  const request = f.send().catch(() => undefined); await active;
  await f.relay.close(); await request;
  expect(aborted).toBe(true);
  expect((await f.records()).find(row => row.type === "outcome")).toMatchObject({ outcome: "uncertain", dispatched: true });
  await f.relay.close();
  expect(upstream).toHaveBeenCalledTimes(1);
});

it("retires the listening endpoint at its deadline without a supervisor close", async () => {
  const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
  const f = await fixture({ transport: upstream, deadlineAt: Date.now() + 120 });
  await delay(180);
  await expect(f.send()).rejects.toThrow();
  await f.relay.close();
  expect(upstream).not.toHaveBeenCalled();
  expect((await f.records()).at(-1)).toMatchObject({ type: "closed", admittedRequests: 0 });
});

it.each(["json", "protobuf"])("meters repeated resource/scope data and full record fields in %s before dispatch", async encoding => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({}));
  const f = await fixture({ transport: upstream, limits: { ...EVAL_OTLP_LIMITS, maxExpandedBytes: 40_000 } });
  const payload = { resourceSpans: [{ resource: { attributes: [{ key: "shared", value: { stringValue: "r".repeat(3000) } }] },
    scopeSpans: [{ scope: { name: "s".repeat(1000), version: "fixture" }, spans: Array.from({ length: 4 }, () => ({
      name: "n".repeat(1000), traceId: "AQEBAQEBAQEBAQEBAQEBAQ==", spanId: "AgICAgICAgI=", flags: 1,
      startTimeUnixNano: "1234567890123456789", endTimeUnixNano: "1234567890123456790",
      events: [{ name: "e".repeat(1000), timeUnixNano: "1234567890123456789" }],
      links: [{ traceId: "AwMDAwMDAwMDAwMDAwMDAw==", spanId: "BAQEBAQEBAQ=", flags: 1 }],
    })) }] }] };
  const type = evalOtlpSchema.lookupType("TracesData");
  const body = encoding === "json" ? Buffer.from(JSON.stringify(payload)) : Buffer.from(type.encode(type.fromObject(payload)).finish());
  const send = () => fetch(f.relay.baseUrl + "/v1/traces", { method: "POST", body: Buffer.from(body),
    headers: { authorization: `Bearer ${f.relay.token}`, "content-type": encoding === "json" ? "application/json" : "application/x-protobuf" } });
  expect(body.length).toBeLessThan(20_000);
  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(429);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(Buffer.from(upstream.mock.calls[0]![1]!.body as Uint8Array)).toEqual(body);
  await f.relay.close();
  const records = await f.records(), admitted = records.find(row => row.type === "admitted");
  expect(admitted.recordCount).toBe(4);
  expect(admitted.expandedBytes).toBeGreaterThan(35_000);
  expect(records.at(-1)).toMatchObject({ admittedRecords: 4, admittedExpandedBytes: admitted.expandedBytes });
});

it("accepts thousands of small native records while bounding their total count", async () => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({}));
  const f = await fixture({ transport: upstream });
  const body = JSON.stringify({ resource_logs: [{ scope_logs: [{ log_records: Array.from({ length: 2533 }, () => ({ body: { stringValue: "event" } })) }] }] });
  expect((await f.send(body, {}, "/v1/logs")).status).toBe(200);
  expect((await f.send(body, {}, "/v1/logs")).status).toBe(429);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect((await f.records()).find(row => row.type === "admitted").recordCount).toBe(2533);
});

it("enforces the smaller default expanded-source allowance before export", async () => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({}));
  const f = await fixture({ transport: upstream });
  const body = JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [
    { body: { stringValue: "x".repeat(3 * 1024 * 1024) } },
  ] }] }] });
  expect((await f.send(body, {}, "/v1/logs")).status).toBe(200);
  expect((await f.send(body, {}, "/v1/logs")).status).toBe(200);
  expect((await f.send(body, {}, "/v1/logs")).status).toBe(429);
  expect(upstream).toHaveBeenCalledTimes(2);
  await f.relay.close();
  const rows = await f.records();
  expect(rows[0].limits.maxExpandedBytes).toBe(16 * 1024 * 1024);
  expect(rows.at(-1).admittedExpandedBytes).toBeGreaterThan(12 * 1024 * 1024);
  expect(rows.filter(row => row.type === "quota_exhausted")).toHaveLength(1);
});

it("rejects unknown protobuf fields instead of excluding forwarded data from sizing", async () => {
  const upstream = vi.fn<typeof fetch>(async () => Response.json({}));
  const f = await fixture({ transport: upstream });
  const body = message(1, message(2, message(2, message(100, Buffer.from("unknown-content")))));
  const response = await fetch(f.relay.baseUrl + "/v1/traces", { method: "POST", body,
    headers: { authorization: `Bearer ${f.relay.token}`, "content-type": "application/x-protobuf" } });
  expect(response.status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});

it("binds native relay headers and payload parents to the assigned attempt within the same project", async () => {
  const expectedParent = exportBraintrustAttemptParent({ projectId, spanId: "1234567890abcdef", traceId: "abcdef0123456789abcdef0123456789" });
  const other = exportBraintrustAttemptParent({ projectId, spanId: "abcdef0123456789", traceId: "abcdef0123456789abcdef0123456789" });
  const upstream = vi.fn<typeof fetch>(async () => Response.json({}));
  const f = await fixture({ expectedParent, transport: upstream });
  expect((await f.send()).status).toBe(400);
  expect((await f.send("{}", { "x-bt-parent": other })).status).toBe(400);
  for (const parent of [other, `project_id:${projectId}`]) {
    const body = { resourceLogs: [{ resource: { attributes: [{ key: "braintrust.parent", value: { stringValue: parent } }] } }] };
    expect((await f.send(JSON.stringify(body), { "x-bt-parent": expectedParent }, "/v1/logs")).status).toBe(400);
  }
  expect(upstream).not.toHaveBeenCalled();
  expect((await f.send("{}", { "x-bt-parent": expectedParent })).status).toBe(200);
  await f.relay.close();
  expect((await f.records())[0].expectedParent).toBe(expectedParent);
});
