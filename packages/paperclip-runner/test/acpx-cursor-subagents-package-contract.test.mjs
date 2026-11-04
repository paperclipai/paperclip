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
const fixture = String.raw`
const readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const child=(kind,sessionId='parent',extra={})=>({method:'session/update',params:{sessionId,update:{sessionUpdate:kind,subagentSessionId:'child',name:'Explore',task:'Read source',_meta:{cursor:{toolCallId:'task-1',agentId:'native-child',model:'small'}},...extra}}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='initialize')send({id:message.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
 else if(message.method==='session/new'){send(child('subagent_spawned'));send({id:message.id,result:{sessionId:'parent'}});}
 else if(message.method==='session/prompt'){
  const mode=message.params.prompt[0].text;
  if(mode==='valid'){
   send(child('subagent_spawned'));
   send({method:'session/update',params:{sessionId:'child',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'child output'}}}});
   send(child('subagent_spawned','child',{subagentSessionId:'grandchild'}));
   send(child('subagent_state_update','child',{subagentSessionId:'grandchild',state:'completed'}));
   send(child('subagent_state_update','parent',{state:'completed'}));
  }else if(mode==='foreign'){
   send(child('subagent_spawned','other-parent'));
   const missing=child('subagent_spawned');delete missing.params.sessionId;send(missing);
   send({method:'session/update',params:{sessionId:'unowned-child',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'must not become parent text'}}}});
  }else if(mode==='oversized')send(child('subagent_spawned','parent',{task:'x'.repeat(300000)}));
  else if(mode==='unknown')send(child('subagent_deleted'));
  send({method:'session/update',params:{sessionId:'parent',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'done'}}}});
  send({id:message.id,result:{stopReason:'end_turn'}});
 }
});
`;

async function withClient(options, run) {
  const cwd = await mkdtemp(join(tmpdir(), "paperclip-cursor-child-"));
  const client = new AcpClient({
    agentCommand: "paperclip-verified-cursor-fixture", cwd,
    permissionMode: "approve-all", fs: false, terminal: false, authPolicy: "skip",
    suppressSdkConsoleErrors: true,
    extensionMethods: ["cursor/subagent_update"], clientCapabilities: { _meta: { subagents: true } },
    spawnAgent: () => spawn(process.execPath, ["-e", fixture], { cwd, stdio: ["pipe", "pipe", "pipe"] }),
    ...options,
  });
  try { await client.start(); await client.createSession(); await run(client); }
  finally { await client.close(); await rm(cwd, { recursive: true, force: true }); }
}

test("pinned Cursor children survive the SDK boundary while retaining parent and native metadata", { timeout: 10000 }, async () => {
  const notifications = []; const standard = [];
  await withClient({ onExtensionNotification: (method, params) => notifications.push({ method, params }), onSessionUpdate: value => standard.push(value) }, async client => {
    assert.equal(notifications.length, 0, "pre-turn child event is not admitted");
    assert.equal((await client.prompt("parent", "valid")).stopReason, "end_turn");
    assert.deepEqual(notifications.map(value => value.method), Array(5).fill("cursor/subagent_update"));
    assert.deepEqual(notifications.map(value => value.params.update.sessionUpdate), ["subagent_spawned", "agent_message_chunk", "subagent_spawned", "subagent_state_update", "subagent_state_update"]);
    assert.equal(notifications[0].params.sessionId, "parent");
    assert.equal(notifications[0].params.update._meta.cursor.model, "small");
    assert.equal(notifications[1].params.childSessionId, "child");
    assert.equal(notifications[1].params.sessionId, "parent");
    assert.equal(notifications[2].params.parentSessionId, "child");
    assert.equal(notifications[2].params.sessionId, "parent");
    assert.equal(standard.length, 1, "standard output still follows SDK validation");
  });
});

test("child interception refuses foreign/missing parent, oversized data and unknown variants", { timeout: 10000 }, async () => {
  const notifications = []; const standard = [];
  await withClient({ onExtensionNotification: (...args) => notifications.push(args), onSessionUpdate: value => standard.push(value) }, async client => {
    for (const mode of ["foreign", "oversized", "unknown"]) await client.prompt("parent", mode);
    assert.deepEqual(notifications, []);
    assert.equal(standard.length, 3);
    assert.ok(standard.every(value => value.sessionId === "parent"));
  });
});

test("subagent compatibility is opt-in and rejects old stream, settled turn and aborted connection authority", { timeout: 10000 }, async () => {
  for (const options of [{ extensionMethods: [] }, { clientCapabilities: {} }]) {
    const notifications = [];
    await withClient({ ...options, onExtensionNotification: (...args) => notifications.push(args) }, async client => {
      await client.prompt("parent", "valid");
      assert.deepEqual(notifications, []);
    });
  }
  const notifications = [];
  const client = new AcpClient({ agentCommand: "fixture", cwd: tmpdir(), permissionMode: "approve-all", extensionMethods: ["cursor/subagent_update"], clientCapabilities: { _meta: { subagents: true } }, onExtensionNotification: (...args) => notifications.push(args) });
  const current = { active: null, children: new Map() }; const old = { active: null, children: new Map() };
  const turn = new AbortController(); const connection = new AbortController();
  client.cursorSubagentStreamOwner = current;
  client.activePrompt = { sessionId: "parent", elicitationController: turn };
  client.connection = { signal: connection.signal };
  const message = { method: "session/update", params: { sessionId: "parent", update: { sessionUpdate: "subagent_spawned", subagentSessionId: "child" } } };
  assert.equal(client.handleCursorSubagentNotification(message, old), true);
  assert.equal(notifications.length, 0);
  client.handleCursorSubagentNotification(message, current);
  assert.equal(notifications.length, 1);
  turn.abort(); client.handleCursorSubagentNotification(message, current);
  assert.equal(notifications.length, 1);
  client.activePrompt = { sessionId: "parent", elicitationController: new AbortController() };
  connection.abort(); client.handleCursorSubagentNotification(message, current);
  assert.equal(notifications.length, 1);
  client.activePrompt = null; client.handleCursorSubagentNotification(message, current);
  assert.equal(notifications.length, 1);
});
