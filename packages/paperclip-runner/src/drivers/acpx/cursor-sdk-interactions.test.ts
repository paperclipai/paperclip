import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createCursorProfileExtensionAdapter } from "./cursor-extensions.js";
const require = createRequire(import.meta.url);
const acpxRoot = dirname(require.resolve("acpx/package.json"));
const { k: AcpClient } = await import(pathToFileURL(join(acpxRoot, "dist/live-checkpoint-BSIrfgVo.js")).href);
// The fixture uses native Cursor's sessionless extension shape and request ID 0.
// The real installed ACP SDK handles the pipe; the production adapter normalizes
// answers. This is credential-free protocol coverage, not native availability.
const fixture = String.raw`
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');let prompt;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
 else if(m.method==='session/new')send({id:m.id,result:{sessionId:'cursor-session'}});
 else if(m.method==='session/prompt'){
  prompt=m.id;const plan=m.params.prompt[0].text==='plan';
  send({id:0,method:plan?'cursor/create_plan':'cursor/ask_question',params:plan
   ?{toolCallId:'plan',name:'Complete revision',plan:'1. Read\n2. Verify',todos:[],phases:[]}
   :{toolCallId:'question',questions:[{id:'native-single',prompt:'Color',options:[{id:'c',label:'Cobalt'},{id:'a',label:'Amber'}]},{id:'native-multi',prompt:'Trees',allowMultiple:true,options:[{id:'cedar',label:'Cedar'},{id:'maple',label:'Maple'}]}]}});
 }else if(m.method==='session/cancel'){send({id:prompt,result:{stopReason:'cancelled'}});prompt=undefined;}
 else if(m.id===0&&!m.method&&prompt!==undefined){
  send({method:'session/update',params:{sessionId:'cursor-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(m)}}}});
  send({id:prompt,result:{stopReason:'end_turn'}});prompt=undefined;
 }
});`;
type Context = { requestId: string | number; signal: AbortSignal; responseDelivery?: Promise<void> };
async function withClient(onRequest: (method: string, params: Record<string, unknown>, context: Context) => Promise<unknown>, run: (client: InstanceType<typeof AcpClient>, received: unknown[]) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), "cursor-sdk-")); const received: unknown[] = [];
  const client = new AcpClient({ agentCommand: "owned-fixture", cwd, permissionMode: "approve-all", fs: false, terminal: false, authPolicy: "skip", suppressSdkConsoleErrors: true,
    extensionMethods: ["cursor/ask_question", "cursor/create_plan"], onExtensionRequest: onRequest,
    spawnAgent: () => spawn(process.execPath, ["-e", fixture], { cwd, env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] }),
    onSessionUpdate: (params: { update: { content?: { type: string; text: string } } }) => { if (params.update.content?.type === "text") received.push(JSON.parse(params.update.content.text)); },
  });
  try { await client.start(); await client.createSession(); await run(client, received); }
  finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
}
it("roundtrips Cursor multi-select and revision-bound plan decisions through the installed ACP SDK", async () => {
  const deliveries: Promise<void>[] = []; let turn = 0;
  await withClient(async (method, params, context) => {
    expect(context.requestId).toBe(0); expect(params).not.toHaveProperty("sessionId");
    expect(context.responseDelivery).toBeInstanceOf(Promise); deliveries.push(context.responseDelivery!);
    const adapter = createCursorProfileExtensionAdapter({ workspacePath: tmpdir(), sessionId: "cursor-session", turnId: `turn-${++turn}` });
    const request = await adapter.request(method, { ...params, sessionId: "cursor-session" });
    if (!("input" in request)) throw new Error("Expected blocking Cursor interaction");
    const questionId = request.input.questionSet.questions[0]!.id;
    const answers = method === "cursor/ask_question"
      ? { "question-1": { selectedOptionIds: ["option-1"] }, "question-2": { selectedOptionIds: ["option-1", "option-2"] } }
      : { [questionId]: { selectedOptionIds: ["accept"] } };
    if (method === "cursor/create_plan") {
      expect(request.input.questionSet.description).toBe("1. Read\n2. Verify");
      expect(() => request.input.resolve({ action: "submit", response: { schema: "paperclip.question_response.v1", answers: { "plan-stale": { selectedOptionIds: ["accept"] } } } })).toThrow();
    }
    return request.input.resolve({ action: "submit", response: { schema: "paperclip.question_response.v1", answers } });
  }, async (client, received) => {
    expect((await client.prompt("cursor-session", "question")).stopReason).toBe("end_turn");
    expect((await client.prompt("cursor-session", "plan")).stopReason).toBe("end_turn"); await Promise.all(deliveries);
    expect(received).toEqual([
      { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "answered", answers: [{ questionId: "native-single", selectedOptionIds: ["c"] }, { questionId: "native-multi", selectedOptionIds: ["cedar", "maple"] }] } } },
      { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "accepted" } } },
    ]);
  });
});
it("cancels an unanswered Cursor request without delivering a late answer", async () => {
  const started = Promise.withResolvers<void>(); const response = Promise.withResolvers<unknown>(); let signal: AbortSignal | undefined;
  await withClient(async (_method, _params, context) => { signal = context.signal; started.resolve(); return response.promise; }, async (client, received) => {
    const prompt = client.prompt("cursor-session", "question"); await started.promise; await client.cancel("cursor-session"); await prompt;
    expect(signal?.aborted).toBe(true); response.resolve({ outcome: { outcome: "answered", answers: [] } });
    await new Promise(resolve => setImmediate(resolve)); expect(received).toEqual([]);
  });
});
