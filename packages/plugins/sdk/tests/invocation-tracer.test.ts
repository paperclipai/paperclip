import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { createInvocationTracer } from "../src/invocation-tracer.js";
import type { PluginSpanRecord } from "../src/protocol.js";

describe("invocation timing receipts",()=>{
 it("keeps concurrent roots and nested failures separate",async()=>{
  const records:PluginSpanRecord[]=[];
  const tracer=createInvocationTracer(()=>true,span=>records.push(span));
  let release!:()=>void;
  const waiting=new Promise<void>(resolve=>release=resolve);
  const first=tracer.withSpan("first",async()=>{await waiting;return tracer.withSpan("child",async()=>42);});
  const error=new Error("private");
  await expect(tracer.withSpan("second",()=>tracer.withSpan("failed",async()=>{throw error;}))).rejects.toBe(error);
  release();expect(await first).toBe(42);
  expect(records.map(span=>span.name)).toEqual(["second","first"]);
  expect(records[0].children?.[0].status).toEqual({code:2});
  expect(records[1].children?.[0].name).toBe("child");
  for(const span of records) expect(span.endTimeMs!).toBeGreaterThanOrEqual(span.startTimeMs!);
  expect(JSON.stringify(records)).not.toContain("private");
 });
 it("is inert without an invocation trace and isolates recording failures",async()=>{
  const records:PluginSpanRecord[]=[];
  let count=0;
  const disabled=createInvocationTracer(()=>false,span=>records.push(span));
  expect(await disabled.withSpan("disabled",async()=>++count)).toBe(1);
  expect(records).toEqual([]);
  const broken=createInvocationTracer(()=>true,()=>{throw Error("export");});
  expect(await broken.withSpan("broken",async()=>++count)).toBe(2);
 });
 it("bounds children and excludes detached work after its parent closes",async()=>{
  const records:PluginSpanRecord[]=[];const tracer=createInvocationTracer(()=>true,span=>records.push(span));
  let detached!:()=>Promise<void>;
  await tracer.withSpan("root",async()=>{
   for(let n=0;n<300;n++)await tracer.withSpan("child",async()=>{});
   detached=AsyncLocalStorage.bind(()=>tracer.withSpan("late",async()=>{}));
  });
  expect(records[0].children).toHaveLength(255);
  await detached();expect(records).toHaveLength(1);
 });
});

it("uses one monotonic origin across children even if the epoch clock changes",async()=>{
 const records:PluginSpanRecord[]=[];const tracer=createInvocationTracer(()=>true,span=>records.push(span));
 const clock=vi.spyOn(Date,"now").mockReturnValueOnce(1000).mockReturnValue(999999);
 try {await tracer.withSpan("root",async()=>{await tracer.withSpan("child",async()=>{});});}
 finally {clock.mockRestore();}
 const root=records[0],child=root.children![0];
 expect(child.startTimeMs!).toBeGreaterThanOrEqual(root.startTimeMs!);
 expect(child.endTimeMs!).toBeLessThanOrEqual(root.endTimeMs!);
 expect(root.endTimeMs!).toBeLessThan(999999);
});
it("consumes excess legacy records instead of falling back to standalone export",async()=>{
 const tracer=createInvocationTracer(()=>true,()=>{});
 await tracer.withSpan("root",async()=>{
  for(let n=0;n<300;n++)expect(tracer.recordSpan({name:"pack"})).toBe(true);
 });
});

it("manual spans retain their creation scope when ended inside a nested operation",async()=>{
 const records:PluginSpanRecord[]=[];const tracer=createInvocationTracer(()=>true,span=>records.push(span));
 await tracer.withSpan("root",async()=>{
  const record=tracer.captureRecorder(),startTimeMs=tracer.now();
  await tracer.withSpan("nested",async()=>{record({name:"manual",startTimeMs,endTimeMs:tracer.now()});});
 });
 expect(records[0].children?.map(span=>span.name)).toEqual(["nested","manual"]);
 expect(records[0].children?.[0].children).toEqual([]);
});
