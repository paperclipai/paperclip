import { describe, expect, it } from "vitest";
import { createCursorModeAdmission, resolveCursorSessionMode } from "./cursor-mode.js";

const config = (mode: string) => [{ id: "mode", type: "select", currentValue: mode, options: ["agent", "plan", "ask"].map(value => ({ value, name: value })) }];
const session = (mode: string) => ({ sessionId: "native", modes: { currentModeId: mode }, configOptions: config(mode) });
const prompt = { id: 9, method: "session/prompt", params: { sessionId: "native" } };
function opened(expected: "agent" | "plan" | "ask", initial = expected) {
  const admission = createCursorModeAdmission(expected); const guard = admission.createGuard();
  guard("outbound", { id: 0, method: "session/new", params: {} });
  guard("inbound", { id: 0, result: session(initial) });
  return { admission, guard };
}

describe("Cursor native mode admission", () => {
  it("defaults only Cursor and rejects unadmitted aliases and other providers", () => {
    expect(resolveCursorSessionMode("cursor", undefined)).toBe("agent");
    expect(resolveCursorSessionMode("codex", undefined)).toBeUndefined();
    for (const mode of ["code", "architect", "search", "chat", "", null]) expect(() => resolveCursorSessionMode("cursor", mode)).toThrow();
    expect(() => resolveCursorSessionMode("pi", "agent")).toThrow(/only supported/);
  });
  it.each(["agent", "plan", "ask"] as const)("admits %s only after correlated native acknowledgements", expected => {
    const { admission, guard } = opened(expected);
    admission.assertReady(); guard("outbound", prompt);
    const reloaded = admission.createGuard();
    expect(admission.assertReady).toThrow();
    expect(() => guard("outbound", prompt)).toThrow(/replaced/);
    reloaded("outbound", { id: 1, method: "session/load", params: { sessionId: "native" } });
    reloaded("inbound", { id: 1, result: session(expected) });
    admission.assertReady(); reloaded("outbound", prompt);
  });
  it("permits explicit initial configuration and does not use an update as its acknowledgement", () => {
    const { admission, guard } = opened("plan", "agent");
    expect(admission.isReady()).toBe(false);
    guard("outbound", { id: 2, method: "session/set_config_option", params: { sessionId: "native", configId: "mode", value: "plan" } });
    guard("inbound", { method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } } });
    expect(admission.isReady()).toBe(false);
    guard("inbound", { id: 2, result: { configOptions: config("plan") } });
    admission.assertReady(); guard("outbound", prompt);
  });
  it.each(["missing", "conflicting", "wrong"])("gates a reloaded prompt with %s mode acknowledgement", kind => {
    const { admission } = opened("plan"); const guard = admission.createGuard();
    guard("outbound", { id: 2, method: "session/load", params: { sessionId: "native" } });
    const result = kind === "missing" ? {} : kind === "conflicting" ? { ...session("plan"), modes: { currentModeId: "ask" } } : session("agent");
    if (kind === "wrong") guard("inbound", { id: 2, result });
    else expect(() => guard("inbound", { id: 2, result })).toThrow(/mode admission/);
    expect(() => guard("outbound", prompt)).toThrow(/mode admission/);
  });
  it("rejects late mode drift and keeps the connection failed closed", () => {
    const { admission, guard } = opened("plan");
    expect(() => guard("inbound", { method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "current_mode_update", currentModeId: "agent" } } })).toThrow(/drifted/);
    expect(admission.assertReady).toThrow(/drifted/);
    expect(() => guard("outbound", prompt)).toThrow(/drifted/);
  });
  it("rejects wrong config echoes, uncorrelated acknowledgements and cross-session control", () => {
    const forged = createCursorModeAdmission("plan"); const g = forged.createGuard();
    g("inbound", { id: 2, result: session("plan") }); expect(forged.assertReady).toThrow();
    const { guard } = opened("plan", "agent");
    guard("outbound", { id: 2, method: "session/set_config_option", params: { sessionId: "native", configId: "mode", value: "plan" } });
    expect(() => guard("inbound", { id: 2, result: { configOptions: config("agent") } })).toThrow(/did not apply/);
    const other = opened("plan").guard;
    expect(() => other("outbound", { id: 3, method: "session/set_config_option", params: { sessionId: "other", configId: "mode", value: "plan" } })).toThrow(/different session/);
  });
  it.each([false, true])("rejects config-option mode drift with active prompt=%s", active => {
    const { admission, guard } = opened("plan");
    if (active) guard("outbound", prompt);
    expect(() => guard("inbound", { method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "config_option_update", configOptions: config("agent") } } })).toThrow(/drifted/);
    expect(admission.assertReady).toThrow(/drifted/);
  });
  it.each(["foreign", "duplicate", "invalid"])("rejects %s mode configuration notifications", kind => {
    const { guard } = opened("plan");
    const options = kind === "duplicate" ? [...config("plan"), ...config("plan")] : config(kind === "invalid" ? "architect" : "plan");
    expect(() => guard("inbound", { method: "session/update", params: { sessionId: kind === "foreign" ? "other" : "native", update: { sessionUpdate: "config_option_update", configOptions: options } } })).toThrow(/mode admission/);
  });
  it("ignores model-only partial updates and cannot admit from a mode notification", () => {
    const { admission, guard } = opened("plan", "agent");
    for (const options of [[{ id: "model", currentValue: "fixture" }], config("plan")]) {
      guard("inbound", { method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "config_option_update", configOptions: options } } });
      expect(admission.isReady()).toBe(false);
    }
  });
  it("does not mistake a bare set_mode response for configuration proof", () => {
    const { admission, guard } = opened("plan", "agent");
    guard("outbound", { id: 4, method: "session/set_mode", params: { sessionId: "native", modeId: "plan" } });
    guard("inbound", { id: 4, result: {} }); expect(admission.assertReady).toThrow();
  });
});

