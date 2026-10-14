import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const root = process.env.PAPERCLIP_TEST_ACPX_PACKAGE_ROOT ?? dirname(require.resolve("acpx/package.json"));
const { createAcpRuntime } = await import(pathToFileURL(join(root, "dist/runtime.js")));
const { dt: serialize, ut: parse } = await import(pathToFileURL(join(root, "dist/live-checkpoint-BSIrfgVo.js")));
const selectedModel = "custom/model";

// Exercise the installed ACPX manager and ACP wire, including saved model replay.
// Only the provider process is a fixture; it never connects to a model service.
async function fixture(t, agent, behavior = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "acpx-model-selection-"));
  const records = new Map(), children = [], requests = [], runtimes = [];
  let response = behavior.response ?? "accept";
  const options = {
    cwd, timeoutMs: 3_000, permissionMode: "approve-all",
    sessionStore: {
      async load(id) { const disk = records.get(id); return disk ? parse(structuredClone(disk)) : undefined; },
      async save(record) { records.set(record.acpxRecordId, structuredClone(serialize(record))); },
    },
    agentRegistry: { resolve: () => behavior.agentCommand ?? "paperclip-verified-acpx-command", list: () => [agent] },
    protocolGuardFactory: () => (direction, message) => {
      if (direction === "outbound" && message.method) requests.push(structuredClone(message));
    },
    spawnAgent: () => {
      const wire = `
        const readline = require('node:readline');
        const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
        const config = currentValue => [{id:'model',name:'Model',category:'model',type:'select',currentValue,
          options:[{value:'advertised-model',name:'Advertised'},{value:'custom/model[variant=x]',name:'Variant'}]}];
        readline.createInterface({input:process.stdin}).on('line',line=>{
          const m=JSON.parse(line);
          if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
          else if(m.method==='session/new'||m.method==='session/load') send({id:m.id,result:{sessionId:'session-1',
            ...(${JSON.stringify(response === "missing")} ? {} : {configOptions:config(${JSON.stringify(behavior.currentModel ?? "default")}),
            models:{currentModelId:${JSON.stringify(behavior.currentModel ?? "default")},availableModels:[{modelId:'advertised-model',name:'Advertised'},{modelId:'custom/model[variant=x]',name:'Variant'}]}})}});
          else if(m.method==='session/set_config_option') {
            if(${JSON.stringify(response)}==='reject') send({id:m.id,error:{code:-32602,message:'fixture provider rejected model'}});
            else send({id:m.id,result:{configOptions:config(${JSON.stringify(response)}==='mismatch'?'wrong-model':m.params.value)}});
          }
          else if(m.method==='session/prompt') send({id:m.id,result:{stopReason:'end_turn'}});
          else if(m.id!==undefined) send({id:m.id,result:{}});
        });
      `;
      const child = spawn(process.execPath, ["-e", wire], { cwd, env: {}, stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      return child;
    },
  };
  t.after(async () => {
    try {
      for (const { runtime, handle } of runtimes) if (handle) await runtime.close({ handle, reason: "fixture cleanup" });
    } finally {
      await Promise.all(children.map(child => new Promise(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("close", resolve);
        child.kill("SIGKILL");
      })));
      await rm(cwd, { recursive: true, force: true });
    }
  });
  return {
    requests,
    setResponse(value) { response = value; },
    async open() {
      const runtime = createAcpRuntime(options), owner = { runtime, handle: null };
      runtimes.push(owner);
      owner.handle = await runtime.ensureSession({ sessionKey: "model-selection", agent, mode: "persistent", cwd, sessionOptions: { model: selectedModel } });
      return owner;
    },
    async prompt(owner) {
      const turn = owner.runtime.startTurn({ handle: owner.handle, text: "fixture", mode: "prompt", requestId: `request-${runtimes.length}` });
      const drained = (async () => { for await (const _event of turn.events) {} })();
      const result = await turn.result;
      await drained;
      return result;
    },
    async close(owner) { await owner.runtime.close({ handle: owner.handle, reason: "fixture restart" }); },
    selected() { return requests.filter(r => r.method === "session/set_config_option").map(r => r.params.value); },
  };
}

for (const agent of ["claude", "codex", "grok", "cursor", "copilot", "pi"]) {
  test(`${agent}: unlisted model reaches the provider unchanged on startup and reconnect`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, agent);
    const first = await f.open();
    assert.deepEqual(f.selected(), [selectedModel]);
    assert.equal((await f.prompt(first)).status, "completed");
    await f.close(first);
    const beforeReconnect = f.selected().length;
    const second = await f.open();
    assert.equal((await f.prompt(second)).status, "completed");
    assert.ok(f.requests.some(r => r.method === "session/load"));
    assert.ok(f.selected().length > beforeReconnect, "fresh connection replays the selected model");
    assert.ok(f.selected().every(model => model === selectedModel), "never substitute an advertised variant");
  });
}

for (const response of ["reject", "mismatch", "missing"]) {
  const error = response === "reject" ? /fixture provider rejected model/ : response === "missing" ? /did not advertise model support/ : /effective model mismatch/;
  test(`provider ${response} on startup prevents prompting without fallback`, async t => {
    const f = await fixture(t, "cursor", { response });
    await assert.rejects(f.open(), error);
    assert.deepEqual(f.selected(), response === "missing" ? [] : [selectedModel]);
    assert.equal(f.requests.some(r => r.method === "session/prompt"), false);
  });
  test(`provider ${response} on reconnect prevents prompting without fallback`, async t => {
    const f = await fixture(t, "cursor");
    const first = await f.open();
    assert.equal((await f.prompt(first)).status, "completed");
    await f.close(first);
    const promptCount = f.requests.filter(r => r.method === "session/prompt").length;
    f.setResponse(response);
    try {
      const second = await f.open();
      const result = await f.prompt(second);
      assert.equal(result.status, "failed");
      assert.match(JSON.stringify(result), error);
    } catch (failure) { assert.match(failure.message, error); }
    assert.ok(f.selected().every(model => model === selectedModel));
    assert.equal(f.requests.filter(r => r.method === "session/prompt").length, promptCount);
  });
}


test("an already selected unlisted model needs no replacement", async t => {
  const f = await fixture(t, "cursor", { currentModel: selectedModel });
  const owner = await f.open();
  assert.equal((await f.prompt(owner)).status, "completed");
  assert.deepEqual(f.selected(), []);
});

test("Cursor command detection never expands a model into an advertised variant", async t => {
  const f = await fixture(t, "cursor", { agentCommand: "cursor-agent acp" });
  const owner = await f.open();
  assert.equal((await f.prompt(owner)).status, "completed");
  assert.deepEqual(f.selected(), [selectedModel]);
});
