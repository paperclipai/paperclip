import { createServer as createNetServer } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { createCapabilityRunnerdCodexTransport } from "../live/runnerd-codex-transport.js";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import { createCodexTaskEnvelope } from "../contracts/codex.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import {
  acpxRecoveryBinary,
  acpxRecoveryExpectedRunnerDigest,
  acpxRecoveryExpectedRunnerVersion,
  acpxRecoveryIdentity,
  createAcpxRecoveryFixture,
  ensureAcpxRecoveryRunnerBuilt,
} from "./acpx-controller-recovery.harness.js";

const binary = acpxRecoveryBinary;
const identity = acpxRecoveryIdentity;
const expectedRunnerVersion = acpxRecoveryExpectedRunnerVersion;
const fixture = createAcpxRecoveryFixture;
let expectedRunnerDigest: string;

beforeAll(() => {
  expectedRunnerDigest = ensureAcpxRecoveryRunnerBuilt();
}, 150_000);

it("keeps the original native ACPX process and active turn through controller replacement",async()=>{
  const run=await fixture();
  try{
    await run.ready();
    expect(await run.command("turn.start",{turnId:"provider-turn-1",text:"Keep working"})).toMatchObject({status:"completed"});
    const pid=run.launches()[0].pid;
    await run.stopController();
    writeFileSync(resolve(run.root,"action"),"progress");
    await vi.waitFor(()=>expect(readFileSync(resolve(run.root,"progress-receipt"),"utf8")).toBe(String(pid)),{timeout:3000});
    expect(()=>process.kill(pid,0)).not.toThrow();
    await run.replaceController();
    const result=await run.command("session.snapshot",{includePendingRuntimeRequests:true});
    expect(result).toMatchObject({status:"completed",result:{result:{runtimeRequestsLive:true,activeProviderTurnId:"provider-turn-1"}}});
    expect(run.launches()).toHaveLength(1);
    expect(()=>process.kill(pid,0)).not.toThrow();
    writeFileSync(resolve(run.root,"action"),"complete");
    await vi.waitFor(()=>expect(run.controller().store.state.committedEvents.some(event=>event.eventType==="turn.completed")).toBe(true),{timeout:5000});
  }finally{await run.cleanup();}
},60000);

it("adopts the live ACPX execution through the production native transport",async()=>{
  const run=await fixture();
  let adopted:ReturnType<typeof createCapabilityRunnerdCodexTransport>|undefined;
  try{
    await run.ready();
    expect(await run.command("turn.start",{turnId:"provider-turn-1",text:"Retain this exact execution"})).toMatchObject({status:"completed"});
    const pid=run.launches()[0].pid;
    await run.stopController();run.restoreCheckpoint();
    const launcher=vi.fn(()=>{throw new Error("duplicate runner launch");});
    const options:Parameters<typeof createCapabilityRunnerdCodexTransport>[0]={
      provider:"acpx",acpxAgent:"claude",stateDirectory:run.root,
      runnerBinary:binary,runnerArtifact:{version:expectedRunnerVersion,digest:expectedRunnerDigest ?? acpxRecoveryExpectedRunnerDigest()},prpIdentity:identity,
      resumeProviderSession:{driverSessionId:"record-1",providerSessionId:"agent-1"},
      runnerProcessLauncher:launcher,controlPlaneRegistration:run.adoptController,
      runnerReconnectGraceMs:10000,
      adoptExistingRunner:{pid:run.child.pid!,processGroupId:run.child.pid!,startedAt:run.startedAt,
        isAlive:()=>{try{process.kill(run.child.pid!,0);return true;}catch{return false;}},
        signal:signal=>{try{process.kill(-run.child.pid!,signal);return true;}catch{return false;}}},
    };
    adopted=createCapabilityRunnerdCodexTransport(options);
    adopted.transport.setServerRequestHandler(async()=>({success:true,contentItems:[]}));
    expect(await adopted.transport.request("thread/read",{})).toMatchObject({thread:{id:"record-1",sessionId:"agent-1",turns:[{id:"provider-turn-1",status:"inProgress"}]}});
    expect(adopted.evidence().runnerPid).toBe(run.child.pid);
    expect(run.launches()).toHaveLength(1);
    expect(()=>process.kill(pid,0)).not.toThrow();
    expect(launcher).not.toHaveBeenCalled();
    await adopted.detachControllerForRestart();
    await adopted.transport.close("old controller finalizer");
    expect(()=>process.kill(pid,0)).not.toThrow();
    adopted=createCapabilityRunnerdCodexTransport(options);
    adopted.transport.setServerRequestHandler(async()=>({success:true,contentItems:[]}));
    expect(await adopted.transport.request("thread/read",{})).toMatchObject({thread:{id:"record-1",sessionId:"agent-1",turns:[{id:"provider-turn-1",status:"inProgress"}]}});
    expect(adopted.evidence().runnerPid).toBe(run.child.pid);
    expect(run.launches()).toHaveLength(1);
    expect(launcher).not.toHaveBeenCalled();
  }finally{
    await adopted?.transport.close().catch(()=>undefined);
    await run.cleanup();
  }
},60000);

