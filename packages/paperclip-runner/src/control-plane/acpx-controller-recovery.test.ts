import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it, vi } from "vitest";
import { DurablePrpControlPlane, decodeDurablePrpCheckpoint, spawnRunner, type DurablePrpCheckpoint } from "./durable-prp-control-plane.js";
import { copyOwnedNodeRuntime } from "../test-support/owned-node-runtime.js";
import { GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION } from "../drivers/acpx/generated-sidecar-contract.js";
import { createCapabilityRunnerdCodexTransport } from "../live/runnerd-codex-transport.js";
import { bindAcpxCandidateAdmission, type AcpxCandidateStartupAdmission } from "../drivers/acpx/candidate-admission.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "../drivers/acpx/generated-profiles.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const binary = process.env.PAPERCLIP_ACPX_REPRO_BINARY ?? resolve(packageRoot, "runner/target/debug/paperclip-runnerd");
const profiles = JSON.parse(readFileSync(process.env.PAPERCLIP_ACPX_REPRO_PROFILES ?? resolve(packageRoot, "acpx-profiles.json"), "utf8"));
const profile = profiles.profiles.claude;
const digest = (path: string) => "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
const identity = { runnerInstanceId: "runner-acpx-recovery", environmentLeaseId: "lease-acpx-recovery",
  runId: "run-1", normalizedSessionId: "session-1", turnId: "durable-turn-1", itemId: "item-1" };
const expectedRunnerVersion = "0.3.0";
let expectedRunnerDigest: string;

beforeAll(() => {
  if (!process.env.PAPERCLIP_ACPX_REPRO_BINARY) {
    execFileSync("cargo", ["build", "--locked", "--manifest-path", resolve(packageRoot, "runner/Cargo.toml"),
      "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd"], { timeout: 120_000, stdio: "pipe" });
  }
  expectedRunnerDigest = digest(binary);
}, 150_000);

