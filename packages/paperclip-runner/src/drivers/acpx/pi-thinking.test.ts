import { describe, expect, it } from "vitest";
import { admittedPiThinkingLevel, createPiThinkingAdmission, resolvePiThinkingLevel } from "./pi-thinking.js";

const config = (mode: string) => [{ id: "thought_level", type: "select", currentValue: mode, options: ["high", "low", "max"].map(value => ({ value, name: value })) }];
const session = (mode: string) => ({ sessionId: "native", modes: { currentModeId: mode }, configOptions: config(mode) });
const prompt = { id: 9, method: "session/prompt", params: { sessionId: "native" } };
function opened(expected: "off" | "low" | "high" | "max", initial: string = expected) {
  const admission = createPiThinkingAdmission(expected); const guard = admission.createGuard();
  guard("outbound", { id: 0, method: "session/new", params: {} });
  guard("inbound", { id: 0, result: session(initial) });
  if (initial === expected) {
    guard("outbound", { id: 100, method: "session/set_config_option", params: { sessionId: "native", configId: "thought_level", value: expected } });
    guard("inbound", { id: 100, result: { configOptions: config(expected) } });
  }
  return { admission, guard };
}

describe("Pi thinking native mode admission", () => {
  it("requires explicit Pi thinking and rejects unadmitted aliases and other providers", () => {
    expect(() => resolvePiThinkingLevel("pi", undefined)).toThrow(/explicit/);
    expect(resolvePiThinkingLevel("codex", undefined)).toBeUndefined();
    for (const mode of ["code", "architect", "search", "chat", "", null]) expect(() => resolvePiThinkingLevel("pi", mode)).toThrow();
    expect(() => resolvePiThinkingLevel("cursor", "high")).toThrow(/only supported/);
  });
  it.each(["off", "low", "high", "max"] as const)("admits %s only after correlated native acknowledgements", expected => {
    const { admission, guard } = opened(expected);
    admission.assertReady(); guard("outbound", prompt);
    const reloaded = admission.createGuard();
    expect(admission.assertReady).toThrow();
    expect(() => guard("outbound", prompt)).toThrow(/replaced/);
    reloaded("outbound", { id: 1, method: "session/load", params: { sessionId: "native" } });
    reloaded("inbound", { id: 1, result: session(expected) });
    admission.assertReady(); reloaded("outbound", prompt);
  });
  it.each(["medium", "high"])("allows initial %s/model-selection updates but requires a correlated low setter before prompting", initial => {
    const { admission, guard } = opened("low", initial);
    guard("inbound", { method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "current_mode_update", currentModeId: "high" } } });
    guard("inbound", { method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "config_option_update", configOptions: config("high") } } });
    expect(admission.isReady()).toBe(false);
    guard("outbound", { id: 2, method: "session/set_config_option", params: { sessionId: "native", configId: "thought_level", value: "low" } });
    guard("inbound", { method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "current_mode_update", currentModeId: "low" } } });
    expect(admission.isReady()).toBe(false);
    guard("inbound", { id: 2, result: { configOptions: config("low") } });
    admission.assertReady(); guard("outbound", prompt);
  });
  it("never admits from an initial matching mode before the explicit setter", () => {
    const admission = createPiThinkingAdmission("low"); const guard = admission.createGuard();
    guard("outbound", { id: 0, method: "session/new", params: {} });
    guard("inbound", { id: 0, result: session("low") });
    expect(() => guard("outbound", prompt)).toThrow(/admission/);
  });
  it("permits explicit initial configuration and does not use an update as its acknowledgement", () => {
    const { admission, guard } = opened("low", "high");
    expect(admission.isReady()).toBe(false);
    guard("outbound", { id: 2, method: "session/set_config_option", params: { sessionId: "native", configId: "thought_level", value: "low" } });
    guard("inbound", { method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "current_mode_update", currentModeId: "low" } } });
    expect(admission.isReady()).toBe(false);
    guard("inbound", { id: 2, result: { configOptions: config("low") } });
    admission.assertReady(); guard("outbound", prompt);
  });
  it.each(["missing", "conflicting", "wrong"])("gates a reloaded prompt with %s mode acknowledgement", kind => {
    const { admission } = opened("low"); const guard = admission.createGuard();
    guard("outbound", { id: 2, method: "session/load", params: { sessionId: "native" } });
    const result = kind === "missing" ? {} : kind === "conflicting" ? { ...session("low"), modes: { currentModeId: "max" } } : session("high");
    expect(() => guard("inbound", { id: 2, result })).toThrow(/mode admission/);
    expect(() => guard("outbound", prompt)).toThrow(/mode admission/);
  });
  it.each([false, true])("cannot repair incompatible restored mode with a later setter, cold restoration=%s", cold => {
    const admission = cold ? createPiThinkingAdmission("low", { restoring: true }) : opened("low").admission;
    const guard = admission.createGuard();
    guard("outbound", { id: 2, method: "session/load", params: { sessionId: "native" } });
    expect(() => guard("inbound", { id: 2, result: session("high") })).toThrow(/drifted/);
    expect(() => guard("outbound", { id: 3, method: "session/set_config_option", params: { sessionId: "native", configId: "thought_level", value: "low" } })).toThrow(/drifted/);
    expect(() => guard("outbound", prompt)).toThrow(/drifted/);
  });
  it("rejects overlapping configuration controls so one ACK cannot admit another pending mutation", () => {
    const { guard, admission } = opened("low");
    guard("outbound", { id: 4, method: "session/set_config_option", params: { sessionId: "native", configId: "model", value: "qualified" } });
    expect(() => guard("outbound", { id: 5, method: "session/set_config_option", params: { sessionId: "native", configId: "thought_level", value: "low" } })).toThrow(/overlapping/);
    expect(() => guard("inbound", { id: 4, result: { configOptions: config("low") } })).toThrow(/overlapping/);
    expect(admission.assertReady).toThrow(/overlapping/);
  });
  it("blocks prompts while admitted configuration is pending and restores only from its exact ACK", () => {
    const pending = opened("low");
    pending.guard("outbound", { id: 4, method: "session/set_config_option", params: { sessionId: "native", configId: "model", value: "qualified" } });
    expect(pending.admission.isReady()).toBe(false);
    expect(() => pending.guard("outbound", prompt)).toThrow(/admission/);
    const awaited = opened("low");
    awaited.guard("outbound", { id: 4, method: "session/set_config_option", params: { sessionId: "native", configId: "model", value: "qualified" } });
    awaited.guard("inbound", { id: 4, result: { configOptions: config("low") } });
    awaited.guard("outbound", prompt);
  });
  it("rejects late mode drift and keeps the connection failed closed", () => {
    const { admission, guard } = opened("low");
    expect(() => guard("inbound", { method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "current_mode_update", currentModeId: "high" } } })).toThrow(/drifted/);
    expect(admission.assertReady).toThrow(/drifted/);
    expect(() => guard("outbound", prompt)).toThrow(/drifted/);
  });
  it("rejects wrong config echoes, uncorrelated acknowledgements and cross-session control", () => {
    const forged = createPiThinkingAdmission("low"); const g = forged.createGuard();
    g("inbound", { id: 2, result: session("low") }); expect(forged.assertReady).toThrow();
    const { guard } = opened("low", "high");
    guard("outbound", { id: 2, method: "session/set_config_option", params: { sessionId: "native", configId: "thought_level", value: "low" } });
    expect(() => guard("inbound", { id: 2, result: { configOptions: config("high") } })).toThrow(/did not apply/);
    const other = opened("low").guard;
    expect(() => other("outbound", { id: 3, method: "session/set_config_option", params: { sessionId: "other", configId: "thought_level", value: "low" } })).toThrow(/different session/);
  });
  it.each([false, true])("rejects config-option mode drift with active prompt=%s", active => {
    const { admission, guard } = opened("low");
    if (active) guard("outbound", prompt);
    expect(() => guard("inbound", { method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "config_option_update", configOptions: config("high") } } })).toThrow(/drifted/);
    expect(admission.assertReady).toThrow(/drifted/);
  });
  it.each(["foreign", "duplicate", "invalid"])("rejects %s mode configuration notifications", kind => {
    const { guard } = opened("low");
    const options = kind === "duplicate" ? [...config("low"), ...config("low")] : config(kind === "invalid" ? "architect" : "low");
    expect(() => guard("inbound", { method: "session/update", params: { sessionId: kind === "foreign" ? "other" : "native", update: { sessionUpdate: "config_option_update", configOptions: options } } })).toThrow(/mode admission/);
  });
  it("ignores model-only partial updates and cannot admit from a mode notification", () => {
    const { admission, guard } = opened("low", "high");
    for (const options of [[{ id: "model", currentValue: "fixture" }], config("low")]) {
      guard("inbound", { method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "config_option_update", configOptions: options } } });
      expect(admission.isReady()).toBe(false);
    }
  });
  it("does not mistake a bare set_mode response for configuration proof", () => {
    const { admission, guard } = opened("low", "high");
    guard("outbound", { id: 4, method: "session/set_mode", params: { sessionId: "native", modeId: "low" } });
    guard("inbound", { id: 4, result: {} }); expect(admission.assertReady).toThrow();
  });
});