it.each(["running","finished"] as const)("adopts the %s turn the runner accepted for a controller that died before checkpointing it (RC-59)",async(phase)=>{
  const run=await fixture();
  let adopted:ReturnType<typeof createCapabilityRunnerdCodexTransport>|undefined;
  try{
    await run.ready();
    // The dying controller sends turn.start and dies before the provider
    // accepts it. The runner accepts and starts the turn while no controller
    // is attached, so the replacement receives the result and the start.
    writeFileSync(resolve(run.root,"hold-turn-start"),"1");
    run.controller().queueCommand("turn.start",{turnId:"provider-turn-1",text:"Continue the follow-up"},"command-dying-turn",true);
    await vi.waitFor(()=>expect(readFileSync(resolve(run.root,"commands.jsonl"),"utf8")).toContain("turn.start"),{timeout:5000});
    await run.stopController();run.restoreCheckpoint();
    writeFileSync(resolve(run.root,"release-turn-start"),"1");
    await vi.waitFor(()=>expect(existsSync(resolve(run.root,"turn-start-receipt"))).toBe(true),{timeout:5000});
    if(phase==="finished"){
      // The provider also finishes the turn before any controller returns.
      writeFileSync(resolve(run.root,"action"),"complete");
      await vi.waitFor(()=>expect(existsSync(resolve(run.root,"complete-receipt"))).toBe(true),{timeout:5000});
    }
    const options:Parameters<typeof createCapabilityRunnerdCodexTransport>[0]={
      provider:"acpx",acpxAgent:"claude",stateDirectory:run.root,
      runnerBinary:binary,runnerArtifact:{version:expectedRunnerVersion,digest:expectedRunnerDigest ?? acpxRecoveryExpectedRunnerDigest()},prpIdentity:identity,
      resumeProviderSession:{driverSessionId:"record-1",providerSessionId:"agent-1"},
      runnerProcessLauncher:()=>{throw new Error("duplicate runner launch");},controlPlaneRegistration:run.adoptController,
      runnerReconnectGraceMs:10000,environment:{PAPERCLIP_WORKSPACE_CWD:run.root},
      adoptExistingRunner:{pid:run.child.pid!,processGroupId:run.child.pid!,startedAt:run.startedAt,
        isAlive:()=>{try{process.kill(run.child.pid!,0);return true;}catch{return false;}},
        signal:signal=>{try{process.kill(-run.child.pid!,signal);return true;}catch{return false;}}},
    };
    adopted=createCapabilityRunnerdCodexTransport(options);
    expect(adopted.transport.controllerAcceptedTurnId?.()).toBeNull();
    const driver=new CodexAppServerDriver({conversationMode:"direct",
      taskEnvelope:createCodexTaskEnvelope({objective:"Complete the fixture turn",contractRevision:"fixture",criteria:[]}),
      transportFactory:()=>adopted!.transport,workingDirectoryAuthority:"remote_runner",environment:{PAPERCLIP_WORKSPACE_CWD:run.root},
      capabilities:{goals:false,threadLineage:false},driverIdentity:{kind:"acpx_runtime",displayName:"Claude via ACPX",version:"fixture"}});
    const recovery=await driver.recoverSession({driverKind:"acpx_runtime",driverSessionId:"record-1",providerSessionId:"agent-1",
      runId:identity.runId,normalizedSessionId:identity.normalizedSessionId,activeTurnId:null});
    expect(recovery.recovered,recovery.reason).toBe(true);
    const session=recovery.session!;
    expect(adopted.transport.controllerAcceptedTurnId?.()).toBe("provider-turn-1");
    if(phase==="running"){
      expect((await session.snapshot()).activeTurnId).toBe("provider-turn-1");
      writeFileSync(resolve(run.root,"action"),"complete");
    }
    const events:PrpEvent[]=[];
    for await(const event of session.events()){
      events.push(event);
      if(event.eventType.startsWith("turn.")&&!["turn.accepted","turn.started"].includes(event.eventType))break;
    }
    expect(events.filter(event=>event.eventType.startsWith("turn.")).map(event=>[event.eventType,event.turnId])).toEqual([
      ["turn.accepted","provider-turn-1"],["turn.started","provider-turn-1"],["turn.completed","provider-turn-1"]]);
    expect(events.some(event=>event.eventType==="session.failed")).toBe(false);
    // Neither the turn's replayed notifications nor its terminal fail the session afterwards.
    await new Promise(settle=>setTimeout(settle,500));
    const settled=await session.snapshot();
    expect(settled.terminalTurns?.map(turn=>turn.turnId)).toEqual(["provider-turn-1"]);
    expect(settled.activeTurnId??null).toBeNull();
    // The session passed protocol validation, so the next turn reaches the
    // Runner. (The scripted sidecar has no second-turn suspension support.)
    const next=await session.startTurn({message:{role:"user",text:"Next turn"}}).then(()=>null,(error:unknown)=>String(error));
    expect(next??"").not.toMatch(/unexpected turn|turn_binding_mismatch|session cannot start/);
    expect(run.launches()).toHaveLength(1);
    expect(readFileSync(resolve(run.root,"commands.jsonl"),"utf8").split("\n").filter(command=>command==="turn.start")).toHaveLength(1);
  }finally{
    await adopted?.transport.close().catch(()=>undefined);
    await run.cleanup();
  }
},60000);

