import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const acpxRoot = dirname(require.resolve("acpx/package.json"));
const { k: AcpClient } = await import(pathToFileURL(join(acpxRoot, "dist/live-checkpoint-BSIrfgVo.js")));
const fixture = String.raw`
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
let promptId;
readline.createInterface({input:process.stdin}).on('line',(line)=>{
 const message=JSON.parse(line);
 if (message.method==='initialize') send({id:message.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[],_meta:{receivedCapabilities:message.params.clientCapabilities}}});
 else if (message.method==='session/new') send({id:message.id,result:{sessionId:'session-1'}});
 else if (message.method==='session/prompt') {
  promptId=message.id;
  const mode=message.params.prompt[0].text;
  send({method:'fixture/activity',params:{sessionId:'session-1',value:'active'}});
  send({method:'fixture/ignored',params:{sessionId:'session-1'}});
  send({method:'fixture/activity',params:{sessionId:'wrong-session'}});
  send({id:0,method:mode==='unknown'?'fixture/not-enabled':'fixture/question',params:{sessionId:mode==='wrong-session'?'wrong-session':'session-1',value:'private-question'}});
 } else if(message.method==='pi/steer' || message.method==='pi/follow_up') {
  send({id:message.id,result:{accepted:true,sessionId:message.params.sessionId,disposition:'queued',message:message.params.message}});
 } else if(message.method==='session/cancel') { send({id:promptId,result:{stopReason:'cancelled'}}); promptId=undefined; }
 else if(message.id===0 && !message.method) {
  send({method:'session/update',params:{sessionId:'session-1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(message)}}}});
  if(promptId!==undefined) { send({id:promptId,result:{stopReason:'end_turn'}}); promptId=undefined; }
 }
});
`;

async function withClient(options, run) {
  const cwd = await mkdtemp(join(tmpdir(), "paperclip-acpx-extensions-"));
  const client = new AcpClient({
    agentCommand: "paperclip-test-verified-command", cwd, permissionMode: "approve-all",
    fs: false, terminal: false, authPolicy: "skip", elicitationModes: ["form"],
    suppressSdkConsoleErrors: true,
    spawnAgent: () => spawn(process.execPath, ["-e", fixture], { cwd, stdio: ["pipe", "pipe", "pipe"] }),
    extensionMethods: ["fixture/question", "fixture/activity"],
    ...options,
  });
  try { await client.start(); await client.createSession(); await run(client); }
  finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
}

test("real ACP stream delivers request ID zero and only allowlisted, session-bound notifications", { timeout: 10000 }, async () => {
  const requests = []; const notifications = []; const wire = [];
  await withClient({
    onAcpMessage: (direction, value) => wire.push({direction, value}),
    onExtensionRequest: async (method, params, context) => {
      requests.push({ method, params, requestId: context.requestId });
      assert.equal(context.signal.aborted, false);
      return { answer: "private-answer" };
    },
    onExtensionNotification: (method, params) => notifications.push({method, params}),
  }, async (client) => {
    assert.equal((await client.prompt("session-1", "question")).stopReason, "end_turn");
    assert.equal(requests.length, 1); assert.equal(requests[0].requestId, 0);
    assert.deepEqual(notifications, [{ method: "fixture/activity", params: { sessionId: "session-1", value: "active" } }]);
    assert.equal(wire.some(({value}) => value.method === "fixture/question"), false);
    assert.equal(wire.some(({value}) => value.id === 0 && !value.method && value.result?.answer === "private-answer"), false);
  });
});