function sidecarSource(root: string, selectedProfile = profile, agent = "claude") {
  return [
    "const fs = require('node:fs'); const net = require('node:net'); const rl = require('node:readline'); const {randomInt}=require('node:crypto');",
    "const root = " + JSON.stringify(root) + ";",
    "const profileDigest = " + JSON.stringify(selectedProfile.commandDigest) + ";",
    "const protocolVersion = " + GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION + ";",
    "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
    "let identity, runId, turnId = null, sequence = 0, lastAction = '';",
    "const event = (eventType, payload) => send({protocolVersion, sequence:++sequence, eventType, runId, turnId, payload});",
    "(async () => {",
    " const lease = async () => {for(let attempt=0;attempt<64;attempt++){const s=net.createServer();try{await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(randomInt(49152,65536),'127.0.0.1',resolve);});return s;}catch(error){if(error.code!=='EADDRINUSE')throw error;}}throw new Error('No lifetime fence port available');};",
    " const fences = await Promise.all([0,0,0].map(lease));",
    " const ports = fences.map(s=>s.address().port); fences[2].close();",
    " fs.appendFileSync(root+'/launches.jsonl', JSON.stringify({pid:process.pid, ports})+'\\n');",
    " const reply = (r,result) => send({protocolVersion,id:r.id,ok:true,result});",
    " const lines=rl.createInterface({input:process.stdin}); lines.on('close',()=>process.exit(0)); lines.on('line', line => {",
    "  const r=JSON.parse(line), p=r.params || {};",
    "  switch(r.command) {",
    "   case 'initialize': reply(r,{protocolVersion,sidecarPid:process.pid,profile:{agent:" + JSON.stringify(agent) + "},capabilities:{persistentSessions:true,exactModelVerification:true,permissions:'runner_policy',semanticTools:'runner_bridge',structuredInput:'paperclip.question_set.v1'}});break;",
    "   case 'session.open': identity={kind:'acpx',normalizedSessionId:p.normalizedSessionId,acpxRecordId:'record-1',backendSessionId:'backend-1',agentSessionId:'agent-1',profileDigest,workspaceDigest:'sha256:'+'2'.repeat(64),requestedModel:p.model,effectiveModel:p.model,permissionMode:p.permissionMode,mode:p.mode,piThinkingLevel:p.piThinkingLevel,claudeEffort:p.claudeEffort,grokEffort:p.grokEffort,grokDisableWebSearch:p.grokDisableWebSearch,providerLifetimeFenceCandidates:ports};reply(r,{sidecarPid:process.pid,identity,status:{},turnControls:{steering:false,queuedFollowUp:false}});break;",
    "   case 'run.attach': runId=p.runId; reply(r,{runId,catalogRevision:p.catalogRevision});break;",
    "   case 'session.goal.get': reply(r,{schema:'paperclip.session_goal.snapshot.v1',goal:null,workingNow:false,sessionGoals:{availability:'unsupported',actions:[],autonomousUpdates:false,persistentAcrossResume:false,maxObjectiveChars:4000,tokenBudgetControl:false,usageReporting:false}});break;",
    "   case 'turn.start': turnId=p.turnId;reply(r,{turnId,turnControls:{steering:false,queuedFollowUp:false}});event('runtime.event',{type:'text_delta',text:'started'});break;",
    "   case 'session.snapshot': reply(r,{identity,runId,turnId,pendingRuntimeRequests:[]});break;",
    "   case 'turn.cancel': reply(r,{cancelled:true});event('runtime.turn_terminal',{status:'interrupted'});turnId=null;break;",
    "   case 'session.suspend': reply(r,{identity});break;",
    "   case 'session.close': reply(r,{closed:true});break;",
    "   default: reply(r,{});",
    "  }",
    " });",
    " setInterval(()=>{if(!turnId)return;let action;try{action=fs.readFileSync(root+'/action','utf8');}catch{return;}if(action===lastAction)return;lastAction=action;if(action==='progress'){event('runtime.event',{type:'text_delta',text:'work-during-outage'});fs.writeFileSync(root+'/progress-receipt',String(process.pid));}if(action==='complete'){event('runtime.turn_terminal',{status:'completed'});turnId=null;fs.writeFileSync(root+'/complete-receipt',String(process.pid));}if(action==='exit'){fs.writeFileSync(root+'/exit-receipt',String(process.pid));process.exit(9);}},10);",
    "})().catch(e=>{process.stderr.write(String(e));process.exit(1);});",
  ].join("\n");
}

