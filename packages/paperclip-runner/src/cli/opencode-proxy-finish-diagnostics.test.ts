import { expect, it } from "vitest";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
import { startOpenCodeMcpBridge } from "../drivers/opencode/mcp-bridge.js";
import { readFile } from "node:fs/promises";
import { createOpenCodeFinishDiagnosticForwarder } from "./opencode-proxy-finish-diagnostics.js";
import { createOpenCodeProxyOutput } from "./opencode-proxy-output.js";
const offered = { schema: "paperclip.opencode.finish-input-diagnostic/v1", stage: "offered", schemaSha256: "a".repeat(64) };
const rejected = { ...offered, stage: "input_rejected", callIdSha256: "b".repeat(64), validationCategory: "continuation", rootShape: "object", continuationShape: "string" };
it("retains closed diagnostics through normal warning output before an empty-response failure", async () => {
  const frames: unknown[] = [], output = createOpenCodeProxyOutput(frame => frames.push(frame));
  const forward = createOpenCodeFinishDiagnosticForwarder(output.send);
  forward.diagnostic(JSON.stringify(offered));
  expect(frames).toEqual([]);
  expect(forward.bind("actual-session")).toBe(true);
  expect(frames).toEqual([]);
  forward.diagnostic(JSON.stringify(rejected));
  output.send({ method: "turn/completed", params: { threadId: "actual-session", turn: { status: "failed", error: { code: "opencode_empty_response" } } } });
  expect(frames).toEqual([
    { method: "warning", params: { threadId: "actual-session", message: JSON.stringify(offered) } },
    { method: "warning", params: { threadId: "actual-session", message: JSON.stringify(rejected) } },
    expect.objectContaining({ method: "turn/completed" }),
  ]);
  const source = await readFile(new URL("./opencode-app-server-proxy.ts", import.meta.url), "utf8");
  expect(source).toContain("finishDiagnostics.diagnostic(message)");
  expect(source).toContain("finishDiagnostics.bind(session.ids().driverSessionId)");
  expect(source).toContain('process.stderr.write(`[opencode] ${message}\\n`)');
});
it("rejects unbound rejections, foreign binding/schema, unknown fields and arbitrary text", () => {
  const frames: unknown[] = [], forward = createOpenCodeFinishDiagnosticForwarder(frame => frames.push(frame));
  forward.diagnostic(JSON.stringify(rejected));
  forward.diagnostic("arbitrary private text");
  forward.diagnostic(JSON.stringify({ ...offered, threadId: "foreign" }));
  expect(frames).toEqual([]);
  forward.diagnostic(JSON.stringify(offered));
  expect(forward.bind("actual-session")).toBe(true);
  expect(forward.bind("foreign-session")).toBe(false);
  for (const invalid of [{ ...rejected, schemaSha256: "c".repeat(64) }, { ...rejected, input: "private" }, { ...rejected, rootShape: {} }, { ...rejected, rootShape: ["object"] }, { ...rejected, continuationShape: "invalid" }]) forward.diagnostic(JSON.stringify(invalid));
  expect(frames).toHaveLength(0);
  for (let i = 0; i < 12; i++) forward.diagnostic(JSON.stringify(rejected));
  forward.diagnostic(JSON.stringify(offered));
  expect(frames).toHaveLength(9);
  expect(JSON.stringify(frames)).not.toMatch(/private|foreign/);
});

