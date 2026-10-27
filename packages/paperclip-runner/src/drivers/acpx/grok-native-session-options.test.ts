import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpRuntimeHandle } from "acpx/runtime";
import { expect, it } from "vitest";
import { createGrokEffortAdmission } from "./grok-effort.js";

it.each(["low", "high"] as const)("transports and restores native Grok %s effort through the real ACPX client", async effort => {
  const root = await mkdtemp(join(tmpdir(), "grok-native-session-options-"));
  const fixture = join(root, "grok"), wirePath = join(root, "wire.jsonl"), statePath = join(root, "native.json");
  await writeFile(fixture, String.raw`
    const fs = require("node:fs"), readline = require("node:readline");
    const statePath = ${JSON.stringify(statePath)}, wirePath = ${JSON.stringify(wirePath)};
    const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\n");
    readline.createInterface({input:process.stdin}).on("line", line => {
      const request = JSON.parse(line), params = request.params ?? {};
      fs.appendFileSync(wirePath, JSON.stringify({method:request.method,sessionId:params.sessionId,meta:params._meta})+"\n");
      if (request.method === "initialize") return reply(request.id, {protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
      if (["session/new","session/load","session/resume"].includes(request.method)) {
        const previous = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath,"utf8")) : {};
        const model = params._meta?.modelId ?? previous.model;
        const effort = params._meta?.reasoningEffort ?? "high";
        fs.writeFileSync(statePath,JSON.stringify({model,effort}));
        return reply(request.id, {...(request.method === "session/new" ? {sessionId:"grok-native-session"} : {}),
          models:{currentModelId:model,availableModels:[{modelId:model,name:model}]},
          _meta:{"x.ai/sessionConfig":{options:[{id:model,category:"model",selected:true},{id:effort,category:"mode",selected:true}]}}});
      }
      if (request.method === "_x.ai/session/info") return reply(request.id, {result:{sessionId:params.sessionId}});
      if (request.method === "session/prompt") {
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId:params.sessionId,
          update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"GROK_RESTORED_TURN_OK"}}}})+"\n");
        return reply(request.id,{stopReason:"end_turn"});
      }

      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code:-32601,message:"Unsupported native method"}})+"\n");
    });
  `);
  const store = createRuntimeStore({ stateDir: join(root, "store") });
  const model = "grok-exact-model";
  let admission = createGrokEffortAdmission(effort, model);
  const options = {
    cwd: root,
    sessionStore: store,
    agentRegistry: createAgentRegistry({ overrides: { grok: [fixture, "agent", "stdio"] } }),
    permissionMode: "approve-reads" as const,
    timeoutMs: 5_000,
    protocolGuardFactory: () => admission.createGuard(),
    spawnAgent: () => spawn(process.execPath, [fixture], { cwd: root, env: {}, stdio: "pipe" }),
  };
  const input = { sessionKey: "grok-native-options", agent: "grok", mode: "persistent" as const,
    sessionOptions: { model } };
  let runtime = createAcpRuntime(options);
  let handle: AcpRuntimeHandle | undefined;
  try {
    handle = await runtime.ensureSession(input);
    admission.assertReady();
    const originalSession = handle.backendSessionId;
    await runtime.close({ handle, reason: "cold native restore", discardPersistentState: false });
    admission = createGrokEffortAdmission(effort, model);
    runtime = createAcpRuntime(options);
    handle = await runtime.ensureSession(input);
    expect(handle.backendSessionId).toBe(originalSession);
    expect(admission.isReady()).toBe(false);
    await runtime.requestExtension({ handle, method: "_x.ai/session/info", params: { sessionId: handle.backendSessionId }, sessionMode: "persistent" });
    admission.assertReady();
    const turn = runtime.startTurn({ handle, text: "Verify the restored fixture", mode: "prompt", requestId: "grok-cold-turn", timeoutMs: 5_000 });
    const output: string[] = [];
    const drain = (async () => {
      for await (const event of turn.events) if (event.type === "text_delta") output.push(event.text);
    })();
    const result = await turn.result;
    await drain;
    expect(result.status).toBe("completed");
    expect(output.join("")).toBe("GROK_RESTORED_TURN_OK");
    admission.assertReady();
    const wire = (await readFile(wirePath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const opens = wire.filter(request => ["session/new", "session/load", "session/resume"].includes(request.method));
    expect(opens.map(request => request.method)).toEqual(["session/new", "session/load", "session/load"]);
    for (const request of opens) expect(request.meta).toMatchObject({ modelId: model, reasoningEffort: effort });
    expect(wire.filter(request => request.method === "session/prompt")).toEqual([
      { method: "session/prompt", sessionId: originalSession },
    ]);
    expect(wire.some(request => request.method === "session/set_config_option")).toBe(false);
  } finally {
    if (handle) await runtime.close({ handle, reason: "native metadata test complete", discardPersistentState: false });
    await rm(root, { recursive: true, force: true });
  }
});