it.each(["legacy", "stale"])("reconnects before requesting a %s sidecar terminal goal",async(mode)=>{
  const run=await fixture();
  try{
    await run.ready();
    expect(await run.command("turn.start",{turnId:"provider-turn-1",text:"Finish while disconnected"})).toMatchObject({status:"completed"});
    const pid=run.launches()[0].pid;
    const port=Number(new URL(run.controller().connectUrl).port);
    await run.stopController();
    writeFileSync(resolve(run.root,"hold-goal"),"1");
    if(mode==="stale") writeFileSync(resolve(run.root,"stale-goal"),"1");
    writeFileSync(resolve(run.root,"action"),"complete");
    await vi.waitFor(()=>expect(readFileSync(resolve(run.root,"complete-receipt"),"utf8")).toBe(String(pid)),{timeout:3000});
    // Observe two actual dial attempts after the terminal arrived, including a backoff cycle.
    let attempts=0;
    const probe=createNetServer(socket=>{attempts++;socket.destroy();});
    await new Promise<void>((ready,reject)=>{probe.once("error",reject);probe.listen(port,"127.0.0.1",ready);});
    try {
      await vi.waitFor(()=>expect(attempts).toBeGreaterThanOrEqual(2),{timeout:5000});
      expect(readFileSync(resolve(run.root,"commands.jsonl"),"utf8").split("\n").filter(command=>command==="session.goal.get")).toHaveLength(1);
    } finally {
      await new Promise<void>(done=>probe.close(()=>done()));
    }
    await run.replaceController();
    // The legacy terminal needs a fresh goal. Holding its reply must not hold off authentication.
    await vi.waitFor(()=>expect(run.controller().store.state.connectionCount).toBeGreaterThan(1),{timeout:5000});
    writeFileSync(resolve(run.root,"release-goal"),"1");
    await vi.waitFor(()=>expect(run.controller().store.state.committedEvents.some(event=>event.eventType==="turn.completed")).toBe(true),{timeout:5000});
    expect(await run.command("session.snapshot",{includePendingRuntimeRequests:true})).toMatchObject({status:"completed",result:{result:{runtimeRequestsLive:true,activeProviderTurnId:null}}});
    expect(run.launches()).toHaveLength(1);
    expect(()=>process.kill(pid,0)).not.toThrow();
  }finally{await run.cleanup();}
},60000);