it("forwards from the actual proxy open callback instead of losing normal semantic failure diagnostics to stderr", async () => {
  const source=await readFile(new URL("./opencode-app-server-proxy.ts",import.meta.url),"utf8");
  const body=stripTypeScriptTypes(source.slice(source.indexOf("async function open("),source.indexOf("function threadResponse(")));
  const frames:unknown[]=[],stderr:string[]=[],output=createOpenCodeProxyOutput(frame=>frames.push(frame));
  let diagnostic:(message:string)=>void=()=>{};
  class Driver {
    constructor(options:{onDiagnostic:(message:string)=>void}) { diagnostic=options.onDiagnostic; }
    async openSession() { diagnostic(JSON.stringify(offered));return {ids:()=>({driverSessionId:"actual-session",providerSessionId:"actual-session"})}; }
  }
  const invoke=new Function("OpenCodeServerDriver","createOpenCodeFinishDiagnosticForwarder","send","process",`
    let session=null,driver,eventPump,cwd,activeModel,activeCompletionContract;
    const openCodeProxyCompletionContract=()=>undefined;
    const activeRunId="run",launchBinding={},resolve=x=>x,text=(x,f="")=>typeof x==="string"?x:f,record=x=>x;
    const runtimeDirectory=()=>"/synthetic",withoutAmbientOpenCodeCommand=()=>({}),parseOpenCodeProxyPermissionMode=()=>"allow",openCodeProxyTaskEnvelope=()=>({});
    const openCodeProxyCompletionFeedback=()=>()=>{},requestController=()=>{},pumpEvents=async()=>{},failProxy=()=>{},threadResponse=id=>({thread:{id}});
    ${body}
    return open({model:"provider/model",cwd:"/synthetic"},false);
  `);
  await invoke(Driver,createOpenCodeFinishDiagnosticForwarder,output.send,{env:{},cwd:()=>"/synthetic",stderr:{write:(message:string)=>stderr.push(message)}});
  expect(frames).toEqual([]);
  diagnostic(JSON.stringify(rejected));
  diagnostic("unrelated private diagnostic");
  output.send({method:"turn/completed",params:{threadId:"actual-session",turn:{status:"failed",error:{code:"opencode_empty_response"}}}});
  expect(frames).toHaveLength(3);
  expect(frames.slice(0,2)).toEqual([offered,rejected].map(value=>({method:"warning",params:{threadId:"actual-session",message:JSON.stringify(value)}})));
  expect(stderr).toHaveLength(3);
  expect(JSON.stringify(frames)).not.toContain("unrelated private diagnostic");
});

it("keeps healthy open and success silent", () => {
  const frames:unknown[]=[],output=createOpenCodeProxyOutput(frame=>frames.push(frame));
  const forward=createOpenCodeFinishDiagnosticForwarder(output.send);
  forward.diagnostic(JSON.stringify(offered));forward.bind("healthy-session");
  output.send({method:"turn/completed",params:{threadId:"healthy-session",turn:{status:"completed"}}});
  expect(frames).toEqual([{method:"turn/completed",params:{threadId:"healthy-session",turn:{status:"completed"}}}]);
});

it("retains the actual MCP producer's offered schema and rejected shape records", async () => {
  const frames:Array<{params:{message:string}}>=[];
  const forward=createOpenCodeFinishDiagnosticForwarder(frame=>frames.push(frame));
  const bridge=await startOpenCodeMcpBridge({handler:async()=>({accepted:true}),onDiagnostic:forward.diagnostic});
  const rpc=async(id:number,method:string,params?:unknown)=>(await fetch(bridge.url,{method:"POST",headers:{Authorization:`Bearer ${bridge.secret}`,"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params})})).json() as Promise<{result:{tools:Array<{name:string;inputSchema:unknown}>;isError?:boolean}}>;
  try {
    expect(frames).toEqual([]);forward.bind("actual-session");expect(frames).toEqual([]);
    const tools=await rpc(1,"tools/list"),schema=tools.result.tools.find((tool:{name:string})=>tool.name==="paperclip_finish")!.inputSchema;
    const report={reportedWorkDisposition:"done",summary:"Synthetic complete response",completionClaim:{contractRevision:"1",objectiveSatisfied:true,criteria:[],remainingWork:[]},evidence:[],verification:[]};
    const result=await rpc(2,"tools/call",{name:"paperclip_finish",arguments:{...report,continuation:"SYNTHETIC_PRIVATE_INPUT"}});
    expect(result.result.isError).toBe(true);
    expect(frames).toHaveLength(2);
    const [actualOffered,actualRejected]=frames.map(frame=>JSON.parse(frame.params.message));
    expect(actualOffered).toEqual({...offered,schemaSha256:createHash("sha256").update(JSON.stringify(schema)).digest("hex")});
    expect(actualRejected).toEqual({...actualOffered,stage:"input_rejected",callIdSha256:createHash("sha256").update("2").digest("hex"),validationCategory:"continuation",rootShape:"object",continuationShape:"string"});
    expect(JSON.stringify(frames)).not.toContain("SYNTHETIC_PRIVATE_INPUT");
  } finally {await bridge.close();}
});
