import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { DurablePrpControlPlane, decodeDurablePrpCheckpoint, spawnRunner, type DurablePrpCheckpoint } from "./durable-prp-control-plane.js";
import { copyOwnedNodeRuntime } from "../test-support/owned-node-runtime.js";
import { GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION } from "../drivers/acpx/generated-sidecar-contract.js";
import type { AcpxCandidateStartupAdmission } from "../drivers/acpx/candidate-admission.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
export const acpxRecoveryBinary = process.env.PAPERCLIP_ACPX_REPRO_BINARY ?? resolve(packageRoot, "runner/target/debug/paperclip-runnerd");
export const acpxRecoveryProfiles = JSON.parse(readFileSync(process.env.PAPERCLIP_ACPX_REPRO_PROFILES ?? resolve(packageRoot, "acpx-profiles.json"), "utf8"));
const defaultProfile = acpxRecoveryProfiles.profiles.claude;
const digest = (path: string) => "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
export const acpxRecoveryIdentity = {
  runnerInstanceId: "runner-acpx-recovery",
  environmentLeaseId: "lease-acpx-recovery",
  runId: "run-1",
  normalizedSessionId: "session-1",
  turnId: "durable-turn-1",
  itemId: "item-1",
};
export const acpxRecoveryExpectedRunnerVersion = "0.3.0";
let cachedRunnerDigest: string | undefined;

export function ensureAcpxRecoveryRunnerBuilt(): string {
  if (!process.env.PAPERCLIP_ACPX_REPRO_BINARY) {
    execFileSync("cargo", ["build", "--locked", "--manifest-path", resolve(packageRoot, "runner/Cargo.toml"),
      "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd"], { timeout: 120_000, stdio: "pipe" });
  }
  cachedRunnerDigest = digest(acpxRecoveryBinary);
  return cachedRunnerDigest;
}

export function acpxRecoveryExpectedRunnerDigest(): string {
  if (!cachedRunnerDigest) {
    cachedRunnerDigest = digest(acpxRecoveryBinary);
  }
  return cachedRunnerDigest;
}

