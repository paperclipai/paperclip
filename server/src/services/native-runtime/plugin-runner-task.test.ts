import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RunnerProviderLaunchRequirements } from "@paperclipai/paperclip-runner";
import type { RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import { createPluginRunnerTaskOwner } from "./plugin-runner-task.js";

const ingress = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../realtime/runner-prp-outbound.js", () => ({ connectRunnerPrpIngress: ingress.connect }));

function launchSpec(): RunnerProcessLaunchSpec {
  return { command: "unused", args: [], cwd: "/unused", environment: {}, nativeRunner: {
    identity: { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "run",
      normalizedSessionId: "session", turnId: "turn", itemId: "item" }, ticket: "synthetic-ticket",
    diagnosticsDirectory: "/controller/private/diagnostics",
    stateDirectory: "/state", runnerVersion: "fixture", runnerDigest: `sha256:${"a".repeat(64)}`,
    maxOutboxBytes: 262144, p0ReserveBytes: 65536, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
  } };
}

const requirements: RunnerProviderLaunchRequirements = {
  schema: "paperclip.runner.launch-requirements.v1", identity: launchSpec().nativeRunner!.identity,
  provider: "codex", model: "fixture", instructions: "Core policy", runtimeContext: null,
  settings: {}, approvalPolicy: "never", readOnly: false, preparedConversation: false,
  includeCollaborationModeInstructions: false,
};
function launchRequirements(harness: string): RunnerProviderLaunchRequirements {
  return harness === "claude" ? { ...requirements, provider: "acpx", settings: { acpxAgent: "claude" } } : requirements;
}
async function prepare(owner: ReturnType<typeof createPluginRunnerTaskOwner>, current = requirements) {
  await owner.driver.prepareLaunch!(current);
}
function provider() {
  let stopped = false;
  const task = vi.fn(async (operation: any): Promise<unknown> => {
    if (operation.kind === "check_project_auth") return { kind: "project_auth", taskId: "task", allowed: true,
      provider: operation.provider, configurationId: operation.configurationId };
    if (operation.kind === "prepare") return { kind: "prepared", taskId: "task", launch: {
      configurationId: "configuration", requirementsDigest: `sha256:${"a".repeat(64)}`, provider: { kind: "codex" },
    } };
    if (operation.kind === "read_state") return { kind: "state", taskId: "task", state: {
      schema: "paperclip.runner.durable.state.v1", ...operation.identity, lifecycle: "suspended",
    } };
    if (operation.kind === "stop") stopped = true;
    if (operation.kind === "status") return { kind: "status", taskId: "task", phase: stopped ? "cancelled" : "running", executionStopped: stopped, sessionStateAvailable: stopped };
    if (operation.kind === "connection") return { kind: "connection", taskId: "task", endpoint: {
      kind: "authenticated_websocket", websocketUrl: "wss://fixture.example.test/connect", generation: "fixture", secretHeaders: [],
    } };
    return { kind: "accepted", taskId: "task" };
  });
  return { task };
}

describe("plugin native Runner ownership", () => {
  it("submits only a prepared identity and configuration ID", async () => {
    const { task } = provider();
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1, task, projectIds: [], harness: "codex", pollMs: 1 });
    expect(() => owner.launcher(launchSpec())).toThrow("requires preparation");
    await prepare(owner);
    expect(task.mock.calls[0][0]).toEqual({ kind: "prepare", requirements, projectIds: [] });
    expect(task.mock.calls[1][0]).toMatchObject({ kind: "check_project_auth", configurationId: "configuration", provider: "openai" });
    expect(() => owner.launcher({ ...launchSpec(), nativeRunner: { ...launchSpec().nativeRunner!,
      identity: { ...requirements.identity, runId: "other" } } })).toThrow("structured per-turn");
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const registration = await owner.registration({} as never, "run");
    const handle = owner.launcher(launchSpec());
    registration.activate(); await registration.ready();
    await registration.release(); await registration.checkpoint("unsettled"); await handle.completion;
    expect(task.mock.calls.find(([op]) => op.kind === "submit")?.[0]).toMatchObject({ preparedLaunchId: "configuration" });
  });
  it("omits duplicate project validation only when the provider enforces it at submission", async () => {
    const { task } = provider();
    const perform = task.getMockImplementation()!;
    task.mockImplementation(async op => op.kind === "prepare"
      ? { ...await perform(op) as object, projectAuthCheckAtSubmit: true } : perform(op));
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1,
      task, projectIds: [], harness: "codex", pollMs: 1 });
    await prepare(owner);
    expect(task.mock.calls.map(([op]) => op.kind)).toEqual(["prepare"]);
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const registration = await owner.registration({} as never, "run");
    const handle = owner.launcher(launchSpec());
    registration.activate(); await registration.ready();
    await registration.release(); await registration.checkpoint("unsettled"); await handle.completion;
    expect(task.mock.calls.filter(([op]) => op.kind === "submit")).toHaveLength(1);
    const unsupported = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex" });
    await expect(prepare(unsupported)).rejects.toThrow("validation unavailable");
  });

  it("does not accept a late preparation after task release", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const { task } = provider(); const perform = task.getMockImplementation()!;
    task.mockImplementation(async op => { if (op.kind === "prepare") await gate; return perform(op); });
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1, task, projectIds: [], harness: "codex" });
    const prepared = prepare(owner);
    const registration = await owner.registration({} as never, "run");
    await registration.release(); finish();
    await expect(prepared).rejects.toThrow("preparation cancelled");
    expect(task.mock.calls.some(([op]) => op.kind === "submit")).toBe(false);
  });
  it.each(["unsupported", "denied", "wrong-configuration", "wrong-provider"])("withholds credentials when project validation is %s", async mode => {
    const { task } = provider(); const perform = task.getMockImplementation()!;
    task.mockImplementation(async op => op.kind === "check_project_auth"
      ? { kind: "project_auth", taskId: "task", allowed: mode !== "denied",
          configurationId: mode === "wrong-configuration" ? "other" : op.configurationId,
          provider: mode === "wrong-provider" ? "anthropic" : op.provider } : perform(op));
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex",
      projectAuthCheckVersion: mode === "unsupported" ? undefined : 1,
      credentialIdentity: "revision", accountIdentity: "account", credential: { type: "codex-auth-json", authJson: '{"OPENAI_API_KEY":"never-transfer"}' } });
    await expect(prepare(owner)).rejects.toThrow(mode === "unsupported" ? "validation unavailable" : "conflicts");
    expect(() => owner.launcher(launchSpec())).toThrow("requires preparation");
    expect(JSON.stringify(task.mock.calls)).not.toContain("never-transfer");
    expect(task.mock.calls.some(([op]) => op.kind === "submit")).toBe(false);
  });
  it("rejects an installed account when the plugin lacks project validation", async () => {
    const { task } = provider();
    const owner = createPluginRunnerTaskOwner({ task, projectIds: [], harness: "codex" });
    await expect(prepare(owner)).rejects.toThrow("validation unavailable");
    expect(task.mock.calls.some(([op]) => op.kind === "submit")).toBe(false);
  });
  it("collects refreshed credentials after process termination and before releasing task grants", async () => {
    const { task } = provider();
    const perform = task.getMockImplementation()!;
    const credential = { type: "codex-auth-json" as const, authJson: '{"OPENAI_API_KEY":"fixture-key"}' };
    let copied = false;
    task.mockImplementation(async operation => {
      if (operation.kind === "credentials") {
        expect(task.mock.calls.some(([op]) => op.kind === "stop")).toBe(true);
        return { kind: "credentials", taskId: "task", credential };
      }
      if (operation.kind === "complete") expect(copied).toBe(true);
      return perform(operation);
    });
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1, task, projectIds: [], harness: "codex", credential,
      credentialIdentity: "revision", accountIdentity: "stable-account", pollMs: 1,
      onCredentials: async value => { expect(value).toEqual(credential); copied = true; } });
    await prepare(owner);
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec()); registration.activate(); await registration.ready();
    expect(task.mock.calls.find(([op]) => op.kind === "submit")?.[0]).toMatchObject({ credential, credentialIdentity: "revision", accountIdentity: "stable-account" });
    await registration.release(); await registration.checkpoint("settled"); await process.completion;
    expect(copied).toBe(true);
  });
  it("retains grants when the credential handoff fails", async () => {
    const { task } = provider();
    const perform = task.getMockImplementation()!;
    task.mockImplementation(async op => op.kind === "credentials" ? { kind: "credentials", taskId: "task", credential: { type: "codex-auth-json", authJson: "{}" } } : perform(op));
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1, task, projectIds: [], harness: "codex", accountIdentity: "account", pollMs: 1,
      onCredentials: async () => { throw new Error("credential handoff failed"); } });
    await prepare(owner);
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec()); registration.activate(); await registration.ready(); await registration.release();
    await expect(registration.checkpoint("settled")).rejects.toThrow("credential handoff failed");
    await process.completion;
    expect(task.mock.calls.some(([op]) => op.kind === "complete")).toBe(false);
  });

  it.each([false, true])("records retained sessions after status failures (retry exhausted: %s)", async exhausted => {
    const { task } = provider();
    const perform = task.getMockImplementation()!;
    let failStatus = false;
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    task.mockImplementation(async operation => {
      if (operation.kind === "stop") failStatus = false;
      if (operation.kind === "status" && failStatus) {
        failStatus = exhausted;
        if (exhausted) clock += 16_000;
        throw new Error("status connection lost");
      }
      return perform(operation);
    });
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const checkpoint = vi.fn(async () => {});
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1, task, projectIds: [], harness: "codex", onSessionRetained: checkpoint, pollMs: 1,
      });
    await prepare(owner);
    const registration = await owner.registration({} as never, "run");
    const handle = owner.launcher(launchSpec());
    const completed = vi.fn(); void handle.completion.then(completed);
    try {
      registration.activate(); await registration.ready();
      expect(handle.restart).toBeNull();
      failStatus = true;
      if (exhausted) await expect(registration.failure).rejects.toThrow("reconcile the saved task");
      else await vi.waitFor(() => expect(failStatus).toBe(false));
      expect(completed).not.toHaveBeenCalled();
      await registration.release(); await registration.checkpoint("settled");
      await expect(handle.completion).resolves.toMatchObject({ code: 1 });
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(task.mock.calls.filter(([op]) => op.kind === "submit")).toHaveLength(1);
      expect(task.mock.calls.filter(([op]) => op.kind === "complete")).toHaveLength(1);
    } finally { now.mockRestore(); handle.child.kill(); }
  });
  it("exposes connection failure before activation and forwards late recovery exhaustion", async () => {
    const { task } = provider();
    let fail!: (error: Error) => void;
    const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), failure, close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1, task, projectIds: [], harness: "codex",  pollMs: 1 });
    await prepare(owner);
    const registration = await owner.registration({} as never, "run");
    const observed = registration.failure.catch(error => error);
    const handle = owner.launcher(launchSpec());
    registration.activate(); await registration.ready();
    const error = new Error("runner ingress recovery exhausted"); fail(error);
    expect(await observed).toBe(error);
    expect(task.mock.calls.find(([op]) => op.kind === "stop")).toBeUndefined();
    await registration.release(); await registration.checkpoint("settled"); await handle.completion;
  });
  it("reconciles a lost submit reply without launching another attempt", async () => {
    const { task } = provider();
    const perform = task.getMockImplementation()!;
    let lost = true, statusLost = true;
    task.mockImplementation(async op => {
      if (op.kind === "submit" && lost) { lost = false; throw new Error("lost submit reply"); }
      if (op.kind === "status" && statusLost) { statusLost = false; throw new Error("status temporarily unavailable"); }
      return perform(op);
    });
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1, task, projectIds: [], harness: "codex",
       pollMs: 1 });
    await prepare(owner);
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec());
    try {
      registration.activate(); await registration.ready();
      expect(task.mock.calls.filter(([operation]) => operation.kind === "submit")).toHaveLength(1);
      expect(task.mock.calls.find(([operation]) => operation.kind === "submit")?.[0].launch).not.toHaveProperty("diagnosticsDirectory");
      expect(() => owner.launcher(launchSpec())).toThrow("new task lease");
      await registration.release(); await registration.checkpoint("settled"); await process.completion;
      expect(task.mock.calls.filter(([operation]) => operation.kind === "complete")).toHaveLength(1);
    } finally { process.child.kill(); await process.completion.catch(() => {}); }
  });

  it("retains task grants when retention recording fails after route release", async () => {
    const { task } = provider();
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close: async () => {} });
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1, task, projectIds: [], harness: "codex", onSessionRetained: async () => { throw new Error("retention write failed"); }, pollMs: 1 });
    await prepare(owner);
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec());
    registration.activate(); await registration.ready(); await registration.release();
    expect(task.mock.calls.some(([operation]) => operation.kind === "complete")).toBe(false);
    await expect(registration.checkpoint("settled")).rejects.toThrow("retention write failed");
    await process.completion;
    expect(task.mock.calls.some(([operation]) => operation.kind === "complete")).toBe(false);
  });

  it("detaches a controller without stopping its durable task", async () => {
    const { task } = provider();
    const close = vi.fn(async () => {});
    ingress.connect.mockReturnValue({ ready: Promise.resolve(), close });
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1, task, projectIds: [], harness: "codex",
       pollMs: 1 });
    await prepare(owner);
    const registration = await owner.registration({} as never, "run");
    owner.launcher(launchSpec());
    registration.activate(); await registration.ready(); await registration.release("detach");
    expect(close).toHaveBeenCalledOnce();
    expect(task.mock.calls.some(([operation]) => operation.kind === "stop" || operation.kind === "complete")).toBe(false);
  });

  it("prevents a late submission after cancellation during dispatch recording", async () => {
    let finish!: () => void;
    const prepared = new Promise<void>(resolve => { finish = resolve; });
    const { task } = provider();
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1, task, projectIds: [], harness: "codex",
      onDispatched: () => prepared, pollMs: 1 });
    await prepare(owner);
    const registration = await owner.registration({} as never, "run");
    const process = owner.launcher(launchSpec());
    registration.activate();
    process.child.kill(); await registration.release(); finish();
    await expect(process.completion).resolves.toMatchObject({ code: 1 });
    await expect(registration.ready()).rejects.toThrow("cancelled");
    expect(task.mock.calls.some(([op]) => op.kind === "submit")).toBe(false);
  });

  it("does not connect a released or aborted startup to the PRP authority", async () => {
    const { task } = provider();
    ingress.connect.mockClear();
    const controller = new AbortController(); controller.abort();
    const owner = createPluginRunnerTaskOwner({ projectAuthCheckVersion: 1, task, projectIds: [], harness: "codex",
       pollMs: 1 });
    await prepare(owner);
    const registration = await owner.registration({} as never, "run", controller.signal);
    const process = owner.launcher(launchSpec());
    try {
      registration.activate();
      await expect(registration.ready()).rejects.toThrow("cancelled");
      expect(task.mock.calls.filter(([operation]) => operation.kind === "connection")).toHaveLength(0);
      expect(ingress.connect).not.toHaveBeenCalled();
      await registration.release(); await registration.checkpoint("settled"); await process.completion;
    } finally { process.child.kill(); await process.completion.catch(() => {}); }
  });
});