it("durably drains noisy active output and one offline terminal before its controller returns", async () => {
  const run = await fixture(undefined, undefined, 0, 60_000);
  const runnerState = () => JSON.parse(readFileSync(resolve(run.root, "runner/runner-state.json"), "utf8"));
  try {
    await run.ready();
    expect(await run.command("turn.start", { turnId: "provider-turn-1", text: "Finish the admitted work offline" })).toMatchObject({ status: "completed" });
    const pid = run.launches()[0].pid;
    await run.stopController();
    writeFileSync(resolve(run.root, "offline-action"), "burst");
    await vi.waitFor(() => expect(runnerState().outbox.some((event: any) => event.envelope.payload.payload.text?.startsWith("offline-287:"))).toBe(true), { timeout: 20_000 });
    writeFileSync(resolve(run.root, "action"), "complete");
    await vi.waitFor(() => expect(runnerState().outbox.filter((event: any) => event.eventType === "turn.completed")).toHaveLength(1), { timeout: 5000 });
    const offline = runnerState();
    expect(offline.peakOutboxBytes).toBeLessThanOrEqual(offline.maxOutboxBytes);
    expect(() => process.kill(pid, 0)).not.toThrow();
    await run.replaceController();
    await vi.waitFor(() => expect(run.controller().store.state.committedEvents.some(event => event.sourceSeq === offline.nextSourceSeq - 1)).toBe(true), { timeout: 10_000 });
    const replay = new Map(run.controller().store.state.committedEvents.map(event => [event.sourceSeq, event.sourceEventId]));
    for (const event of offline.outbox) expect(replay.get(event.sourceSeq)).toBe(event.envelope.payload.sourceEventId);
    expect(run.controller().store.state.committedEvents.filter(event => event.eventType === "turn.completed")).toHaveLength(1);
    expect(run.launches()).toHaveLength(1);
    expect(readFileSync(resolve(run.root, "commands.jsonl"), "utf8").split("\n").filter(command => command === "turn.start")).toHaveLength(1);
  } finally { await run.cleanup(); }
}, 90_000);

it("remains silent at an offline approval and resolves the original request exactly once after adoption", async () => {
  const run = await fixture();
  const runnerState = () => JSON.parse(readFileSync(resolve(run.root, "runner/runner-state.json"), "utf8"));
  try {
    await run.ready();
    expect(await run.command("turn.start", { turnId: "provider-turn-1", text: "Wait for approval" })).toMatchObject({ status: "completed" });
    await run.stopController();
    writeFileSync(resolve(run.root, "offline-action"), "approval");
    await vi.waitFor(() => expect(runnerState().outbox.some((event: any) => event.eventType === "runtime_request.created")).toBe(true), { timeout: 5000 });
    const waiting = runnerState();
    await new Promise(resolveSilence => setTimeout(resolveSilence, 250));
    expect(runnerState().nextSourceSeq).toBe(waiting.nextSourceSeq);
    expect(existsSync(resolve(run.root, "approval-effects"))).toBe(false);
    await run.replaceController();
    const snapshot = await run.command("session.snapshot", { includePendingRuntimeRequests: true });
    expect(snapshot).toMatchObject({ status: "completed", result: { result: {
      activeProviderTurnId: "provider-turn-1", runtimeRequestsLive: true,
      pendingRuntimeRequests: [{ requestId: "permission-1", type: "permission", status: "pending" }],
    } } });
    expect(existsSync(resolve(run.root, "approval-effects"))).toBe(false);
    const resolution = await run.command("request.resolve", { requestId: "permission-1", resolution: { action: "accept" } });
    expect(resolution).toMatchObject({ status: "completed" });
    expect(await run.command("request.resolve", { requestId: "permission-1", resolution: { action: "accept" } })).toMatchObject({ status: "failed" });
    expect(readFileSync(resolve(run.root, "approval-effects"), "utf8")).toBe("approved\n");
    writeFileSync(resolve(run.root, "action"), "complete");
    await vi.waitFor(() => expect(run.controller().store.state.committedEvents.filter(event => event.eventType === "turn.completed")).toHaveLength(1), { timeout: 5000 });
    expect(run.launches()).toHaveLength(1);
  } finally { await run.cleanup(); }
}, 60_000);

