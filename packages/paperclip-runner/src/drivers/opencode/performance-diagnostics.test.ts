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
