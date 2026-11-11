import { afterEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({parent:undefined as unknown, spans:[] as any[]}));
vi.mock("@opentelemetry/api",()=>({SpanStatusCode:{ERROR:2},trace:{
 getTracer:()=>({startSpan:(name:string,options:unknown,parent:unknown)=>{const span={name,options,parent,end:vi.fn(),setStatus:vi.fn()};mocks.spans.push(span);return span;}}),
 setSpan:(parent:unknown,span:unknown)=>({parent,span}),
}}));
vi.mock("@paperclipai/adapter-utils/acpx-engine/startup-timing",()=>({
 getActiveStepContext:()=>mocks.parent?{parentContext:mocks.parent}:null,
 runWithRuntimeParent:(_parent:unknown,work:()=>unknown)=>work(),
}));
import { measureRunnerOperation, recordRunnerTimingReceipt } from "./runner-operation-timing.js";
afterEach(()=>{vi.unstubAllEnvs();mocks.spans=[];mocks.parent=undefined;});
describe("Runner operation ownership",()=>{
 it("does no tracer work when disabled and preserves the operation",async()=>{
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT","");mocks.parent={run:"a"};let count=0;
  expect(await measureRunnerOperation("runner.transport.resume",async()=>++count)).toBe(1);
  expect(mocks.spans).toEqual([]);
 });
 it("reads each current run parent and closes concurrent failures",async()=>{
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT","http://collector.test");
  const a={run:"a"},b={run:"b"};mocks.parent=a;
  let done!:()=>void;const pending=measureRunnerOperation("runner.transport.resume",()=>new Promise<void>(resolve=>done=resolve));
  await Promise.resolve();mocks.parent=b;
  const error=Error("private");await expect(measureRunnerOperation("runner.transport.attach",async()=>{throw error;})).rejects.toBe(error);
  done();await pending;
  expect(mocks.spans.map(span=>span.parent)).toEqual([a,b]);
  expect(mocks.spans.every(span=>span.end.mock.calls.length===1)).toBe(true);
  expect(mocks.spans[1].setStatus).toHaveBeenCalledWith({code:2});
 });
 it("validates numeric receipt bounds and rejects names or content",()=>{
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT","http://collector.test");mocks.parent={run:"a"};
  recordRunnerTimingReceipt({runnerMs:100,roundTripMs:120,sidecarMs:80,statusMs:30,promptMs:40,statusOffsetMs:0,promptOffsetMs:40,secret:"private"});
  expect(mocks.spans.map(span=>span.name)).toEqual(["runner.remote.turn_start","runner.sidecar.turn_start","runner.sidecar.status_read","runner.sidecar.prompt_started"]);
  expect(JSON.stringify(mocks.spans)).not.toContain("private");
  recordRunnerTimingReceipt({runnerMs:10,roundTripMs:120,sidecarMs:80,statusMs:30,promptMs:40,statusOffsetMs:0,promptOffsetMs:40});
  recordRunnerTimingReceipt({runnerMs:100,roundTripMs:120,sidecarMs:80,statusMs:NaN,promptMs:40,statusOffsetMs:0,promptOffsetMs:40});
  expect(mocks.spans).toHaveLength(4);
 });
});
