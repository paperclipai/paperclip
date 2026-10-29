import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { parseProviderPerformanceSpans, PROVIDER_PERFORMANCE_DIAGNOSTIC } from "../../contracts/provider-performance.js";
import { startOpenCodePerformanceDiagnostics } from "./performance-diagnostics.js";

function batch(spans: unknown[]) { return { resourceSpans: [{resource:{attributes:[{key:"secret",value:"credential"}]},scopeSpans:[{spans}]}]}; }
function span(name = "ai.streamText", extra = {}) {
  const now=Date.now();
  return {name,startTimeUnixNano:String(BigInt(now-10)*1000000n),endTimeUnixNano:String(BigInt(now)*1000000n),
    attributes:[{key:"Authorization",value:{stringValue:"Bearer private"}},{key:"prompt",value:{stringValue:"private task"}}],
    events:[{name:"private content"}],...extra};
}

describe("OpenCode content-free performance sink",()=>{
  it("accepts authenticated loopback OTLP and projects only closed phase names and timings",async()=>{
    const sink=await startOpenCodePerformanceDiagnostics();
    const url=sink.environment.OTEL_EXPORTER_OTLP_ENDPOINT;
    const headers={Authorization:sink.environment.OTEL_EXPORTER_OTLP_HEADERS.slice("Authorization=".length)};
    try {
      expect((await fetch(url+"/v1/traces",{method:"POST",body:JSON.stringify(batch([span()]))})).status).toBe(401);
      expect(sink.take()).toBeNull();
      expect((await fetch(url+"/v1/traces",{method:"POST",headers,body:JSON.stringify(batch([
        span(),span("Snapshot.track",{status:{code:2}}),span("private-provider-name"),span("__proto__"),span("toString"),
      ]))})).status).toBe(200);
      const diagnostic=sink.take()!;
      expect(diagnostic.code).toBe(PROVIDER_PERFORMANCE_DIAGNOSTIC);
      expect(diagnostic.spans.map(s=>[s.name,s.outcome])).toEqual([["provider.model.stream","ok"],["provider.workspace.snapshot.track","failed"]]);
      expect(diagnostic.spans[0].endedAtMs-diagnostic.spans[0].startedAtMs).toBeCloseTo(10, 2);
      expect(JSON.stringify(diagnostic)).not.toMatch(/private|Authorization|prompt|credential/);
      expect(Object.keys(diagnostic.spans[0]).sort()).toEqual(["endedAtMs","name","outcome","startedAtMs"]);
      expect(sink.take()).toBeNull();
      expect((await fetch(url+"/v1/logs",{method:"POST",headers,body:'{"private":"discard"}'})).status).toBe(200);
      expect(sink.take()).toBeNull();
    } finally {await sink.close();}
    await expect(fetch(url+"/v1/traces")).rejects.toThrow();
  });

  it("bounds bodies, malformed timestamps and repeated spans and drops prior-turn exports",async()=>{
    const sink=await startOpenCodePerformanceDiagnostics();
    const url=sink.environment.OTEL_EXPORTER_OTLP_ENDPOINT;
    const headers={Authorization:sink.environment.OTEL_EXPORTER_OTLP_HEADERS.slice("Authorization=".length)};
    const post=(body:string)=>fetch(url+"/v1/traces",{method:"POST",headers,body});
    try {
      expect((await post("x".repeat(1024*1024+1))).status).toBe(413);
      expect((await post("invalid json")).status).toBe(400);
      expect((await post(JSON.stringify(batch([
        span("ai.streamText",{endTimeUnixNano:"NaN"}),span("ai.streamText",{endTimeUnixNano:"1"}),
        ...Array.from({length:200},()=>span()),
      ])))).status).toBe(200);
      expect(sink.take()!.spans).toHaveLength(16);
      await post(JSON.stringify(batch([span()])));
      expect(sink.take(Date.now()+100)).toBeNull();
    }finally{await sink.close();}
  });

  it("validates the shared diagnostic again before server export",()=>{
    const now=Date.now();
    const safe={name:"provider.model.stream",startedAtMs:now-20,endedAtMs:now,outcome:"ok",prompt:"private"};
    const parsed=parseProviderPerformanceSpans({code:PROVIDER_PERFORMANCE_DIAGNOSTIC,spans:[
      safe,{...safe,name:"private"},{...safe,startedAtMs:Infinity},{...safe,endedAtMs:now+2000},
      {...safe,startedAtMs:now-86400001},{...safe,endedAtMs:now-30},
    ]},now);
    expect(parsed).toEqual([{name:safe.name,startedAtMs:now-20,endedAtMs:now,outcome:"ok"}]);
    expect(parseProviderPerformanceSpans({code:"other",spans:[safe]},now)).toEqual([]);
  });
});