async function fixture(maxLifetimeMs?: number, candidateAdmission?: AcpxCandidateStartupAdmission, beforeLaunchDelayMs = 0) {
  const root = mkdtempSync(resolve(tmpdir(), "acpx-controller-recovery-"));
  const { executable: nodeCommand } = await copyOwnedNodeRuntime(resolve(root, "node"));
  const stateDirectory = resolve(root, "control-plane");
  const script = resolve(root, "sidecar.cjs");
  const agent = candidateAdmission ? "antigravity" : "claude", selectedProfile = profiles.profiles[agent];
  writeFileSync(script, sidecarSource(root, selectedProfile, agent), { mode: 0o700 });
  const runtime = resolve(root, "runtime");
  const descriptor = { kind: "acpx", provider: "acpx", driver: "acpx_runtime", providerVersion: profiles.acpxVersion,
    agent, model: candidateAdmission?.model ?? "scripted-model", acpxVersion: profiles.acpxVersion,
    agentServerPackage: selectedProfile.agentServerPackage, agentServerVersion: selectedProfile.agentServerVersion,
    agentRuntimePackage: selectedProfile.agentRuntimePackage, agentRuntimeVersion: selectedProfile.agentRuntimeVersion,
    commandDigest: selectedProfile.commandDigest, sidecarCommand: nodeCommand, sidecarArgs: [script],
    runtimeDirectory: runtime, normalizedSessionId: identity.normalizedSessionId, runId: identity.runId,
    cwd: root, instructions: "Do the supplied synthetic task.", permissionMode: "approve-reads", permissionModePinned: true,
    ...(selectedProfile.requiresProviderPolicy ? { providerPolicy: { readOnly: true } } : {}),
    runtimeContext: null };
  let checkpoint!: DurablePrpCheckpoint;
  const create = () => {
    const controller = new DurablePrpControlPlane({ stateDirectory, identity, expectedRunnerVersion, expectedRunnerDigest });
    controller.setCheckpointPersistence(async saved => { checkpoint = saved; });
    return controller;
  };
  let controller = create();
  await controller.start();
  const port = Number(new URL(controller.connectUrl).port);
  // Establish one absolute fixture grant before issuing its one-use ticket.
  // Bootstrap preparation and the actual daemon share this deadline.
  const deadlineAt = candidateAdmission?.expiresAt ?? (maxLifetimeMs === undefined ? undefined : Date.now() + maxLifetimeMs);
  const ticket = controller.issueBootstrapTicket(deadlineAt === undefined ? 5_000 : deadlineAt - Date.now());
  await controller.flushCheckpoint();
  if (beforeLaunchDelayMs) await new Promise(resolveDelay => setTimeout(resolveDelay, beforeLaunchDelayMs));
  let diagnostics = "";
  const args = ["--connect-url",controller.connectUrl,"--state-dir",resolve(root,"runner"),
    "--runner-id",identity.runnerInstanceId,"--environment-lease-id",identity.environmentLeaseId,
    "--run-id",identity.runId,"--session-id",identity.normalizedSessionId,"--turn-id",identity.turnId,"--item-id",identity.itemId,
    "--runner-version",expectedRunnerVersion,"--runner-digest",expectedRunnerDigest,"--max-runtime-ms","0",
    "--reconnect-grace-ms","15000","--reconnect-delay-ms","25","--acpx-launch-authority-digest","sha256:"+"d".repeat(64),
    "--acpx-sidecar-command",nodeCommand,"--acpx-sidecar-command-sha256",digest(nodeCommand),
    "--acpx-sidecar-script",script,"--acpx-sidecar-script-sha256",digest(script),
    ...(candidateAdmission ? ["--acpx-candidate-admission-json", JSON.stringify(candidateAdmission)] : [])];
  const startedAt = new Date().toISOString();
  // Exercise daemon authority independently of the TypeScript TTL clamp.
  const bounded = maxLifetimeMs === undefined ? undefined : spawnRunner({
    connectUrl: controller.connectUrl, stateDirectory: resolve(root, "runner"), identity, ticket,
    maxOutboxBytes: 16 * 1024 * 1024, p0ReserveBytes: 1024 * 1024,
    maxRuntimeMs: 0, maxLifetimeMs: deadlineAt! - Date.now(), reconnectGraceMs: 15_000,
    runnerBinaryPath: binary, runnerVersion: expectedRunnerVersion, runnerDigest: expectedRunnerDigest,
    acpxLaunchProfile: { ...(candidateAdmission ? { candidateAdmission } : {}), authorityDigest: `sha256:${"d".repeat(64)}`, command: nodeCommand, commandSha256: digest(nodeCommand),
      sidecarScript: script, sidecarScriptSha256: digest(script) },
    environment: { PATH: process.env.PATH },
  });
  const child = bounded?.child as ChildProcess | undefined
    ?? spawn(binary,args,{env:{PATH:process.env.PATH,PAPERCLIP_RUNNER_BOOTSTRAP_TICKET:ticket},stdio:["ignore","ignore","pipe"],detached:true});
  const exit = once(child,"exit");
  child.stderr!.on("data",bytes=>{diagnostics=(diagnostics+String(bytes)).slice(-4096);});
  let commandNumber=0;
  async function command(type:string,payload:Record<string,unknown>={}) {
    const id="command-"+(++commandNumber);
    controller.queueCommand(type,payload,id,true);
    try {
      await vi.waitFor(()=>{
        expect(child.exitCode,"runner exit; "+diagnostics).toBeNull();
        expect(child.signalCode,"runner signal; "+diagnostics).toBeNull();
        expect(["completed","failed"]).toContain(controller.getCommand(id)?.status);
      },{timeout:8000});
    } catch (error) {
      let runnerDiagnostics: unknown;
      try { runnerDiagnostics = JSON.parse(readFileSync(resolve(root, "runner/runner-state.json"), "utf8")).diagnostics?.slice(-8); } catch { /* Startup may not have created state. */ }
      throw new Error("Hermetic Runner command did not settle: " + JSON.stringify({ id, type,
        authenticatedConnections: controller.activeRunnerConnectionCount(), command: controller.getCommand(id),
        remainingLifetimeMs: deadlineAt === undefined ? null : deadlineAt - Date.now(),
        exitCode: child.exitCode, signalCode: child.signalCode, stderr: diagnostics, runnerDiagnostics }).slice(-8192), { cause: error });
    }
    return controller.getCommand(id)!;
  }
  const ready = async () => {
    const prepared = await command("run.prepare",{provider:descriptor});
    expect(prepared, JSON.stringify(prepared)).toMatchObject({status:"completed"});
    const opened = await command("session.open");
    expect(opened, JSON.stringify(opened)).toMatchObject({status:"completed"});
  };
  const stopped = async () => {
    await controller.stop(); await controller.drainPendingConnectionProcessing(); await controller.flushCheckpoint();
  };
  const restoreCheckpoint = () => {
    rmSync(stateDirectory,{recursive:true,force:true});
    decodeDurablePrpCheckpoint(checkpoint.records).restoreSessionDirectory(root);
  };
  return {root,child,exit,command,ready,startedAt,deadlineAt,processGroupId: bounded?.processGroupId ?? child.pid,
    controller:()=>controller,
    stopController:stopped,
    restoreCheckpoint,
    adoptController:async(next:DurablePrpControlPlane)=>{
      controller=next;await controller.start(port);
      return {connectUrl:controller.connectUrl,release:()=>controller.stop()};
    },
    replaceController:async()=>{
      restoreCheckpoint();
      controller=create();await controller.start(port);
    },
    launches:()=>readFileSync(resolve(root,"launches.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line)),
    cleanup:async()=>{
      await controller.stop();
      if(child.exitCode===null && child.signalCode===null){try{process.kill(-child.pid!,"SIGKILL");}catch{}}
      await exit;
      try {
        for (const line of readFileSync(resolve(root,"launches.jsonl"),"utf8").trim().split("\n")) {
          const launch = JSON.parse(line) as { pid: number; ports: number[] };
          await vi.waitFor(async () => {
            for (const port of launch.ports.slice(0, 2)) await new Promise<void>((resolveFree, reject) => {
              const probe = createNetServer();
              probe.once("error", reject);
              probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolveFree()));
            });
          }, { timeout: 3_000 });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      rmSync(root,{recursive:true,force:true});
    },
  };
}

async function assertActiveExpiry(candidate = false) {
  // One fixed grant covers the six-second cold delay, four existing eight-
  // second command budgets, and seven seconds of active-turn headroom. Loaded
  // CI exhausted the earlier fifteen-second grant before session.open settled.
  // Never renew this authority after setup or the active-turn witness.
  const lifetimeMs = 45_000;
  const candidateAdmission = candidate ? bindAcpxCandidateAdmission({ schema: "paperclip.acpx-candidate-admission.v1", companyId: "company-expiry",
    agent: "antigravity", model: "gemini-3.8-flash-low", profileDigest: profiles.profiles.antigravity.commandDigest,
    nativeClosureDigest: `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256}`,
    platform: "darwin", architecture: "arm64", expiresAt: Date.now() + lifetimeMs }, identity) : undefined;
  // A controlled cold start outlasts the default five-second bootstrap ticket.
  // It must still activate inside the original fixed absolute grant.
  const run = await fixture(candidate ? undefined : lifetimeMs, candidateAdmission, candidate ? 0 : 6_000);
  const deadlineAt = run.deadlineAt!;
  try {
    await run.ready();
    expect(await run.command("turn.start", { turnId: "provider-expiring-turn", text: "Keep this hermetic turn active" })).toMatchObject({ status: "completed" });
    const launch = run.launches()[0];
    expect(launch.pid).toBeGreaterThan(1);
    expect(() => process.kill(launch.pid, 0)).not.toThrow();
    expect(await run.command("session.snapshot")).toMatchObject({ result: { result: { activeProviderTurnId: "provider-expiring-turn" } } });
    expect(Date.now()).toBeLessThan(deadlineAt);
    // No stop/cancel request is sent. The real daemon must enforce the launch
    // deadline while the provider is active, then finish physical cleanup.
    await vi.waitFor(() => expect(run.child.exitCode ?? run.child.signalCode).not.toBeNull(), { timeout: Math.max(1, deadlineAt - Date.now()) + 4_000 });
    expect(run.child.exitCode).not.toBe(0);
    expect(() => process.kill(launch.pid, 0)).toThrow();
    expect(run.processGroupId).toBeGreaterThan(1);
    expect(() => process.kill(-run.processGroupId!, 0)).toThrow();
    const fences = await Promise.all((launch.ports as number[]).map(port => new Promise<ReturnType<typeof createNetServer>>((resolveFree, reject) => {
      const probe = createNetServer(); probe.once("error", reject); probe.listen(port, "127.0.0.1", () => resolveFree(probe));
    })));
    await Promise.all(fences.map(server => new Promise<void>((resolveFree, reject) => server.close(error => error ? reject(error) : resolveFree()))));
    const state = JSON.parse(readFileSync(resolve(run.root, "runner/runner-state.json"), "utf8"));
    expect(state.recoverableFailure).toBe("transport_reconnect_deadline_exceeded");
  } finally { await run.cleanup(); }
}

it("expires an active provider turn after a cold bootstrap delay and physically retires its owned processes", () => assertActiveExpiry(), 60_000);
it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "retires an active exact Antigravity candidate at absolute operator expiry with no caller runtime limit",
  () => assertActiveExpiry(true), 60_000);

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
},20000);

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
      runnerBinary:binary,runnerArtifact:{version:expectedRunnerVersion,digest:expectedRunnerDigest},prpIdentity:identity,
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
},25000);

