import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAcpRuntime } from "acpx/runtime";
import { createAntigravityAdmission } from "./antigravity-admission.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** The real installed manager/stdio transport, with only the remote provider replaced. */
async function fixture(behavior: "accept" | "missing" | "mismatch" | "question" | "family" | "family-change" = "accept") {
  const cwd = await mkdtemp(join(tmpdir(), "antigravity-acpx-contract-"));
  const requests: Array<Record<string, any>> = [];
  const nativeResponses: Array<Record<string, any>> = [];
  const sdkResponses: Array<Record<string, any>> = [];
  const children: ChildProcess[] = [];
  const records = new Map();
  const runtimes: Array<{ runtime: ReturnType<typeof createAcpRuntime>; handle: any }> = [];
  const content = "  Exact 🧷 governance\n\n";
  const family = behavior.startsWith("family");
  const model = family ? "gemini-3.8-flash-low" : "caller-model-absent-from-catalog";
  const admission = createAntigravityAdmission(content, model);
  cleanups.push(async () => {
    try {
      for (const owner of runtimes) if (owner.handle) await owner.runtime.close({ handle: owner.handle, reason: "test cleanup" }).catch(() => {});
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
          child.kill("SIGKILL"); await closed;
        }
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
  const options = {
    cwd, timeoutMs: 2000, permissionMode: "approve-all" as const, elicitationModes: ["form"] as ["form"],
    sessionStore: { async load(id: string) { return records.get(id); }, async save(record: any) { records.set(record.acpxRecordId, record); } },
    agentRegistry: { resolve: () => "verified-antigravity-test-peer", list: () => ["antigravity"] },
    protocolGuardFactory: () => {
      const guard = admission.createGuard();
      return (direction: "inbound" | "outbound", message: unknown) => {
        if (direction === "inbound") nativeResponses.push(structuredClone(message) as Record<string, any>);
        guard(direction, message);
        if (direction === "inbound") sdkResponses.push(structuredClone(message) as Record<string, any>);
        if (direction === "outbound") requests.push(structuredClone(message) as Record<string, any>);
      };
    },
    spawnAgent: () => {
      const code = `
        const readline = require('node:readline'); let promptId;
        const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
        const family=${JSON.stringify(family)};
        const nativeOptions=()=>family?[
          {id:'model',name:'Model',type:'select',category:'model',currentValue:'gemini-3.8-flash',options:[{value:'gemini-3.8-flash',name:'Gemini 3.8 Flash'}]},
          {id:'thinking_level',name:'Thinking level',type:'select',category:'thought_level',currentValue:'low',options:[{value:'high',name:'High'},{value:'medium',name:'Medium'},{value:'low',name:'Low'}]},
          {id:'mode',name:'Mode',type:'select',category:'mode',currentValue:'default',options:[{value:'default',name:'Default'},{value:'auto_edit',name:'Auto edit'},{value:'yolo',name:'YOLO'}]}
        ]:null;
        readline.createInterface({input:process.stdin}).on('line',line=>{
          const m=JSON.parse(line);
          if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'},
            agentCapabilities:{loadSession:true,_meta:{antigravity:{paperclipAdmission:1}}},authMethods:[]}});
          else if(['session/new','session/load','session/resume','session/set_config_option','session/set_model'].includes(m.method)) {
            const a=m.params._meta.antigravity.paperclipAdmission;
            const model=${JSON.stringify(behavior)}==='mismatch'?'fallback':a.model;
            send({id:m.id,result:{...(!family||m.method==='session/new'?{sessionId:'native-session'}:{}),...(!family||['session/new','session/load','session/resume'].includes(m.method)?{modes:{currentModeId:'default'}}:{}),
              ...(!family||['session/new','session/load','session/resume'].includes(m.method)?{models:{currentModelId:model,availableModels:family?[{modelId:'gemini-3.8-flash-high',name:'Gemini 3.8 Flash (High)'},{modelId:'gemini-3.8-flash-medium',name:'Gemini 3.8 Flash (Medium)'},{modelId:'gemini-3.8-flash-low',name:'Gemini 3.8 Flash (Low)'}]:[{modelId:'advertised-only',name:'Advertised'}]}}:{}),
              configOptions:nativeOptions()??[{id:'model',name:'Model',type:'select',category:'model',currentValue:model,options:[{value:'advertised-only',name:'Advertised'}]}],
              ...(${JSON.stringify(behavior)}==='missing'?{}:{_meta:{paperclipAntigravityAdmission:{...a,model,sessionId:'native-session',connectionId:'owned-native-connection'}}})}});
            if(family&&m.method==='session/set_config_option')send({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'config_option_update',configOptions:nativeOptions()}}});
          } else if(m.method==='session/prompt') {
            promptId=m.id;
            if(${JSON.stringify(behavior)}==='family-change') {
              const changed=nativeOptions();changed.find(o=>o.id==='thinking_level').currentValue='high';
              send({method:'session/update',params:{sessionId:'native-session',update:{sessionUpdate:'config_option_update',configOptions:changed}}});
            }
            if(${JSON.stringify(behavior)}==='question') send({id:0,method:'session/request_permission',params:{sessionId:'native-session',
              toolCall:{toolCallId:'interaction_choices',title:'Pick one',status:'pending',rawInput:{}},
              options:[{optionId:'yes',name:'Yes',kind:'allow_once'},{optionId:'deny',name:'No',kind:'reject_once'}]}});
            else send({id:m.id,result:{stopReason:'end_turn'}});
          } else if(m.id===0 && m.result?.outcome) {
            if(m.result.outcome.outcome!=='selected'||m.result.outcome.optionId!=='deny') process.exit(7);
            send({id:promptId,result:{stopReason:'end_turn'}});
          } else if(m.id!==undefined) send({id:m.id,result:{}});
        });`;
      const child = spawn(process.execPath, ["-e", code], { cwd, env: {}, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child); return child;
    },
  };
  return {
    requests, nativeResponses, sdkResponses, content, model,
    async open() {
      const owner = { runtime: createAcpRuntime(options), handle: null as any };
      runtimes.push(owner);
      owner.handle = await owner.runtime.ensureSession({ sessionKey: "antigravity-contract", agent: "antigravity", mode: "persistent", cwd,
        sessionOptions: { model, systemPrompt: { append: content } } });
      return owner;
    },
    async turn(owner: { runtime: ReturnType<typeof createAcpRuntime>; handle: any }, onQuestion?: (request: any) => void) {
      const turn = owner.runtime.startTurn({ handle: owner.handle, text: "Do the task", mode: "prompt", requestId: "turn-contract",
        onElicitation: async request => { onQuestion?.(request); return { action: "accept", content: { answer: "deny" } }; } });
      const drained = (async () => { for await (const _event of turn.events) {} })();
      const result = await turn.result; await drained; return result;
    },
  };
}

it("passes exact unlisted model and instruction bytes through installed ACPX on create and load", async () => {
  const f = await fixture(); const first = await f.open();
  expect((await f.turn(first)).status).toBe("completed");
  await first.runtime.close({ handle: first.handle, reason: "reload" });
  const second = await f.open(); expect((await f.turn(second)).status).toBe("completed");
  const opens = f.requests.filter(message => ["session/new", "session/load"].includes(message.method));
  expect(opens.some(message => message.method === "session/load")).toBe(true);
  for (const message of opens) {
    expect(message.params._meta.antigravity.systemPrompt.append).toBe(f.content);
    expect(message.params._meta.antigravity.paperclipAdmission.model).toBe(f.model);
  }
  expect(new Set(opens.map(message => message.params._meta.antigravity.paperclipAdmission.nonce)).size).toBe(opens.length);
});

it.each(["missing", "mismatch"] as const)("blocks prompts when the actual installed manager receives %s native admission", async behavior => {
  const f = await fixture(behavior);
  await expect(f.open()).rejects.toThrow(/admission/i);
  expect(f.requests.some(message => message.method === "session/prompt")).toBe(false);
});

it("delivers a native deny answer through the form path even with approve-all permissions", async () => {
  const f = await fixture("question"); const owner = await f.open(); const seen: unknown[] = [];
  expect((await f.turn(owner, request => seen.push(request))).status).toBe("completed");
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ mode: "form", requestedSchema: { required: ["answer"] } });
  expect(f.requests.find(message => message.id === 0 && message.result)).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "deny" } } });
});