// Real ACPX runtime/SDK transport with a credential-free deterministic peer.
// This proves reconnection ordering and zero prompt bytes on rejection, not
// Cursor model tool selection or a paid provider interaction.
it.each(["plan", "agent", "missing"])("actual runtime auto-load observes %s mode before prompt delivery", async loadedMode => {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAcpRuntime, createAgentRegistry, createRuntimeStore } = await import("acpx/runtime");
  const dir = await mkdtemp(join(tmpdir(), "cursor-mode-runtime-"));
  const children: ReturnType<typeof spawn>[] = [];
  const methods: string[] = [];
  const admission = createCursorModeAdmission("plan");
  const peer = String.raw`
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
let mode=process.env.MODE;
const config=()=>[{id:'mode',name:'Mode',type:'select',currentValue:mode,options:['agent','plan','ask'].map(value=>({value,name:value}))}];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 else if(m.method==='session/new'||m.method==='session/load')send({id:m.id,result:{sessionId:'native',...(mode==='missing'?{}:{modes:{currentModeId:mode,availableModes:['agent','plan','ask'].map(id=>({id,name:id}))},configOptions:config()})}});
 else if(m.method==='session/prompt')send({id:m.id,result:{stopReason:'end_turn'}});
});`;
  const runtime = createAcpRuntime({ cwd: dir, agentRegistry: createAgentRegistry({ overrides: { cursor: "fixture" } }), sessionStore: createRuntimeStore({ stateDir: join(dir, "state") }), permissionMode: "deny-all",
    protocolGuardFactory: () => admission.createGuard(),
    onAcpMessage: (direction, value) => { if (direction === "outbound") methods.push((value as { method: string }).method); },
    spawnAgent: () => { const child = spawn(process.execPath, ["-e", peer], { cwd: dir, env: { MODE: children.length ? loadedMode : "plan" }, stdio: ["pipe", "pipe", "pipe"] }); children.push(child); return child; },
  });
  let handle;
  try {
    handle = await runtime.ensureSession({ sessionKey: "mode-recovery", agent: "cursor", mode: "persistent", cwd: dir });
    admission.assertReady();
    const exited = new Promise(resolve => children[0].once("exit", resolve)); children[0].kill("SIGTERM"); await exited;
    const turn = runtime.startTurn({ handle, text: "fixture", mode: "prompt", requestId: "reloaded", timeoutMs: 2000 });
    const drain = (async () => { for await (const _event of turn.events) { /* drain */ } })();
    const result = await turn.result; await drain;
    expect(children).toHaveLength(2); expect(methods).toContain("session/load");
    if (loadedMode === "plan") { expect(result.status).toBe("completed"); expect(methods.filter(m => m === "session/prompt")).toHaveLength(1); }
    else { expect(result.status).toBe("failed"); expect(methods).not.toContain("session/prompt"); }
  } finally {
    if (handle) await runtime.close({ handle, reason: "fixture cleanup" }).catch(() => {});
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["valid", "unsupported", "wrong-echo"])("actual cold manager requires %s mode control before a prompt", async behavior => {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAcpRuntime, createAgentRegistry, createRuntimeStore } = await import("acpx/runtime");
  const dir = await mkdtemp(join(tmpdir(), "cursor-mode-cold-"));
  const children: ReturnType<typeof spawn>[] = []; const methods: string[] = [];
  const peer = String.raw`
const fs=require('node:fs'), path=process.env.STATE;
let mode=fs.existsSync(path)?fs.readFileSync(path,'utf8'):'agent';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const configs=()=>[{id:'mode',name:'Mode',type:'select',currentValue:mode,options:['agent','plan','ask'].map(value=>({value,name:value}))},{id:'model',name:'Model',type:'select',currentValue:'fixture',options:[{value:'fixture',name:'Fixture'}]}];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 else if(m.method==='session/new'||m.method==='session/load')send({id:m.id,result:{sessionId:'native',modes:{currentModeId:mode,availableModes:['agent','plan','ask'].map(id=>({id,name:id}))},configOptions:configs()}});
 else if(m.method==='session/set_config_option'){
  if(m.params.configId==='mode') {
   if(process.env.BEHAVIOR==='unsupported')return send({id:m.id,error:{code:-32602,message:'Unsupported native mode'}});
   if(process.env.BEHAVIOR!=='wrong-echo'){mode=m.params.value;fs.writeFileSync(path,mode);}
  }
  send({id:m.id,result:{configOptions:configs()}});
 }
 else if(m.method==='session/prompt')send({id:m.id,result:{stopReason:'end_turn'}});
});`;
  const create = (mode: "agent" | "plan") => {
    const admission = createCursorModeAdmission(mode);
    const runtime = createAcpRuntime({ cwd: dir, agentRegistry: createAgentRegistry({ overrides: { cursor: "fixture" } }), sessionStore: createRuntimeStore({ stateDir: join(dir, "state") }), permissionMode: "deny-all",
      protocolGuardFactory: () => admission.createGuard(),
      onAcpMessage: (direction, value) => { if (direction === "outbound") methods.push((value as { method: string }).method); },
      spawnAgent: () => { const child = spawn(process.execPath, ["-e", peer], { cwd: dir, env: { STATE: join(dir, "mode"), BEHAVIOR: behavior }, stdio: ["pipe", "pipe", "pipe"] }); children.push(child); return child; },
    });
    return { runtime, admission };
  };
  const first = create("agent"); let second: ReturnType<typeof create> | undefined;
  let firstHandle; let secondHandle;
  const options = { sessionKey: "cold-mode", agent: "cursor", mode: "persistent" as const, cwd: dir };
  try {
    firstHandle = await first.runtime.ensureSession(options); first.admission.assertReady();
    await first.runtime.close({ handle: firstHandle, reason: "retire first manager" }); firstHandle = undefined;
    second = create("plan"); const count = children.length;
    secondHandle = await second.runtime.ensureSession(options); expect(children).toHaveLength(count);
    await second.runtime.setConfigOption({ handle: secondHandle, key: "model", value: "fixture" });
    expect(second.admission.isReady()).toBe(false);
    const selected = second.runtime.setConfigOption({ handle: secondHandle, key: "mode", value: "plan" });
    if (behavior !== "valid") {
      await expect(selected).rejects.toThrow(behavior === "unsupported" ? /Unsupported native mode/ : /did not apply/);
      expect(methods).not.toContain("session/prompt");
    } else {
      await selected; second.admission.assertReady();
      const turn = second.runtime.startTurn({ handle: secondHandle, text: "fixture", mode: "prompt", requestId: "cold-mode-turn", timeoutMs: 2000 });
      const drain = (async () => { for await (const _event of turn.events) { /* drain */ } })();
      expect((await turn.result).status).toBe("completed"); await drain;
      expect(methods.filter(m => m === "session/set_config_option")).toHaveLength(2);
      expect(methods.filter(m => m === "session/load")).toHaveLength(3);
      expect(methods.filter(m => m === "session/prompt")).toHaveLength(1);
    }
  } finally {
    if (firstHandle) await first.runtime.close({ handle: firstHandle, reason: "cleanup" }).catch(() => {});
    if (second && secondHandle) await second.runtime.close({ handle: secondHandle, reason: "cleanup" }).catch(() => {});
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