// Real ACPX manager/SDK transport, deterministic local child (not the real Pi
// model). The separate pinned-Pi package contract proves its effective wire.
it.each(["valid", "wrong-echo", "unsupported"])("actual ACPX initial model selection then low admission: %s", async behavior => {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAcpRuntime, createAgentRegistry, createRuntimeStore } = await import("acpx/runtime");
  const root = await mkdtemp(join(tmpdir(), "pi-thinking-wire-"));
  const children: Array<{ child: ReturnType<typeof spawn>; closed: Promise<void> }> = [];
  const methods: string[] = [];
  const admission = createPiThinkingAdmission("low");
  const peer = String.raw`
let mode='medium';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const configs=()=>[{id:'thought_level',name:'Thinking',type:'select',currentValue:mode,options:['off','low','medium','high','max'].map(value=>({value,name:value}))},{id:'model',name:'Model',type:'select',currentValue:'qualified',options:[{value:'qualified',name:'Qualified'}]}];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 else if(m.method==='session/new'||m.method==='session/load')send({id:m.id,result:{sessionId:'native',modes:{currentModeId:mode,availableModes:['off','low','medium','high','max'].map(id=>({id,name:id}))},configOptions:configs()}});
 else if(m.method==='session/set_config_option'){
  if(m.params.configId==='model')mode='high';
  else if(m.params.configId==='thought_level'){
   if(process.env.BEHAVIOR==='unsupported')return send({id:m.id,error:{code:-32602,message:'Unsupported level'}});
   if(process.env.BEHAVIOR!=='wrong-echo')mode=m.params.value;
  }
  send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'current_mode_update',currentModeId:mode}}});
  send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'config_option_update',configOptions:configs()}}});
  send({id:m.id,result:{configOptions:configs()}});
 }
 else if(m.method==='session/prompt')send({id:m.id,result:{stopReason:'end_turn'}});
});`;
  const runtime = createAcpRuntime({ cwd: root, agentRegistry: createAgentRegistry({ overrides: { pi: "fixture" } }), sessionStore: createRuntimeStore({ stateDir: join(root, "state") }), permissionMode: "deny-all",
    protocolGuardFactory: () => admission.createGuard(),
    onAcpMessage: (direction, value) => { if (direction === "outbound") methods.push((value as { method: string }).method); },
    spawnAgent: () => {
      const child = spawn(process.execPath, ["-e", peer], { cwd: root, env: { BEHAVIOR: behavior }, stdio: ["pipe", "pipe", "pipe"] });
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.on("error", () => {}); children.push({ child, closed }); return child;
    },
  });
  let handle;
  try {
    handle = await runtime.ensureSession({ sessionKey: "pi-mode", agent: "pi", mode: "persistent", cwd: root, sessionOptions: { model: "qualified" } });
    expect(admission.isReady()).toBe(false);
    await runtime.setConfigOption({ handle, key: "model", value: "qualified" });
    expect(admission.isReady()).toBe(false);
    const selecting = runtime.setConfigOption({ handle, key: "thought_level", value: "low" });
    if (behavior !== "valid") { await expect(selecting).rejects.toThrow(); expect(methods).not.toContain("session/prompt"); return; }
    await selecting; admission.assertReady();
    const turn = runtime.startTurn({ handle, text: "fixture", mode: "prompt", requestId: "once", timeoutMs: 2000 });
    const drain = (async () => { for await (const _event of turn.events) { /* drain */ } })();
    expect((await turn.result).status).toBe("completed"); await drain;
    expect(methods.filter(method => method === "session/prompt")).toHaveLength(1);
    expect(methods.filter(method => method === "session/set_config_option")).toHaveLength(2);
  } finally {
    try { if (handle) await runtime.close({ handle, reason: "fixture cleanup" }); }
    finally {
      for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await Promise.allSettled(children.map(({ closed }) => closed));
      await rm(root, { recursive: true, force: true });
    }
  }
});