it("recovers a turn that completed while its controller was offline",async()=>{
  const run=await fixture();
  try{
    await run.ready();
    expect(await run.command("turn.start",{turnId:"provider-turn-1",text:"Finish while disconnected"})).toMatchObject({status:"completed"});
    const pid=run.launches()[0].pid;
    await run.stopController();
    writeFileSync(resolve(run.root,"action"),"complete");
    await vi.waitFor(()=>expect(readFileSync(resolve(run.root,"complete-receipt"),"utf8")).toBe(String(pid)),{timeout:3000});
    await run.replaceController();
    await vi.waitFor(()=>expect(run.controller().store.state.committedEvents.some(event=>event.eventType==="turn.completed")).toBe(true),{timeout:5000});
    expect(await run.command("session.snapshot",{includePendingRuntimeRequests:true})).toMatchObject({status:"completed",result:{result:{runtimeRequestsLive:true,activeProviderTurnId:null}}});
    expect(run.launches()).toHaveLength(1);
    expect(()=>process.kill(pid,0)).not.toThrow();
  }finally{await run.cleanup();}
},20000);

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
    await run.replaceController();
    const result=await run.command("session.snapshot",{includePendingRuntimeRequests:true});
    expect(result,JSON.stringify(result)).toMatchObject({status:"failed",result:{result:{code:"command_execution_failed"}}});
    const message = (result.result as {result:{message:string}}).result.message;
    const lossReasons = [
      "ACPX request snapshot requires a live provider",
      "ACPX sidecar request transport failed at session.snapshot: command serialization failed: Broken pipe (os error 32)",
      "ACPX sidecar request transport failed at session.snapshot: failed to write process command: Broken pipe (os error 32)",
      "ACPX sidecar exited at session.snapshot: exitCode=Some(9) signal=None",
      "ACPX sidecar closed stdout at session.snapshot",
    ];
    expect(lossReasons.map(reason => `ACPX live request snapshot failed: ${reason}`)).toContain(message);
    expect(run.launches()).toHaveLength(1);
  }finally{await run.cleanup();}
},20000);

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
},20000);
