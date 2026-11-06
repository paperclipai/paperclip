import { expect, it } from "vitest";
import { stripTypeScriptTypes } from "node:module";
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
  expect(frames).toHaveLength(1);
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
    let session=null,driver,eventPump,cwd,activeModel;
    const activeRunId="run",launchBinding={},resolve=x=>x,text=(x,f="")=>typeof x==="string"?x:f,record=x=>x;
    const runtimeDirectory=()=>"/synthetic",withoutAmbientOpenCodeCommand=()=>({}),parseOpenCodeProxyPermissionMode=()=>"allow",openCodeProxyTaskEnvelope=()=>({});
    const openCodeProxyCompletionFeedback=()=>()=>{},requestController=()=>{},pumpEvents=async()=>{},failProxy=()=>{},threadResponse=id=>({thread:{id}});
    ${body}
    return open({model:"provider/model",cwd:"/synthetic"},false);
  `);
  await invoke(Driver,createOpenCodeFinishDiagnosticForwarder,output.send,{env:{},cwd:()=>"/synthetic",stderr:{write:(message:string)=>stderr.push(message)}});
  diagnostic(JSON.stringify(rejected));
  diagnostic("unrelated private diagnostic");
  output.send({method:"turn/completed",params:{threadId:"actual-session",turn:{status:"failed",error:{code:"opencode_empty_response"}}}});
  expect(frames).toHaveLength(3);
  expect(frames.slice(0,2)).toEqual([offered,rejected].map(value=>({method:"warning",params:{threadId:"actual-session",message:JSON.stringify(value)}})));
  expect(stderr).toHaveLength(3);
  expect(JSON.stringify(frames)).not.toContain("unrelated private diagnostic");
});
