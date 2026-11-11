import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const root = process.env.PAPERCLIP_TEST_ACPX_ROOT ?? dirname(require.resolve("acpx/package.json"));
const { createAcpRuntime, createAgentRegistry, createFileSessionStore } = await import(pathToFileURL(join(root, "dist/runtime.js")));
const fixture = String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.method==='initialize') send({id:request.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{close:{}}},authMethods:[]}});
 else if(request.method==='session/new') send({id:request.id,result:{sessionId:'fixture-session'}});
 else if(request.method==='session/prompt') {
  for(const update of JSON.parse(request.params.prompt[0].text)) send({method:'session/update',params:{sessionId:'fixture-session',update}});
  send({id:request.id,result:{stopReason:'end_turn'}});
 } else if(request.id!==undefined) send({id:request.id,result:{}});
});`;

test("actual ACP SDK and runtime retain identified empty assistant boundaries in order", { timeout: 15_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paperclip-acpx-message-boundary-"));
  const children = [];
  const runtime = createAcpRuntime({ cwd, sessionStore: createFileSessionStore({ stateDir: join(cwd, "sessions") }),
    agentRegistry: createAgentRegistry({ overrides: { pi: ["verified-fixture"] } }), permissionMode: "approve-all",
    spawnAgent: () => { const child = spawn(process.execPath, ["-e", fixture], { cwd, stdio: ["pipe", "pipe", "pipe"] }); children.push(child); return child; },
  });
  let handle;
  try {
    handle = await runtime.ensureSession({ sessionKey: "fixture-boundaries", agent: "pi", mode: "persistent", cwd });
    const chunk = (messageId, text, kind = "delta", thought = false) => ({ sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
      ...(messageId ? { messageId } : {}), content: { type: "text", text },
      _meta: { origin: "pi-native-assistant", source: "pi-rpc-message-v1", kind, unrelated: "DROP_ME" },
    });
    const updates = [chunk("first", "", "start"), chunk("first", "pre-tool narration"), chunk("first", "", "end:toolUse"),
      chunk("last", "", "start"), chunk("last", "thought", "delta", true), chunk("last", "EXACT_MARKER"), chunk("last", "", "end:stop"),
      chunk(undefined, ""), { sessionUpdate: "agent_message_chunk", messageId: "no-text", content: { type: "image", data: "", mimeType: "image/png" } }];
    for (let index = 0; index < 2; index++) {
      const turn = runtime.startTurn({ handle, text: JSON.stringify(updates), mode: "prompt", sessionMode: "persistent", requestId: `request-${index}`, timeoutMs: 5000 });
      const events = [];
      for await (const event of turn.events) if (event.type === "text_delta") events.push(event);
      assert.equal((await turn.result).status, "completed");
      assert.deepEqual(events.map(event => [event.messageId, event.text, event.meta?.kind, event.stream]), [
        ["first", "", "start", "output"], ["first", "pre-tool narration", "delta", "output"], ["first", "", "end:toolUse", "output"],
        ["last", "", "start", "output"], ["last", "thought", "delta", "thought"], ["last", "EXACT_MARKER", "delta", "output"], ["last", "", "end:stop", "output"],
      ]);
      assert.equal(JSON.stringify(events).includes("DROP_ME"), false);
    }
  } finally {
    try { if (handle) await runtime.close({ handle, discardPersistentState: true }); }
    finally { for (const child of children) child.kill("SIGTERM"); await rm(cwd, { recursive: true, force: true }); }
  }
});