it("distinguishes a provider-process crash from controller replacement",async()=>{
  const run=await fixture();
  try{
    await run.ready();
    expect(await run.command("turn.start",{turnId:"provider-turn-1",text:"Keep working"})).toMatchObject({status:"completed"});
    const pid=run.launches()[0].pid;
    await run.stopController();
    writeFileSync(resolve(run.root,"action"),"exit");
    await vi.waitFor(()=>expect(readFileSync(resolve(run.root,"exit-receipt"),"utf8")).toBe(String(pid)),{timeout:3000});
    await vi.waitFor(async()=>{
      for(const port of run.launches()[0].ports.slice(0,2)) await new Promise<void>((resolveFree,reject)=>{
        const probe=createNetServer();probe.once("error",reject);
        probe.listen(port,"127.0.0.1",()=>probe.close(error=>error?reject(error):resolveFree()));
      });
    },{timeout:3000});
    await vi.waitFor(() => {
      const saved = JSON.parse(readFileSync(resolve(run.root, "runner/runner-state.json"), "utf8"));
      expect(saved.outbox.filter((event: any) => event.eventType === "turn.failed")).toHaveLength(1);
    }, { timeout: 5000 });
    await run.replaceController();
    const result=await run.command("session.snapshot",{includePendingRuntimeRequests:true});
    expect(result,JSON.stringify(result)).toMatchObject({status:"failed",result:{result:{
      code:"command_execution_failed", message:"ACPX request snapshot requires the surviving provider",
    }}});
    await vi.waitFor(() => expect(run.controller().store.state.committedEvents.filter(event => event.eventType === "turn.failed")).toHaveLength(1), { timeout: 5000 });
    await vi.waitFor(() => expect(run.controller().store.state.committedEvents.find(event => event.eventType === "run.terminal")?.envelope).toMatchObject({ payload: { payload: { reportedWorkDisposition: "needs_review" } } }), { timeout: 5000 });
    expect(run.launches()).toHaveLength(1);
  }finally{await run.cleanup();}
},60000);

it("requires a surviving provider when requesting a live snapshot after explicit close",async()=>{
  const run=await fixture();
  try{
    await run.ready();
    expect(await run.command("session.close")).toMatchObject({status:"completed"});
    expect(run.child.exitCode).toBeNull();
    await run.stopController();
    await run.replaceController();
    const result=await run.command("session.snapshot",{includePendingRuntimeRequests:true});
    expect(result).toMatchObject({status:"failed",result:{result:{message:"ACPX request snapshot requires the surviving provider"}}});
    expect(run.launches()).toHaveLength(1);
  }finally{await run.cleanup();}
},60000);

it("names a refused reload of the saved conversation after provider death so the server replaces it",async()=>{
  const run=await fixture();
  try{
    await run.ready();
    // The Runner and its provider die together. The replacement Runner
    // reloads the saved conversation in a new provider process, and the
    // sidecar refuses that reload by name.
    writeFileSync(resolve(run.root,"reload-refusal"),"ANTIGRAVITY_SAVED_STATE_INCOMPATIBLE");
    await run.restartRunner();
    const restored=await run.command("session.snapshot");
    expect(restored,JSON.stringify(restored)).toMatchObject({status:"failed",result:{result:{
      code:"command_execution_failed",classification:"provider_state_incompatible",
    }}});
    expect(JSON.stringify(restored)).not.toContain("native_session_interrupted");
    expect(run.launches()).toHaveLength(2);
    expect(readFileSync(resolve(run.root,"commands.jsonl"),"utf8").trim().split("\n").slice(-2)).toEqual(["initialize","session.open"]);
  }finally{await run.cleanup();}
},60000);