it("admits the concrete model through installed ACPX when native new/load/setter metadata groups it by family and thinking level", async () => {
  const f = await fixture("family");
  const first = await f.open();
  expect((await f.turn(first)).status).toBe("completed");
  await first.runtime.setConfigOption({ handle: first.handle, key: "model", value: f.model });
  expect((await f.turn(first)).status).toBe("completed");
  await first.runtime.close({ handle: first.handle, reason: "native family reload" });
  const loaded = await f.open();
  expect((await f.turn(loaded)).status).toBe("completed");
  expect(f.requests.some(message => message.method === "session/load")).toBe(true);
  expect(f.requests.some(message => message.method === "session/set_config_option")).toBe(true);
  const native = f.nativeResponses.filter(message => message.result?.configOptions);
  expect(native.length).toBeGreaterThanOrEqual(3);
  const setter = native.find(message => !message.result.models);
  expect(setter).toBeDefined();
  expect(setter!.result.modes).toBeUndefined();
  expect(setter!.result._meta.paperclipAntigravityAdmission.model).toBe(f.model);
  for (const message of native) {
    expect(message.result.configOptions.find((option: any) => option.id === "model").currentValue).toBe("gemini-3.8-flash");
    expect(message.result.configOptions.find((option: any) => option.id === "thinking_level").currentValue).toBe("low");
  }
  for (const message of f.sdkResponses.filter(message => message.result?.configOptions)) {
    expect(message.result.configOptions.find((option: any) => option.id === "model").currentValue).toBe(f.model);
  }
  const updates = f.sdkResponses.filter(message => message.params?.update?.sessionUpdate === "config_option_update");
  expect(updates.length).toBeGreaterThan(0);
  for (const message of updates) expect(message.params.update.configOptions.find((option: any) => option.id === "model").currentValue).toBe(f.model);
});

it("rejects an unacknowledged thinking-level change after a native family model was admitted", async () => {
  const f = await fixture("family-change"), owner = await f.open();
  const result = await f.turn(owner);
  expect(result.status).toBe("failed");
  expect(result.error?.message).toMatch(/admission/i);
});
