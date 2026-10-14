import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { admitCursorInstructions, createCursorInstructionAdmission, cursorInstructionBinding } from "./cursor-instructions.js";
import { prepareAcpxRuntimeSandbox } from "./runtime-sandbox.js";
import { createAcpxRecoveryBinding } from "./recovery-identity.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";

const root = dirname(createRequire(import.meta.url).resolve("acpx/package.json"));
const { k: AcpClient } = await import(pathToFileURL(join(root, "dist/live-checkpoint-BSIrfgVo.js")).href);
const content = "Paperclip governance\nCustom entry: résumé\nAGENT_HOME=/registered/agent";
const binding = cursorInstructionBinding(content);
const ack = { schema: "paperclip.cursor.instructions.v1", digest: binding.digest, byteLength: binding.byteLength };

it("binds exact UTF-8 content, including explicit empty instructions", () => {
  expect(JSON.parse(binding.payload).content).toBe(content);
  expect(binding.byteLength).toBe(Buffer.byteLength(content));
  expect(cursorInstructionBinding("").digest).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(() => cursorInstructionBinding("x\0y")).toThrow(/NUL/);
  expect(() => cursorInstructionBinding("é".repeat(16385))).toThrow(/bounded/);
});

it("refreshes trusted sandbox instructions on recovery and excludes ambient overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-instruction-sandbox-"));
  try {
    const workspace = join(dir, "workspace"); const runtimeDirectory = join(dir, "runtime");
    await Promise.all([mkdir(workspace), mkdir(runtimeDirectory)]);
    const recovery = await createAcpxRecoveryBinding({ runtimeDirectory, normalizedSessionId: "cursor-instructions", workingDirectory: workspace, profile: resolveQualifiedAcpxProfile("cursor", "fixture"), requestedModel: "fixture", permissionMode: "approve-reads" });
    for (const text of [content, "updated entry", ""]) {
      const sandbox = await prepareAcpxRuntimeSandbox({ binding: recovery, agent: "cursor", environment: { PAPERCLIP_CURSOR_INSTRUCTIONS: "ambient injection" }, providerPolicy: { readOnly: true, systemInstructions: text } });
      expect(sandbox.launchEnvironment.PAPERCLIP_CURSOR_INSTRUCTIONS).toBe(cursorInstructionBinding(text).payload);
      expect(sandbox.persistedEnvironment.PAPERCLIP_CURSOR_INSTRUCTIONS).toBeUndefined();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("scopes acknowledgements to their request, session and current connection", () => {
  const admission = createCursorInstructionAdmission(content);
  const first = admission.createGuard();
  first("inbound", { id: 0, result: { sessionId: "forged", _meta: { paperclipCursorInstructions: ack } } });
  expect(admission.assertReady).toThrow(/did not acknowledge/);
  first("outbound", { id: 0, method: "session/new", params: {} });
  first("inbound", { id: 0, result: { sessionId: "s", _meta: { paperclipCursorInstructions: ack } } });
  admission.assertReady();
  first("outbound", { id: 1, method: "session/prompt", params: { sessionId: "s" } });
  const second = admission.createGuard();
  expect(() => first("outbound", { method: "session/prompt", params: { sessionId: "s" } })).toThrow(/replaced/);
  expect(() => second("outbound", { method: "session/prompt", params: { sessionId: "s" } })).toThrow(/did not acknowledge/);
});

const fixture = String.raw`
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const ack=JSON.parse(process.env.FIXTURE_ACK);const mode=process.env.FIXTURE_MODE;
const configOptions=[{id:'model',name:'Model',type:'select',currentValue:'fixture',options:[{value:'fixture',name:'Fixture'}]}];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 else if(m.method==='session/new'||m.method==='session/load')send({id:m.id,result:{configOptions,...(m.method==='session/new'?{sessionId:'cursor-session'}:{}),...(mode==='missing'?{}:{_meta:{paperclipCursorInstructions:mode==='wrong'?{...ack,digest:'sha256:'+'0'.repeat(64)}:ack}})}});
 else if(m.method==='session/set_config_option')send(mode==='unsupported'?{id:m.id,error:{code:-32602,message:'Unsupported exact model'}}:{id:m.id,result:{configOptions}});
 else if(m.method==='session/prompt'){process.stderr.write('PROMPT\n');send({id:m.id,result:{stopReason:'end_turn'}});}
});`;

it.each(["valid", "missing", "wrong"])("actual SDK reconnect/load %s acknowledgement gates prompt bytes", async mode => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-instruction-sdk-"));
  const admission = createCursorInstructionAdmission(content);
  let prompts = 0;
  const open = async (responseMode: string) => {
    const client = new AcpClient({ agentCommand: "fixture", cwd: dir, permissionMode: "deny-all", authPolicy: "skip", fs: false, terminal: false,
      protocolGuardFactory: () => admission.createGuard(),
      spawnAgent: () => { const child = spawn(process.execPath, ["-e", fixture], { cwd: dir, env: { FIXTURE_ACK: JSON.stringify(ack), FIXTURE_MODE: responseMode }, stdio: ["pipe", "pipe", "pipe"] }); child.stderr.on("data", data => { prompts += String(data).split("PROMPT").length - 1; }); return child; },
    });
    await client.start(); return client;
  };
  let first; let loaded;
  try {
    first = await open("valid"); await first.createSession(dir); admission.assertReady(); await first.close();
    loaded = await open(mode);
    if (mode === "valid") {
      await loaded.loadSessionWithOptions("cursor-session", dir, { suppressReplayUpdates: true, replayIdleMs: 1 });
      admission.assertReady(); await loaded.prompt("cursor-session", "fixture");
    } else {
      await expect(loaded.loadSessionWithOptions("cursor-session", dir)).rejects.toThrow(/Cursor instruction admission failed/);
      expect(admission.assertReady).toThrow(/acknowledgement/);
      await expect(loaded.prompt("cursor-session", "fixture")).rejects.toThrow();
    }
  } finally { await loaded?.close().catch(() => {}); await first?.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
  expect(prompts).toBe(mode === "valid" ? 1 : 0);
});

it.each(["valid", "missing", "wrong"])("actual runtime automatically reloads with %s instructions after provider death", async mode => {
  const { createAcpRuntime, createAgentRegistry, createRuntimeStore } = await import("acpx/runtime");
  const dir = await mkdtemp(join(tmpdir(), "cursor-instruction-reload-"));
  const admission = createCursorInstructionAdmission(content);
  const children: ReturnType<typeof spawn>[] = [];
  const writes: string[] = [];
  const runtime = createAcpRuntime({ cwd: dir, agentRegistry: createAgentRegistry({ overrides: { cursor: "fixture" } }), sessionStore: createRuntimeStore({ stateDir: join(dir, "state") }), permissionMode: "deny-all",
    protocolGuardFactory: () => admission.createGuard(),
    onAcpMessage: (direction, value) => { if (direction === "outbound") writes.push((value as { method: string }).method); },
    spawnAgent: () => { const child = spawn(process.execPath, ["-e", fixture], { cwd: dir, env: { FIXTURE_ACK: JSON.stringify(ack), FIXTURE_MODE: children.length === 0 ? "valid" : mode }, stdio: ["pipe", "pipe", "pipe"] }); children.push(child); return child; },
  });
  let handle;
  try {
    handle = await runtime.ensureSession({ sessionKey: "cursor-instruction-auto-reload", agent: "cursor", mode: "persistent", cwd: dir });
    admission.assertReady();
    const exited = new Promise(resolve => children[0].once("exit", resolve));
    children[0].kill("SIGTERM"); await exited;
    const turn = runtime.startTurn({ handle, text: "fixture", mode: "prompt", requestId: "reload-fixture", timeoutMs: 2000 });
    const drain = (async () => { for await (const _event of turn.events) { /* drain bounded fixture events */ } })();
    const result = await turn.result; await drain;
    expect(writes).toContain("session/load");
    expect(children.length).toBe(2);
    if (mode === "valid") { expect(result.status).toBe("completed"); expect(writes.filter(method => method === "session/prompt")).toHaveLength(1); }
    else { expect(result).toMatchObject({ status: "failed", error: { message: expect.stringContaining("Cursor instruction admission failed") } }); expect(writes).not.toContain("session/prompt"); }
  } finally {
    if (handle) await runtime.close({ handle, reason: "fixture cleanup" }).catch(() => {});
    for (const child of children) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});


it.each(["valid", "missing", "wrong", "unsupported"])("fresh runtime manager admits cold saved Cursor session only after %s load/config acknowledgement", async mode => {
  const { createAcpRuntime, createAgentRegistry, createRuntimeStore } = await import("acpx/runtime");
  const dir = await mkdtemp(join(tmpdir(), "cursor-cold-admission-"));
  const children: ReturnType<typeof spawn>[] = [];
  const writes: Array<{ phase: string; method: string }> = [];
  const create = (instructions: string, phase: string, responseMode: string) => {
    const admission = createCursorInstructionAdmission(instructions);
    const binding = cursorInstructionBinding(instructions);
    const currentAck = { schema: "paperclip.cursor.instructions.v1", digest: binding.digest, byteLength: binding.byteLength };
    const runtime = createAcpRuntime({ cwd: dir, agentRegistry: createAgentRegistry({ overrides: { cursor: "fixture" } }),
      sessionStore: createRuntimeStore({ stateDir: join(dir, "state") }), permissionMode: "deny-all",
      protocolGuardFactory: () => admission.createGuard(),
      onAcpMessage: (direction, value) => { if (direction === "outbound") writes.push({ phase, method: (value as { method: string }).method }); },
      spawnAgent: () => {
        const child = spawn(process.execPath, ["-e", fixture], { cwd: dir, env: { FIXTURE_ACK: JSON.stringify(currentAck), FIXTURE_MODE: responseMode }, stdio: ["pipe", "pipe", "pipe"] });
        children.push(child); return child;
      },
    });
    return { runtime, admission };
  };
  let first: ReturnType<typeof create> | undefined; let second: ReturnType<typeof create> | undefined;
  let firstHandle; let secondHandle; let renewed = 0;
  const session = { sessionKey: "cursor-cold-record", agent: "cursor", mode: "persistent" as const, cwd: dir };
  try {
    first = create(content, "first", "valid"); firstHandle = await first.runtime.ensureSession(session); first.admission.assertReady();
    await first.runtime.close({ handle: firstHandle, reason: "First host retired" }); firstHandle = undefined;
    second = create(`${content}\nUpdated registered agent path`, "second", mode);
    const before = children.length;
    secondHandle = await second.runtime.ensureSession(session);
    expect(children.length).toBe(before); // The exact original cold-reopen gap.
    expect(second.admission.assertReady).toThrow(/did not acknowledge/);
    const admit = admitCursorInstructions(second.admission, { providerSpawned: false,
      load: () => second!.runtime.setConfigOption({ handle: secondHandle!, key: "model", value: "fixture" }),
      refreshCommand: async () => { renewed++; },
    });
    if (mode === "valid") {
      await admit; expect(renewed).toBe(1); second.admission.assertReady();
      expect(writes.filter(row => row.phase === "second").map(row => row.method)).toEqual(["initialize", "session/load", "session/set_config_option"]);
      const turn = second.runtime.startTurn({ handle: secondHandle, text: "fixture", mode: "prompt", requestId: "cold-fixture", timeoutMs: 2000 });
      const drain = (async () => { for await (const _event of turn.events) { /* drain */ } })();
      expect((await turn.result).status).toBe("completed"); await drain;
      const methods = writes.filter(row => row.phase === "second").map(row => row.method);
      expect(methods).toEqual(["initialize", "session/load", "session/set_config_option", "initialize", "session/load", "session/prompt"]);
    } else {
      await expect(admit).rejects.toThrow(mode === "unsupported" ? /Unsupported exact model/ : /Cursor instruction admission failed/);
      expect(renewed).toBe(0); expect(writes.some(row => row.phase === "second" && row.method === "session/prompt")).toBe(false);
      if (mode !== "unsupported") expect(writes.some(row => row.phase === "second" && row.method === "session/set_config_option")).toBe(false);
    }
  } finally {
    if (first && firstHandle) await first.runtime.close({ handle: firstHandle, reason: "fixture cleanup" }).catch(() => {});
    if (second && secondHandle) await second.runtime.close({ handle: secondHandle, reason: "fixture cleanup" }).catch(() => {});
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
