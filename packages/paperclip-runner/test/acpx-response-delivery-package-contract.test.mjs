import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const acpxRoot = process.env.PAPERCLIP_TEST_ACPX_PACKAGE_ROOT ?? dirname(require.resolve("acpx/package.json"));
const { k: AcpClient } = await import(pathToFileURL(join(acpxRoot, "dist/live-checkpoint-BSIrfgVo.js")));
const deferred = () => Promise.withResolvers();
const nextTick = () => new Promise(resolve => setImmediate(resolve));

function tapped(write) {
  const client = new AcpClient({ agentCommand: "fixture", cwd: process.cwd(), permissionMode: "approve-all" });
  client.activePrompt = { sessionId: "session", elicitationController: new AbortController() };
  const stream = client.createTappedStream({ readable: new ReadableStream({ start() {} }), writable: new WritableStream({ write }) });
  return { client, stream, controller: client.activePrompt.elicitationController };
}

test("receipt stays pending until the exact JSON-RPC result reaches the underlying writer", async () => {
  const gate = deferred(); let receipt; let delivered = false;
  const { stream } = tapped(() => gate.promise);
  const result = await stream.withResponseDelivery(0, new AbortController().signal, async promise => {
    receipt = promise; void receipt.then(() => { delivered = true; }); return { selected: "yes" };
  });
  const writer = stream.writable.getWriter();
  const written = writer.write({ jsonrpc: "2.0", id: 0, result });
  await nextTick(); assert.equal(delivered, false);
  gate.resolve(); await written; await receipt; assert.equal(delivered, true);
  stream.abortResponseDeliveries(); writer.releaseLock();
});

for (const failure of ["write", "cancel", "disconnect", "changed", "error"]) {
  test(`receipt rejects ${failure} after callback resolution instead of falsely acknowledging delivery`, async () => {
    const gate = deferred(); let receipt;
    const { stream, controller } = tapped(() => gate.promise);
    const result = await stream.withResponseDelivery("request", new AbortController().signal, async promise => { receipt = promise; return { selected: "yes" }; });
    const rejected = assert.rejects(receipt);
    const writer = stream.writable.getWriter();
    const wire = failure === "error" ? { error: { code: -32000, message: "cancelled" } }
      : { result: failure === "changed" ? { selected: "no" } : result };
    const written = writer.write({ jsonrpc: "2.0", id: "request", ...wire });
    if (failure === "write") { const writeFailed = assert.rejects(written); gate.reject(new Error("fixture write failure")); await writeFailed; }
    else {
      if (failure === "cancel") controller.abort();
      if (failure === "disconnect") stream.abortResponseDeliveries();
      gate.resolve(); await written;
    }
    await rejected; stream.abortResponseDeliveries(); writer.releaseLock();
  });
}

test("duplicate unresolved IDs poison receipts; an old response cannot acknowledge a new request", async () => {
  let receipt; const pending = deferred();
  const { stream } = tapped(() => {});
  const first = stream.withResponseDelivery(0, new AbortController().signal, async promise => { receipt = promise; await pending.promise; return {}; });
  const rejected = assert.rejects(receipt);
  await assert.rejects(stream.withResponseDelivery(0, new AbortController().signal, async () => ({})), /duplicated/);
  await rejected; const expired = assert.rejects(first, /outlived/); pending.resolve(); await expired;
});

const fixture = String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
let promptId;
readline.createInterface({input:process.stdin}).on('line', line => {
 const message=JSON.parse(line);
 if(message.method==='initialize') send({id:message.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
 else if(message.method==='session/new') send({id:message.id,result:{sessionId:'session'}});
 else if(message.method==='session/prompt') {
  promptId=message.id; const mode=message.params.prompt[0].text;
  if(mode==='permission') send({id:0,method:'session/request_permission',params:{sessionId:'session',toolCall:{toolCallId:'tool',title:'Edit',kind:'edit',status:'pending'},options:[{optionId:'yes',name:'Allow',kind:'allow_once'},{optionId:'no',name:'Deny',kind:'reject_once'}]}});
  else if(mode==='elicitation') send({id:0,method:'elicitation/create',params:{sessionId:'session',mode:'form',message:'Choose',requestedSchema:{type:'object',properties:{name:{type:'string'}}}}});
  else send({id:0,method:'fixture/question',params:{sessionId:'session'}});
 } else if(message.id===0 && !message.method) {
  send({method:'session/update',params:{sessionId:'session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(message)}}}});
  send({id:promptId,result:{stopReason:'end_turn'}});
 }
});
`;
for (const mode of ["extension", "permission", "elicitation"]) {
  test(`real ${mode} request supplies a stream-owned receipt without callback deadlock`, { timeout: 10000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "acpx-response-delivery-"));
    let delivery; let seen = 0;
    const remember = context => { seen++; assert.ok(context.responseDelivery instanceof Promise); delivery = context.responseDelivery; };
    const client = new AcpClient({ agentCommand: "fixture", cwd, authPolicy: "skip", permissionMode: "approve-all", fs: false, terminal: false, elicitationModes: ["form"], extensionMethods: ["fixture/question"],
      spawnAgent: () => spawn(process.execPath, ["-e", fixture], { cwd, stdio: ["pipe", "pipe", "pipe"] }),
      onExtensionRequest: async (_method, _params, context) => { remember(context); return { status: "accepted" }; },
      onPermissionRequest: async (_params, context) => { remember(context); return { outcome: "allow_once" }; },
    });
    try {
      await client.start(); await client.createSession();
      const result = await client.prompt("session", mode, undefined, async (_params, context) => { remember(context); return { action: "accept", content: { name: "Paperclip" } }; });
      assert.equal(result.stopReason, "end_turn"); assert.equal(seen, 1); await delivery;
    } finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
  });
}