function sidecarSource(root: string, selectedProfile = defaultProfile, agent = "claude") {
  return [
    "const fs = require('node:fs'); const net = require('node:net'); const rl = require('node:readline'); const {randomInt}=require('node:crypto');",
    "const root = " + JSON.stringify(root) + ";",
    "const profileDigest = " + JSON.stringify(selectedProfile.commandDigest) + ";",
    "const protocolVersion = " + GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION + ";",
    "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
    "let identity, runId, turnId = null, sequence = 0, lastAction = '', lastOfflineAction = '', pendingPermission = false;",
    "let goalRevision=0; const goalSnapshot=()=>({schema:'paperclip.session_goal.snapshot.v1',providerRevision:++goalRevision,goal:null,workingNow:false,sessionGoals:{availability:'unsupported',actions:[],autonomousUpdates:false,persistentAcrossResume:false,maxObjectiveChars:4000,tokenBudgetControl:false,usageReporting:false}});",
    "const event = (eventType, payload) => send({protocolVersion, sequence:++sequence, eventType, runId, turnId, payload});",
    "(async () => {",
    " const lease = async () => {for(let attempt=0;attempt<64;attempt++){const s=net.createServer();try{await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(randomInt(49152,65536),'127.0.0.1',resolve);});return s;}catch(error){if(error.code!=='EADDRINUSE')throw error;}}throw new Error('No lifetime fence port available');};",
    " const fences = await Promise.all([0,0,0].map(lease));",
    " const ports = fences.map(s=>s.address().port); fences[2].close();",
    " fs.appendFileSync(root+'/launches.jsonl', JSON.stringify({pid:process.pid, ports})+'\\n');",
    " const reply = (r,result) => send({protocolVersion,id:r.id,ok:true,result});",
    " const lines=rl.createInterface({input:process.stdin}); lines.on('close',()=>process.exit(0)); lines.on('line', line => {",
    "  const r=JSON.parse(line), p=r.params || {};",
    "  fs.appendFileSync(root+'/commands.jsonl',r.command+'\\n');",
    "  if(r.command==='session.open'&&p.expectedIdentity&&fs.existsSync(root+'/reload-refusal')){send({protocolVersion,id:r.id,ok:false,error:{code:fs.readFileSync(root+'/reload-refusal','utf8'),message:'The saved conversation cannot be reloaded in this process.',retryable:false}});return;}",
    "  if(r.command==='session.open'&&fs.existsSync(root+'/startup-failure.json')){send({protocolVersion,id:r.id,ok:false,error:{code:'ACPX_SESSION_ENSURE_FAILED',message:'Internal error',retryable:false,providerFailure:JSON.parse(fs.readFileSync(root+'/startup-failure.json','utf8'))}});return;}",
    "  switch(r.command) {",
    "   case 'initialize': reply(r,{protocolVersion,sidecarPid:process.pid,profile:{agent:" + JSON.stringify(agent) + "},capabilities:{persistentSessions:true,exactModelVerification:true,permissions:'runner_policy',semanticTools:'runner_bridge',structuredInput:'paperclip.question_set.v1'}});break;",
    "   case 'session.open': identity={kind:'acpx',normalizedSessionId:p.normalizedSessionId,acpxRecordId:'record-1',backendSessionId:'backend-1',agentSessionId:'agent-1',profileDigest,workspaceDigest:'sha256:'+'2'.repeat(64),requestedModel:p.model,effectiveModel:p.model,permissionMode:p.permissionMode,mode:p.mode,piThinkingLevel:p.piThinkingLevel,claudeEffort:p.claudeEffort,grokEffort:p.grokEffort,grokDisableWebSearch:p.grokDisableWebSearch,providerLifetimeFenceCandidates:ports};reply(r,{sidecarPid:process.pid,identity,status:{},turnControls:{steering:false,queuedFollowUp:false}});break;",
    "   case 'run.attach': runId=p.runId; reply(r,{runId,catalogRevision:p.catalogRevision});break;",
    "   case 'session.goal.get': if(fs.existsSync(root+'/hold-goal')){const timer=setInterval(()=>{if(fs.existsSync(root+'/release-goal')){clearInterval(timer);reply(r,goalSnapshot());}},10);}else reply(r,goalSnapshot());break;",
    "   case 'turn.start': {const start=()=>{turnId=p.turnId;reply(r,{turnId,turnControls:{steering:false,queuedFollowUp:false}});event('runtime.event',{type:'text_delta',text:'started'});fs.writeFileSync(root+'/turn-start-receipt',String(process.pid));};if(fs.existsSync(root+'/hold-turn-start')){const timer=setInterval(()=>{if(fs.existsSync(root+'/release-turn-start')){clearInterval(timer);start();}},10);}else start();break;}",
    "   case 'session.snapshot': reply(r,{identity,runId,turnId,pendingRuntimeRequests:pendingPermission?[{requestId:'permission-1',type:'permission',turnId}]:[]});break;",
    "   case 'permission.resolve': if(!pendingPermission)throw new Error('duplicate approval effect');pendingPermission=false;fs.appendFileSync(root+'/approval-effects','approved\\n');reply(r,{resolved:true});break;",
    "   case 'turn.cancel': reply(r,{cancelled:true});event('runtime.turn_terminal',{status:'interrupted'});turnId=null;break;",
    "   case 'session.suspend': reply(r,{identity});break;",
    "   case 'session.close': reply(r,{closed:true});break;",
    "   default: reply(r,{});",
    "  }",
    " });",
    " setInterval(()=>{if(!turnId)return;let action;try{action=fs.readFileSync(root+'/action','utf8');}catch{return;}if(action===lastAction)return;lastAction=action;if(action==='progress'){event('runtime.event',{type:'text_delta',text:'work-during-outage'});fs.writeFileSync(root+'/progress-receipt',String(process.pid));}if(action==='complete'){event('runtime.turn_terminal',{status:'completed',...(fs.existsSync(root+'/stale-goal')?{goalAtTerminal:{...goalSnapshot(),providerRevision:0}}:!fs.existsSync(root+'/hold-goal')?{goalAtTerminal:goalSnapshot()}:{})});turnId=null;fs.writeFileSync(root+'/complete-receipt',String(process.pid));}if(action==='exit'){fs.writeFileSync(root+'/exit-receipt',String(process.pid));process.exit(9);}},10);",
    " setInterval(()=>{if(!turnId)return;let action;try{action=fs.readFileSync(root+'/offline-action','utf8');}catch{return;}if(action===lastOfflineAction)return;lastOfflineAction=action;if(action==='burst'){for(let i=0;i<288;i++)event('runtime.event',{type:'text_delta',text:'offline-'+i+':'+'x'.repeat(512)});}if(action==='approval'){pendingPermission=true;event('runtime.permission_requested',{requestId:'permission-1',kind:'edit',title:'Write the file?',choices:[{key:'accept',label:'Allow once'},{key:'cancel',label:'Deny'}]});}},10);",
    "})().catch(e=>{process.stderr.write(String(e));process.exit(1);});",
  ].join("\n");
}