describe("plugin task workspace file transfer", () => {
  it("reads only a submitted task, validates bytes, and rejects late responses after release", async () => {
    const {task}=provider(); const perform=task.getMockImplementation()!;
    const bytes=Buffer.from("VM proof\n");
    let file={kind:"file",taskId:"task",base64:bytes.toString("base64"),byteSize:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
    let afterRead=async()=>{};
    task.mockImplementation(async op=>{if(op.kind==="read_file"){await afterRead();return file;}return perform(op);});
    const owner=createPluginRunnerTaskOwner({projectAuthCheckVersion:1,task,projectIds:[],harness:"codex",pollMs:1});
    await expect(owner.readWorkspaceFile("proof.txt",1024)).rejects.toThrow("unavailable");
    await prepare(owner);
    ingress.connect.mockReturnValue({ready:Promise.resolve(),close:async()=>{}});
    const registration=await owner.registration({} as never,"run");
    const handle=owner.launcher(launchSpec());registration.activate();await registration.ready();
    try {
      await expect(owner.readWorkspaceFile("proof.txt",1024)).resolves.toEqual(bytes);
      await expect(owner.readWorkspaceFile("/home/agent/proof.txt",1024)).resolves.toEqual(bytes);
      expect(task.mock.calls.find(([op])=>op.kind==="read_file")?.[0]).toMatchObject({identity:requirements.identity,path:"proof.txt",projectIds:[]});
      for(const path of ["../escape","//etc/passwd","file:/secret","a/../b","a\\b"]) await expect(owner.readWorkspaceFile(path,1024)).rejects.toThrow();
      await expect(owner.readWorkspaceFile("proof.txt",1)).rejects.toThrow("unavailable");
      file={...file,sha256:"f".repeat(64)};
      await expect(owner.readWorkspaceFile("proof.txt",1024)).rejects.toThrow("integrity");
      afterRead=()=>registration.release();
      await expect(owner.readWorkspaceFile("proof.txt",1024)).rejects.toThrow("unavailable");
    } finally {await registration.release();await registration.checkpoint("unsettled");await handle.completion;}
  });
});

it.each(["codex", "claude"])("reuses a warm %s process across run authorities without idle status polling", async harness => {
  const {task} = provider();
  ingress.connect.mockReturnValue({ready:Promise.resolve(),close:async()=>{}});
  const retained = vi.fn(async()=>{});
  const input = {task,projectIds:[],harness,projectAuthCheckVersion:1 as const,warmTaskVersion:1 as const,
    accountIdentity:"account",credentialIdentity:"revision",pollMs:1,onSessionRetained:retained};
  const owner = createPluginRunnerTaskOwner(input);
  await prepare(owner, launchRequirements(harness));
  const registration = await owner.registration({} as never,"run");
  const spec = launchSpec(); spec.nativeRunner!.lifecyclePolicy = {mode:"warm",idleTimeoutMs:300000};
  const handle = owner.launcher(spec); registration.activate(); await registration.ready();
  const observed = task.mock.calls.length;
  await new Promise(resolve=>setTimeout(resolve,10));
  expect(task.mock.calls).toHaveLength(observed);
  const originalTask=task.getMockImplementation()!;
  const nextTask=vi.fn(async op=>{
    const result=await originalTask(op) as Record<string,unknown>;
    return op.kind === "prepare" ? {...result,projectAuthCheckAtSubmit:true} : result;
  });
  owner.rebind({...input,task:nextTask});
  const nextRegistration=await owner.registration({} as never,"next-run");
  const nextIdentity={...requirements.identity,runId:"next-run",turnId:"next-turn",itemId:"next-item"};
  await owner.driver.prepareLaunch!({...launchRequirements(harness),identity:nextIdentity});
  expect(nextTask.mock.calls[0][0]).toMatchObject({kind:"prepare",priorIdentity:requirements.identity,accountIdentity:"account"});
  expect(nextTask.mock.calls.map(([op])=>op.kind)).toEqual(["prepare","check_project_auth"]);
  await registration.release(); nextRegistration.activate(); await nextRegistration.ready();
  expect(nextTask.mock.calls.some(([op])=>op.kind==="submit" || op.kind==="stop" || op.kind==="complete")).toBe(false);
  await nextRegistration.release(); await nextRegistration.checkpoint("settled"); await handle.completion;
  expect(retained).toHaveBeenCalledWith(expect.objectContaining(nextIdentity));
  expect(nextTask.mock.calls.filter(([op])=>op.kind==="stop")).toHaveLength(1);
});

it.each(["codex", "claude"])("adopts a verified retained %s task without submitting a replacement", async harness => {
  const {task}=provider();
  ingress.connect.mockReturnValue({ready:Promise.resolve(),close:async()=>{}});
  const owner=createPluginRunnerTaskOwner({task,projectIds:[],harness,projectAuthCheckVersion:1,
    warmTaskVersion:1,accountIdentity:"account",adoptIdentity:requirements.identity,pollMs:1});
  const recovered = {configurationId:"saved",requirementsDigest:`sha256:${"a".repeat(64)}`,provider:{}};
  await expect(owner.driver.prepareLaunch!(launchRequirements(harness),recovered)).resolves.toEqual(recovered);
  expect(task.mock.calls.map(([op])=>op.kind)).toEqual(["check_project_auth"]);
  expect(task.mock.calls[0][0]).toMatchObject({configurationId:"saved",projectIds:[]});
  expect(await owner.driver.adoptExistingRunner!.isAlive()).toBe(true);
  const registration=await owner.registration({} as never,"run");
  registration.activate(); await registration.ready();
  await registration.release(); await registration.checkpoint("settled");
  expect(task.mock.calls.some(([op])=>op.kind==="submit")).toBe(false);
  expect(task.mock.calls.some(([op])=>op.kind==="complete")).toBe(true);
});

it.each(["codex", "claude"])("denies retained %s process adoption when current project authentication is revoked",async harness=>{
  const {task}=provider();
  task.mockImplementation(async op=>op.kind === "check_project_auth"
    ? {kind:"project_auth",taskId:"task",configurationId:op.configurationId,provider:op.provider,allowed:false} as never
    : {kind:"accepted",taskId:"task"} as never);
  const owner=createPluginRunnerTaskOwner({task,projectIds:["project"],harness,projectAuthCheckVersion:1,
    warmTaskVersion:1,accountIdentity:"account",adoptIdentity:requirements.identity});
  await expect(owner.driver.prepareLaunch!(launchRequirements(harness),{configurationId:"saved",requirementsDigest:`sha256:${"a".repeat(64)}`,provider:{}}))
    .rejects.toThrow("project authentication conflicts");
  expect(task.mock.calls.map(([op])=>op.kind)).toEqual(["check_project_auth"]);
});

it.each(["codex", "claude"])("refuses warm %s account, harness, project, or credential generation changes", async harness=>{
  const {task}=provider();
  const input={task,projectIds:[],harness,projectAuthCheckVersion:1 as const,warmTaskVersion:1 as const,
    accountIdentity:"account",credentialIdentity:"revision",pollMs:1};
  const owner=createPluginRunnerTaskOwner(input);
  await prepare(owner, launchRequirements(harness));
  const spec=launchSpec();spec.nativeRunner!.lifecyclePolicy={mode:"warm",idleTimeoutMs:300000};
  const process=owner.launcher(spec);
  expect(()=>owner.rebind({...input,accountIdentity:"other"})).toThrow("cannot be rebound");
  expect(()=>owner.rebind({...input,credentialIdentity:"rotated"})).toThrow("cannot be rebound");
  expect(()=>owner.rebind({...input,harness:harness === "codex" ? "claude" : "codex"})).toThrow("cannot be rebound");
  expect(()=>owner.rebind({...input,projectIds:["foreign"]})).toThrow("cannot be rebound");
  const registration=await owner.registration({} as never,"run");
  await registration.checkpoint("unsettled"); await process.completion;
});