it("publishes only independently matching observed Pi mode, never the requested value alone", () => {
  expect(admittedPiThinkingLevel("pi", "low", { piThinkingLevel: "low" }, { piThinkingLevel: "low" })).toBe("low");
  for (const observed of [undefined, "high", "medium", null]) {
    expect(() => admittedPiThinkingLevel("pi", "low", { piThinkingLevel: "low" }, { piThinkingLevel: observed })).toThrow();
    expect(() => admittedPiThinkingLevel("pi", "low", { piThinkingLevel: observed }, { piThinkingLevel: "low" })).toThrow();
  }
  expect(admittedPiThinkingLevel("codex", undefined, {}, {})).toBeUndefined();
  expect(() => admittedPiThinkingLevel("codex", undefined, {}, { piThinkingLevel: "low" })).toThrow();
});

it("preserves effective Pi mode through the persisted harness identity projection", async () => {
  const { parseProviderIdentity } = await import("../codex/codex-driver-values.js");
  const value = { kind: "acpx", normalizedSessionId: "session", acpxRecordId: "record", backendSessionId: "backend", agentSessionId: "agent", profileDigest: "sha256:profile", workspaceDigest: "sha256:workspace", requestedModel: "model", effectiveModel: "model", piThinkingLevel: "low", providerLifetimeFenceCandidates: [60001, 60002, 60003] };
  expect(parseProviderIdentity(value)).toMatchObject({ piThinkingLevel: "low" });
  expect(() => parseProviderIdentity({ ...value, piThinkingLevel: "medium" })).toThrow();
});
