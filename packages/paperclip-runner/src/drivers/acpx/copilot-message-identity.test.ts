import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { COPILOT_MESSAGE_MAPPING_REPLACEMENT, COPILOT_REPLAY_MAPPING_REPLACEMENT } from "../../../scripts/copilot-inner-distribution.mjs";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpRuntimeEvent } from "acpx/runtime";

// The process is a deterministic ACP transport peer, never a provider/model.
// Exercise the installed ACPX normalization path rather than duplicating it.
const peer = String.raw`
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
const live=e=>{switch(e.type){${COPILOT_MESSAGE_MAPPING_REPLACEMENT}default:return null}};
const replay=t=>{switch(t.type){${COPILOT_REPLAY_MAPPING_REPLACEMENT}default:return live(t)}};
const update=u=>{if(u)send({method:'session/update',params:{sessionId:'copilot-message-session',update:u}})};
let turn=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 else if(m.method==='session/new')send({id:m.id,result:{sessionId:'copilot-message-session'}});
 else if(m.method==='session/load'){
  // Native loadSession awaits replaySessionHistory before its response. These
  // are persisted full-message events, not a second copy of active deltas.
  for(const e of [
   {type:'assistant.message',data:{messageId:'history:first',content:'SAME'}},
   {type:'assistant.message',data:{messageId:'history:second',content:'SAME'}},
   {type:'assistant.message',data:{messageId:'history:empty',content:''}},
  ])update(replay(e));
  send({id:m.id,result:{}});
 }
 else if(m.method==='session/prompt'){
  turn++;
  for(const [id,text] of [[turn+':first',''],[turn+':first','SAME'],[turn+':second',''],[turn+':second','SA'],[turn+':second','ME'],[turn+':empty-final','']]){
   update(live({type:text===''?'assistant.message_start':'assistant.message_delta',data:{messageId:id,deltaContent:text}}));
   if(text==='ME')update(live({type:'assistant.message',data:{messageId:id,content:'SAME'}}));
  }
  send({id:m.id,result:{stopReason:'end_turn'}});
 }
});`;

it.each([false, true])("actual ACPX keeps load replay outside live warm turns (resume=%s)", async resume => {
  const directory = await mkdtemp(join(tmpdir(), "copilot-message-acpx-"));
  const children: ReturnType<typeof spawn>[] = [];
  const wire: string[] = [];
  const runtime = createAcpRuntime({ cwd: directory, permissionMode: "deny-all",
    agentRegistry: createAgentRegistry({ overrides: { copilot: "fixture" } }), sessionStore: createRuntimeStore({ stateDir: join(directory, "state") }),
    spawnAgent: () => { const child = spawn(process.execPath, ["-e", peer], { cwd: directory, env: {}, stdio: ["pipe", "pipe", "pipe"] }); child.stdout!.on("data", chunk => wire.push(chunk.toString())); children.push(child); return child; },
  });
  let handle;
  try {
    handle = await runtime.ensureSession({ sessionKey: "copilot-message-identity", agent: "copilot", mode: "persistent", cwd: directory, ...(resume ? { resumeSessionId: "copilot-message-session" } : {}) });
    for (let n = 1; n <= 3; n++) {
      const turn = runtime.startTurn({ handle, text: "fixture", mode: "prompt", requestId: `fixture-${n}`, timeoutMs: 2000 });
      const events: AcpRuntimeEvent[] = [];
      const drain = (async () => { for await (const event of turn.events) events.push(event); })();
      expect(await turn.result).toMatchObject({ status: "completed" }); await drain;
      expect(events.filter(e => e.type === "text_delta").map(e => [e.messageId, e.text])).toEqual([
        [`${n}:first`, ""], [`${n}:first`, "SAME"], [`${n}:second`, ""], [`${n}:second`, "SA"], [`${n}:second`, "ME"], [`${n}:empty-final`, ""],
      ]);
    }
    expect(children).toHaveLength(1);
    const updates = wire.join("").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(frame => frame.method === "session/update").map(frame => frame.params.update);
    expect(updates.slice(0, resume ? 3 : 0).map(update => [update.messageId, update.content.text])).toEqual(resume ? [
      ["history:first", "SAME"], ["history:second", "SAME"], ["history:empty", ""],
    ] : []);
    expect(updates).toHaveLength(18 + (resume ? 3 : 0));
  } finally {
    if (handle) await runtime.close({ handle, reason: "message identity fixture complete" });
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});