it("forwards real metadata with parent-held auth, strips content and isolates collection from redirects", async () => {
  const received: Array<{authorization: string | undefined; token: string | string[] | undefined; body: unknown}> = [];
  let redirect = false;
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ authorization: request.headers.authorization, token: request.headers["x-auth_token"], body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(redirect ? 302 : 200, redirect ? { Location: "http://127.0.0.1:1/must-not-follow" } : {}).end("{}");
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const sink = await startOpenCodePerformanceDiagnostics({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: `Authorization=${encodeURIComponent("Bearer synthetic-upstream-secret")},x-auth_token=${encodeURIComponent("synthetic-header-café")}`,
    OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=company,paperclip.agent.id=agent,paperclip.observability.revision=revision",
  }, false);
  const nativeSpan = span("ai.streamText", { traceId: "1".repeat(32), spanId: "2".repeat(16), parentSpanId: "3".repeat(16), status: { code: 2, message: "private" } });
  const post = () => fetch(sink.environment.OTEL_EXPORTER_OTLP_ENDPOINT + "/v1/traces", { method: "POST",
    headers: { Authorization: sink.environment.OTEL_EXPORTER_OTLP_HEADERS.slice("Authorization=".length) },
    body: JSON.stringify(batch([nativeSpan, span("private"), span("ai.streamText", { traceId: "bad", spanId: "bad" })])) });
  try {
    expect(JSON.stringify(sink.environment)).not.toContain("synthetic-upstream-secret");
    expect((await post()).status).toBe(200);
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]!.authorization).toBe("Bearer synthetic-upstream-secret");
    expect(received[0]!.token).toBe("synthetic-header-café");
    const body = received[0]!.body as {resourceSpans: Array<{resource: unknown; scopeSpans: Array<{spans: unknown[]}>}>};
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans).toEqual([{ traceId: nativeSpan.traceId, spanId: nativeSpan.spanId,
      parentSpanId: nativeSpan.parentSpanId, name: nativeSpan.name, startTimeUnixNano: nativeSpan.startTimeUnixNano,
      endTimeUnixNano: nativeSpan.endTimeUnixNano, status: { code: 2 } }]);
    expect(JSON.stringify(body)).toContain('"paperclip.observability.revision"');
    expect(JSON.stringify(body)).not.toMatch(/private|Authorization|prompt|credential|synthetic-upstream/);
    expect(sink.take()).toBeNull();
    redirect = true; expect((await post()).status).toBe(200);
    await expect.poll(() => received.length).toBe(2);
  } finally { await sink.close(); await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }); }
});
it("accepts configured internal HTTP collectors without contacting them during setup", async () => {
  const sink = await startOpenCodePerformanceDiagnostics({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.internal/otel/v1/traces",
    OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=company,paperclip.agent.id=agent,paperclip.observability.revision=revision",
  }, false);
  await sink.close();
});
it("refuses incomplete attribution and unsafe destination URLs", async () => {
  for (const environment of [
    ... ["ftp://collector.test/v1/traces", "https://user:password@collector.test/v1/traces", "https://collector.test/v1/traces?token=secret"].map(endpoint => ({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
      OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=company,paperclip.agent.id=agent,paperclip.observability.revision=revision",
    })),
    { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.test/v1/traces", OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=company" },
  ]) await expect(startOpenCodePerformanceDiagnostics(environment)).rejects.toThrow();
});

it("caps outstanding export requests and closes a stalled destination without blocking native ingestion", async () => {
  let accepted = 0;
  const diagnostics: string[] = [];
  const upstream = createServer((request, _response) => { accepted++; request.resume(); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const sink = await startOpenCodePerformanceDiagnostics({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
    OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=company,paperclip.agent.id=agent,paperclip.observability.revision=revision" }, false, reason => diagnostics.push(reason));
  const post = () => fetch(sink.environment.OTEL_EXPORTER_OTLP_ENDPOINT + "/v1/traces", { method: "POST",
    headers: { Authorization: sink.environment.OTEL_EXPORTER_OTLP_HEADERS.slice("Authorization=".length) },
    body: JSON.stringify(batch([span("ai.streamText", {traceId: "1".repeat(32), spanId: "2".repeat(16)})])) });
  try {
    expect((await post()).status).toBe(200); expect((await post()).status).toBe(200);
    await expect.poll(() => accepted).toBe(2);
    expect((await post()).status).toBe(200); expect(accepted).toBe(2);
    expect(diagnostics).toEqual(["capacity"]);
  } finally { await sink.close(); await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }); }
}, 5000);

it("bounds each export batch without permanently exhausting later session exports", async () => {
  const sizes: number[] = [], diagnostics: string[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const data = JSON.parse(Buffer.concat(chunks).toString());
    sizes.push(data.resourceSpans[0].scopeSpans[0].spans.length); response.end("{}");
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const sink = await startOpenCodePerformanceDiagnostics({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
    OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=company,paperclip.agent.id=agent,paperclip.observability.revision=revision" }, false, reason => diagnostics.push(reason));
  const post = (count: number) => fetch(sink.environment.OTEL_EXPORTER_OTLP_ENDPOINT + "/v1/traces", { method: "POST",
    headers: { Authorization: sink.environment.OTEL_EXPORTER_OTLP_HEADERS.slice("Authorization=".length) },
    body: JSON.stringify(batch(Array.from({length: count}, () => span("ai.streamText", {traceId: "1".repeat(32), spanId: "2".repeat(16)})))) });
  try {
    for (let index = 0; index < 3; index++) { expect((await post(129)).status).toBe(200); await expect.poll(() => sizes.length).toBe(index + 1); }
    expect(sizes).toEqual([128, 128, 128]); expect(diagnostics).toEqual(["batch_limit"]);
  } finally { await sink.close(); await new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }); }
});

it("rejects non-ByteString collector headers before declaring the sink available", async () => {
  await expect(startOpenCodePerformanceDiagnostics({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector.internal/v1/traces",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: `Authorization=${encodeURIComponent("synthetic-header-Ā")}`,
    OTEL_RESOURCE_ATTRIBUTES: "paperclip.company.id=company,paperclip.agent.id=agent,paperclip.observability.revision=revision" }, false)).rejects.toThrow();
});