test("initialize retains mandatory capabilities while merging provider metadata", { timeout: 10000 }, async () => {
  await withClient({ clientCapabilities: { fs: { readTextFile: true }, terminal: true, elicitation: { url: {} }, _meta: { "github.com/copilot": { events: ["session.idle"] }, jetbrains: { removed: true } } } }, async (client) => {
    const actual = client.initializeResult._meta.receivedCapabilities;
    assert.deepEqual(actual.fs, { readTextFile: false, writeTextFile: false });
    assert.equal(actual.terminal, false);
    assert.deepEqual(actual.elicitation, { form: {} });
    assert.deepEqual(actual._meta["github.com/copilot"], { events: ["session.idle"] });
    assert.deepEqual(actual._meta.jetbrains.air.capabilities, ["sessionFailure"]);
  });
});

test("real patched client sends Pi steering and follow-up while its original prompt awaits input", { timeout: 10000 }, async () => {
  let observe; const started = new Promise(resolve => { observe = resolve; });
  await withClient({ onExtensionRequest: async () => { observe(); return await new Promise(() => {}); } }, async client => {
    const pending = client.prompt("session-1", "question");
    await started;
    try {
      for (const method of ["pi/steer", "pi/follow_up"]) {
        assert.deepEqual(await client.requestExtension(method, { sessionId: "session-1", message: "Keep the original turn" }), {
          accepted: true, sessionId: "session-1", disposition: "queued", message: "Keep the original turn",
        });
      }
      for (const method of ["session/prompt", "fs/read_text_file", "initialize", "bad method/name"]) {
        await assert.rejects(client.requestExtension(method, {}), /extension method/);
      }
      await assert.rejects(client.requestExtension("pi/steer", []), /payload must be an object/);
      await assert.rejects(client.requestExtension("pi/steer", { message: "x".repeat(256 * 1024) }), /bounded size/);
    } finally {
      await client.cancel("session-1");
      assert.equal((await pending).stopReason, "cancelled");
    }
  });
});

test("unknown methods and cross-session requests never reach the host callback", { timeout: 10000 }, async () => {
  let calls = 0;
  await withClient({ onExtensionRequest: async () => { calls++; return {}; } }, async (client) => {
    await client.prompt("session-1", "unknown");
    await client.prompt("session-1", "wrong-session");
  });
  assert.equal(calls, 0);
});

test("cancellation aborts unresolved extension requests even when the callback ignores it", { timeout: 10000 }, async () => {
  let observe; const started = new Promise((resolve) => { observe = resolve; });
  let resolveCallback; let signal;
  await withClient({ onExtensionRequest: async (_method, _params, context) => {
    signal = context.signal; observe();
    return await new Promise((resolve) => { resolveCallback = resolve; });
  } }, async (client) => {
    const pending = client.prompt("session-1", "question");
    await started; await client.cancel("session-1");
    await pending; assert.equal(signal.aborted, true);
    resolveCallback({ answer: "too-late" });
  });
});

test("extension allowlists cannot replace protocol handlers or grow without bound", () => {
  const base = { agentCommand: "fixture", cwd: process.cwd(), permissionMode: "approve-all" };
  for (const method of ["session/request_permission", "fs/read_text_file", "elicitation/create", "initialize", "bad method/name"]) {
    assert.throws(() => new AcpClient({ ...base, extensionMethods: [method] }), /extension method/);
  }
  assert.throws(() => new AcpClient({ ...base, extensionMethods: Array(65).fill("fixture/method") }), /bounded allowlist/);
});

test("runtime forwards extension hooks through ephemeral client options", async () => {
  const runtime = await readFile(join(acpxRoot, "dist/runtime.js"), "utf8");
  for (const field of ["clientCapabilities", "extensionMethods", "onExtensionRequest", "onExtensionNotification"]) {
    assert.ok(runtime.includes(`${field}: this.options.${field}`));
  }
  const implementation = await readFile(join(acpxRoot, "dist/live-checkpoint-BSIrfgVo.js"), "utf8");
  const serialization = implementation.slice(implementation.indexOf("function serializeSessionRecordForDisk"), implementation.indexOf("function serializeSessionRecordForDisk") + 6000);
  assert.doesNotMatch(serialization, /onExtensionRequest|onExtensionNotification|clientCapabilities|extensionMethods/);
});