export async function createAcpxRecoveryFixture(
  maxLifetimeMs?: number,
  candidateAdmission?: AcpxCandidateStartupAdmission,
  beforeLaunchDelayMs = 0,
  reconnectGraceMs = 15_000,
) {
  const expectedRunnerDigest = acpxRecoveryExpectedRunnerDigest();
  const root = mkdtempSync(resolve(tmpdir(), "acpx-controller-recovery-"));
  const { executable: nodeCommand } = await copyOwnedNodeRuntime(resolve(root, "node"));
  const stateDirectory = resolve(root, "control-plane");
  const script = resolve(root, "sidecar.cjs");
  const agent = candidateAdmission ? "antigravity" : "claude", selectedProfile = acpxRecoveryProfiles.profiles[agent];
  writeFileSync(script, sidecarSource(root, selectedProfile, agent), { mode: 0o700 });
  const runtime = resolve(root, "runtime");
  const descriptor = { kind: "acpx", provider: "acpx", driver: "acpx_runtime", providerVersion: acpxRecoveryProfiles.acpxVersion,
    agent, model: candidateAdmission?.model ?? "scripted-model", acpxVersion: acpxRecoveryProfiles.acpxVersion,
    agentServerPackage: selectedProfile.agentServerPackage, agentServerVersion: selectedProfile.agentServerVersion,
    agentRuntimePackage: selectedProfile.agentRuntimePackage, agentRuntimeVersion: selectedProfile.agentRuntimeVersion,
    commandDigest: selectedProfile.commandDigest, sidecarCommand: nodeCommand, sidecarArgs: [script],
    runtimeDirectory: runtime, normalizedSessionId: acpxRecoveryIdentity.normalizedSessionId, runId: acpxRecoveryIdentity.runId,
    cwd: root, instructions: "Do the supplied synthetic task.", permissionMode: "approve-reads", permissionModePinned: true,
    ...(selectedProfile.requiresProviderPolicy ? { providerPolicy: { readOnly: true } } : {}),
    runtimeContext: null };
  let checkpoint!: DurablePrpCheckpoint;
  const create = () => {
    const controller = new DurablePrpControlPlane({
      stateDirectory,
      identity: acpxRecoveryIdentity,
      expectedRunnerVersion: acpxRecoveryExpectedRunnerVersion,
      expectedRunnerDigest,
    });
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
  const args = ["--connect-url", controller.connectUrl, "--state-dir", resolve(root, "runner"),
    "--runner-id", acpxRecoveryIdentity.runnerInstanceId, "--environment-lease-id", acpxRecoveryIdentity.environmentLeaseId,
    "--run-id", acpxRecoveryIdentity.runId, "--session-id", acpxRecoveryIdentity.normalizedSessionId, "--turn-id", acpxRecoveryIdentity.turnId, "--item-id", acpxRecoveryIdentity.itemId,
    "--runner-version", acpxRecoveryExpectedRunnerVersion, "--runner-digest", expectedRunnerDigest, "--max-runtime-ms", "0",
    "--reconnect-grace-ms", String(reconnectGraceMs), "--reconnect-delay-ms", "25", "--acpx-launch-authority-digest", "sha256:" + "d".repeat(64),
    "--acpx-sidecar-command", nodeCommand, "--acpx-sidecar-command-sha256", digest(nodeCommand),
    "--acpx-sidecar-script", script, "--acpx-sidecar-script-sha256", digest(script),
    ...(candidateAdmission ? ["--acpx-candidate-admission-json", JSON.stringify(candidateAdmission)] : [])];
  const startedAt = new Date().toISOString();
  // Exercise daemon authority independently of the TypeScript TTL clamp.
  const bounded = maxLifetimeMs === undefined ? undefined : spawnRunner({
    connectUrl: controller.connectUrl, stateDirectory: resolve(root, "runner"), identity: acpxRecoveryIdentity, ticket,
    maxOutboxBytes: 16 * 1024 * 1024, p0ReserveBytes: 1024 * 1024,
    maxRuntimeMs: 0, maxLifetimeMs: deadlineAt! - Date.now(), reconnectGraceMs,
    runnerBinaryPath: acpxRecoveryBinary, runnerVersion: acpxRecoveryExpectedRunnerVersion, runnerDigest: expectedRunnerDigest,
    acpxLaunchProfile: { ...(candidateAdmission ? { candidateAdmission } : {}), authorityDigest: `sha256:${"d".repeat(64)}`, command: nodeCommand, commandSha256: digest(nodeCommand),
      sidecarScript: script, sidecarScriptSha256: digest(script) },
    environment: { PATH: process.env.PATH },
  });
  const launchRunner = (runnerTicket: string) => spawn(acpxRecoveryBinary, args, { env: { PATH: process.env.PATH, PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: runnerTicket }, stdio: ["ignore", "ignore", "pipe"], detached: true });
  let child = bounded?.child as ChildProcess | undefined ?? launchRunner(ticket);
  let exit = once(child, "exit");
  child.stderr!.on("data", bytes => { diagnostics = (diagnostics + String(bytes)).slice(-4096); });
  let commandNumber = 0;
  async function command(type: string, payload: Record<string, unknown> = {}) {
    const id = "command-" + (++commandNumber);
    controller.queueCommand(type, payload, id, true);
    try {
      await vi.waitFor(() => {
        expect(child.exitCode, "runner exit; " + diagnostics).toBeNull();
        expect(child.signalCode, "runner signal; " + diagnostics).toBeNull();
        expect(["completed", "failed"]).toContain(controller.getCommand(id)?.status);
      }, { timeout: type === "session.open" ? 35_000 : 8000 });
    } catch (error) {
      let runnerDiagnostics: unknown;
      try { runnerDiagnostics = JSON.parse(readFileSync(resolve(root, "runner/runner-state.json"), "utf8")).diagnostics?.slice(-8); } catch { /* Startup may not have created state. */ }
      throw new Error("Hermetic Runner command did not settle: " + JSON.stringify({ id, type,
        authenticatedConnections: controller.activeRunnerConnectionCount(), command: controller.getCommand(id),
        malformedFrames: controller.store.state.malformedFrames, acceptedConnections: controller.store.state.connectionCount,
        lastCommittedEvents: controller.store.state.committedEvents.slice(-4).map(event => ({ sourceSeq: event.sourceSeq, eventType: event.eventType })),
        remainingLifetimeMs: deadlineAt === undefined ? null : deadlineAt - Date.now(),
        exitCode: child.exitCode, signalCode: child.signalCode, stderr: diagnostics, runnerDiagnostics }).slice(-8192), { cause: error });
    }
    return controller.getCommand(id)!;
  }
  const ready = async () => {
    const prepared = await command("run.prepare", { provider: descriptor });
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ status: "completed" });
    const opened = await command("session.open");
    expect(opened, JSON.stringify(opened)).toMatchObject({ status: "completed" });
  };
  const stopped = async () => {
    await controller.stop(); await controller.drainPendingConnectionProcessing(); await controller.flushCheckpoint();
  };
  const restoreCheckpoint = () => {
    rmSync(stateDirectory, { recursive: true, force: true });
    decodeDurablePrpCheckpoint(checkpoint.records).restoreSessionDirectory(root);
  };
  return {
    root, child, exit, command, ready, descriptor, startedAt, deadlineAt, processGroupId: bounded?.processGroupId ?? child.pid,
    controller: () => controller,
    stopController: stopped,
    restoreCheckpoint,
    adoptController: async (next: DurablePrpControlPlane) => {
      controller = next; await controller.start(port);
      return { connectUrl: controller.connectUrl, release: () => controller.stop() };
    },
    replaceController: async () => {
      restoreCheckpoint();
      controller = create(); await controller.start(port);
    },
    launches: () => readFileSync(resolve(root, "launches.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)),
    /** Kills the Runner and every provider it launched, then starts a replacement Runner on the same state. */
    restartRunner: async () => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      await exit;
      for (const line of readFileSync(resolve(root, "launches.jsonl"), "utf8").trim().split("\n")) {
        try { process.kill((JSON.parse(line) as { pid: number }).pid, "SIGKILL"); } catch {}
      }
      const replacementTicket = controller.issueBootstrapTicket(5_000);
      await controller.flushCheckpoint();
      child = launchRunner(replacementTicket);
      exit = once(child, "exit");
      child.stderr!.on("data", bytes => { diagnostics = (diagnostics + String(bytes)).slice(-4096); });
    },
    cleanup: async () => {
      await controller.stop();
      if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
      await exit;
      try {
        for (const line of readFileSync(resolve(root, "launches.jsonl"), "utf8").trim().split("\n")) {
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
      rmSync(root, { recursive: true, force: true });
    },
  };
}
