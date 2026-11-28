import { describe, expect, it } from "vitest";
import { admittedClaudeEffort, createClaudeEffortAdmission, resolveClaudeEffort } from "./claude-effort.js";

const response = (value: string, sessionId?: string) => ({ ...(sessionId ? { sessionId } : {}), configOptions: [{ id: "effort", currentValue: value }] });
function loaded(method = "session/new") {
  const admission = createClaudeEffortAdmission("high");
  const guard = admission.createGuard();
  guard("outbound", { id: 1, method, params: method === "session/new" ? {} : { sessionId: "s" } });
  guard("inbound", { id: 1, result: response("medium", method === "session/new" ? "s" : undefined) });
  return { admission, guard };
}
function select(guard: ReturnType<ReturnType<typeof createClaudeEffortAdmission>["createGuard"]>, acknowledged = "high") {
  guard("outbound", { id: 2, method: "session/set_config_option", params: { sessionId: "s", configId: "effort", value: "high" } });
  guard("inbound", { id: 2, result: response(acknowledged) });
}
describe("Claude effort admission", () => {
  it.each(["low", "medium", "high", "xhigh", "max"] as const)("accepts exact %s without aliases", value => {
    expect(resolveClaudeEffort("claude", value)).toBe(value);
    expect(admittedClaudeEffort("claude", value, { claudeEffort: value }, { claudeEffort: value })).toBe(value);
  });
  it("rejects unsupported, foreign and conflicting effort", () => {
    for (const value of ["ultra", "off", null, 2]) expect(() => resolveClaudeEffort("claude", value)).toThrow();
    expect(() => resolveClaudeEffort("pi", "high")).toThrow("only supported");
    expect(() => admittedClaudeEffort("claude", "high", { claudeEffort: "high" }, { claudeEffort: "medium" })).toThrow("differs");
  });
  it.each(["session/new", "session/load", "session/resume"])("requires acknowledged effort before prompting after %s", method => {
    const { admission, guard } = loaded(method);
    expect(admission.isReady()).toBe(false);
    select(guard);
    expect(admission.isReady()).toBe(true);
    expect(() => guard("outbound", { id: 3, method: "session/prompt", params: { sessionId: "s" } })).not.toThrow();
  });

  it("rejects a resumed session with missing effort configuration", () => {
    const admission = createClaudeEffortAdmission("high");
    const guard = admission.createGuard();
    guard("outbound", { id: 1, method: "session/resume", params: { sessionId: "s" } });
    expect(() => guard("inbound", { id: 1, result: {} })).toThrow("missing or ambiguous");
  });
  it("blocks a prompt based only on a restored default", () => {
    const { guard } = loaded("session/load");
    expect(() => guard("outbound", { id: 3, method: "session/prompt", params: { sessionId: "s" } })).toThrow("does not acknowledge");
  });

  it("requires a fresh effort selection on a cold connection that restores the settings default", () => {
    const { admission, guard } = loaded();
    select(guard);
    const resumed = admission.createGuard();
    resumed("outbound", { id: 4, method: "session/resume", params: { sessionId: "s" } });
    resumed("inbound", { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "config_option_update", ...response("default") } } });
    resumed("inbound", { id: 4, result: response("default") });
    expect(admission.isReady()).toBe(false);
    resumed("outbound", { id: 6, method: "session/set_config_option", params: { sessionId: "s", configId: "model", value: "pinned" } });
    resumed("inbound", { id: 6, result: response("default") });
    expect(admission.isReady()).toBe(false);
    select(resumed);
    expect(admission.isReady()).toBe(true);
    expect(() => resumed("outbound", { id: 7, method: "session/prompt", params: { sessionId: "s" } })).not.toThrow();
  });
  it("blocks a prompt on a cold connection before it selects the bound effort again", () => {
    const { admission, guard } = loaded();
    select(guard);
    const resumed = admission.createGuard();
    resumed("outbound", { id: 4, method: "session/resume", params: { sessionId: "s" } });
    resumed("inbound", { id: 4, result: response("default") });
    expect(() => resumed("outbound", { id: 5, method: "session/prompt", params: { sessionId: "s" } })).toThrow("does not acknowledge");
  });
  it("admits a cold connection whose restored session already acknowledges the bound effort", () => {
    const { admission, guard } = loaded();
    select(guard);
    const acknowledged = admission.createGuard();
    acknowledged("outbound", { id: 4, method: "session/load", params: { sessionId: "s" } });
    acknowledged("inbound", { id: 4, result: response("high") });
    expect(() => acknowledged("outbound", { id: 5, method: "session/prompt", params: { sessionId: "s" } })).not.toThrow();
  });
  it("rejects a cold re-selection that the provider does not apply", () => {
    const { admission, guard } = loaded();
    select(guard);
    const resumed = admission.createGuard();
    resumed("outbound", { id: 4, method: "session/resume", params: { sessionId: "s" } });
    resumed("inbound", { id: 4, result: response("default") });
    expect(() => select(resumed, "default")).toThrow("did not apply");
    expect(() => resumed("outbound", { id: 5, method: "session/prompt", params: { sessionId: "s" } })).toThrow("did not apply");
  });
  it.each(["notification", "restore", "configuration"])("rejects %s drift after a cold connection acknowledged the bound effort", kind => {
    const { admission, guard } = loaded();
    select(guard);
    const resumed = admission.createGuard();
    resumed("outbound", { id: 4, method: "session/resume", params: { sessionId: "s" } });
    resumed("inbound", { id: 4, result: response("default") });
    select(resumed);
    const drift = () => {
      if (kind === "notification") resumed("inbound", { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "config_option_update", ...response("default") } } });
      else if (kind === "restore") {
        resumed("outbound", { id: 8, method: "session/load", params: { sessionId: "s" } });
        resumed("inbound", { id: 8, result: response("default") });
      } else {
        resumed("outbound", { id: 8, method: "session/set_config_option", params: { sessionId: "s", configId: "model", value: "pinned" } });
        resumed("inbound", { id: 8, result: response("default") });
      }
    };
    expect(drift).toThrow(kind === "configuration" ? "did not apply" : "drifted");
    expect(() => resumed("outbound", { id: 9, method: "session/prompt", params: { sessionId: "s" } })).toThrow();
  });
  it("rejects a provider that ignores the requested effort", () => {
    const { guard } = loaded();
    expect(() => select(guard, "medium")).toThrow("did not apply");
  });
  it("rejects drift and wrong-session prompts after admission", () => {
    const { guard } = loaded(); select(guard);
    expect(() => guard("inbound", { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "config_option_update", ...response("low") } } })).toThrow("drifted");
    const fresh = loaded(); select(fresh.guard);
    expect(() => fresh.guard("outbound", { id: 3, method: "session/prompt", params: { sessionId: "foreign" } })).toThrow("different session");
  });
});

it("actual ACPX cold cross-process resume selects the bound effort again before the prompt", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAcpRuntime, createAgentRegistry, createFileSessionStore } = await import("acpx/runtime");
  const root = await mkdtemp(join(tmpdir(), "claude-effort-wire-"));
  const children: Array<{ child: ReturnType<typeof spawn>; closed: Promise<void> }> = [];
  const wire: string[] = [];
  const admission = createClaudeEffortAdmission("high");
  const peer = String.raw`
let effort='default';
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const configs=()=>[{id:'effort',name:'Effort',type:'select',currentValue:effort,options:['default','low','medium','high','xhigh','max'].map(value=>({value,name:value}))}];
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}},authMethods:[]}});
 else if(m.method==='session/new')send({id:m.id,result:{sessionId:'native',configOptions:configs()}});
 else if(m.method==='session/resume'){
  send({method:'session/update',params:{sessionId:'native',update:{sessionUpdate:'config_option_update',configOptions:configs()}}});
  send({id:m.id,result:{configOptions:configs()}});
 }
 else if(m.method==='session/set_config_option'){
  if(m.params.configId==='effort')effort=m.params.value;
  send({id:m.id,result:{configOptions:configs()}});
 }
 else if(m.method==='session/prompt')send({id:m.id,result:{stopReason:'end_turn'}});
 else if(m.id!==undefined)send({id:m.id,error:{code:-32601,message:'Method not found'}});
});`;
  const options = {
    cwd: root, agentRegistry: createAgentRegistry({ overrides: { claude: "fixture" } }),
    sessionStore: createFileSessionStore({ stateDir: join(root, "state") }), permissionMode: "deny-all" as const,
    protocolGuardFactory: () => admission.createGuard(),
    onAcpMessage: (direction: "inbound" | "outbound", value: unknown) => {
      const message = value as { id?: unknown; method?: string; params?: { configId?: string }; result?: { configOptions?: Array<{ id?: string; currentValue?: string }> } };
      if (direction === "outbound" && message.method) wire.push(message.params?.configId ? `${message.method}:${message.params.configId}` : message.method);
      const effort = message.result?.configOptions?.find(option => option.id === "effort")?.currentValue;
      if (direction === "inbound" && message.method === undefined && effort) wire.push(`ack:${effort}`);
    },
    spawnAgent: () => {
      const child = spawn(process.execPath, ["-e", peer], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.on("error", () => {}); children.push({ child, closed }); return child;
    },
  };
  try {
    const first = createAcpRuntime(options);
    const opened = await first.ensureSession({ sessionKey: "claude-effort", agent: "claude", mode: "persistent", cwd: root });
    await first.setConfigOption({ handle: opened, key: "effort", value: "high" });
    admission.assertReady();
    await first.close({ handle: opened, reason: "control connection done" });
    wire.push("closed");
    const second = createAcpRuntime(options);
    const resumed = await second.ensureSession({ sessionKey: "claude-effort", agent: "claude", mode: "persistent", cwd: root });
    const turn = second.startTurn({ handle: resumed, text: "fixture", mode: "prompt", requestId: "cold", timeoutMs: 5000 });
    const drain = (async () => { for await (const _event of turn.events) { continue; } })();
    const result = await turn.result; await drain;
    await second.close({ handle: resumed, reason: "fixture cleanup" });
    expect(result.status).toBe("completed");
    const cold = wire.slice(wire.indexOf("closed") + 1).filter(entry => entry !== "initialize" && entry !== "session/update");
    expect(cold).toEqual(["session/resume", "ack:default", "session/set_config_option:effort", "ack:high", "session/prompt"]);
    expect(children.length).toBeGreaterThan(1);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.allSettled(children.map(({ closed }) => closed));
    await rm(root, { recursive: true, force: true });
  }
});
