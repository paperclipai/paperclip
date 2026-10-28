import { flushDeferredEnvironmentCleanup, hasDeferredEnvironmentCleanup, registerDeferredEnvironmentCleanup, subscribeDeferredEnvironmentCleanup } from "../services/environment-cleanup-notifications.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, plugins, projects } from "@paperclipai/db";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import * as orphanCleanup from "../services/sandbox-orphan-cleanup-spool.js";
import { resolvePluginTaskResume } from "../services/environment-task-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support=await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("retained Codex plugin task leases",()=>{
 let db:ReturnType<typeof createDb>,stop:()=>Promise<void>;
 beforeAll(async()=>{const started=await startEmbeddedPostgresTestDatabase("plugin-warm-tasks");db=createDb(started.connectionString);stop=started.stop;});
 afterAll(async()=>{await stop?.();});
 async function fixture(initialProjects:string[]=[],initialExpiry?:string,deadline?:Date){
  const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),environmentId=randomUUID(),pluginId=randomUUID();
  let runId=randomUUID(),allocation=0,stopped=false,outage=false,releaseFails=false;
  const calls:string[]=[];
  let projectIds=[...initialProjects],providerExpiry=initialExpiry;
  const taskExpiries=new Map<string,string|undefined>(),acquireRequests:any[]=[];
  let resumeGate:Promise<void>|undefined,releaseResume:(()=>void)|undefined,resumes=0;
  await db.insert(companies).values({id:companyId,name:"Warm fixture",issuePrefix:`W${companyId.slice(0,7)}`});
  for(const id of initialProjects) await db.insert(projects).values({id,companyId,name:"Authorized project"});
  await db.insert(agents).values({id:agentId,companyId,name:"Codex",adapterType:"paperclip_runner"});
  await db.insert(issues).values({id:issueId,companyId,title:"Warm task",status:"in_progress",assigneeAgentId:agentId});
  await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,nativeIssueId:issueId,invocationSource:"manual",status:"running"});
  const [environment]=await db.insert(environments).values({id:environmentId,name:environmentId,driver:"plugin",status:"active",
   config:{pluginKey:pluginId,driverKey:"tasks",driverConfig:{},runnerLifecycleMode:"warm",runnerIdleTimeoutMs:300000}}).returning();
  await db.insert(plugins).values({id:pluginId,pluginKey:pluginId,packageName:"fixture-warm",version:"1.0.0",status:"ready",manifestJson:{
   capabilities:["environment.drivers.register"],environmentDrivers:[{driverKey:"tasks",supportsTasks:true,warmTaskVersion:1}],
  } as never});
  const workers={isRunning:()=>true,getWorker:()=>({supportedMethods:["environmentTask","environmentAcquireLease","environmentResumeLease","environmentReleaseLease"]}),
   call:async(_id:string,method:string,p:any)=>{
    calls.push(method==="environmentTask" ? p.operation.kind : method);
    if(method==="environmentAcquireLease") {
     const id=`task-${++allocation}`;taskExpiries.set(id,providerExpiry);acquireRequests.push(p);
     return {providerLeaseId:id,...(providerExpiry ? {expiresAt:providerExpiry}:{}),metadata:{runId:p.runId}};
    }
    if(method==="environmentResumeLease") {if(outage) throw Error("unreachable");
     if(resumeGate){if(++resumes===2)releaseResume!();await resumeGate;}return {providerLeaseId:stopped?null:p.providerLeaseId,expiresAt:taskExpiries.get(p.providerLeaseId),metadata:{runId:p.runId}};}
    if(method==="environmentReleaseLease") {if(releaseFails) throw Error("release unavailable");return {providerLeaseId:p.providerLeaseId,state:"stopped"};}
    if(p.operation.kind==="status") return {kind:"status",taskId:p.taskId,phase:stopped?"completed":"running",executionStopped:stopped,sessionStateAvailable:stopped};
    if(p.operation.kind==="read_state") return {kind:"state",taskId:p.taskId,state:{...p.operation.identity,lifecycle:"ready"}};
    if(p.operation.kind==="stop") stopped=true;
    if(p.operation.kind==="prepare") return {kind:"prepared",taskId:p.taskId,launch:{configurationId:"configuration",requirementsDigest:`sha256:${"a".repeat(64)}`,provider:{}}};
    if(p.operation.kind==="check_project_auth") return {kind:"project_auth",taskId:p.taskId,configurationId:p.operation.configurationId,provider:"openai",allowed:true};
    if(p.operation.kind==="describe") return {kind:"description",taskId:p.taskId,runner:{version:"fixture",digest:`sha256:${"a".repeat(64)}`},warmTaskVersion:1};
    return {kind:"accepted",taskId:p.taskId};
   }} as unknown as PluginWorkerManager;
  const runtime=()=>environmentRuntimeService(db,{pluginWorkerManager:workers});
  const acquire=()=>runtime().acquireRunLease({companyId,environment:environment as never,issueId,agentId,heartbeatRunId:runId,persistedExecutionWorkspace:null,adapterType:"paperclip_runner",runnerTaskProjectIds:projectIds,requestedExpiresAt:deadline});
  const first=await acquire();
  const identity={runnerInstanceId:"runner",environmentLeaseId:first.lease.id,runId,normalizedSessionId:"session",turnId:"turn",itemId:"item"};
  await runtime().task({companyId,leaseId:first.lease.id,operation:{kind:"check_project_auth",configurationId:"configuration",provider:"openai",projectIds:initialProjects}});
  await runtime().task({companyId,leaseId:first.lease.id,operation:{kind:"submit",preparedLaunchId:"configuration",projectIds:initialProjects,bootstrapTicket:"synthetic",accountIdentity:"account",
   runner:{harness:"codex",protocolMin:1,protocolMax:3,runnerId:identity.runnerInstanceId,leaseId:identity.environmentLeaseId,runId,sessionId:identity.normalizedSessionId,turnId:identity.turnId,itemId:identity.itemId},
   launch:{runnerVersion:"fixture",runnerDigest:`sha256:${"a".repeat(64)}`,maxOutboxBytes:262144,p0ReserveBytes:65536,lifecyclePolicy:{mode:"warm",idleTimeoutMs:300000}}}});
  await runtime().releaseRunLeases(runId,"released",undefined,"keep_running");
  await db.update(heartbeatRuns).set({status:"succeeded"}).where(eq(heartbeatRuns.id,runId));
  return {companyId,first,identity,calls,runtime,acquire,acquireRequests,
   setExpiry(next?:string){providerExpiry=next;},
   async nextRun(){runId=randomUUID();await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,nativeIssueId:issueId,invocationSource:"manual",status:"running"});return runId;},
   setProjects(next:string[]){projectIds=next;},stopped(){stopped=true;},failRelease(){releaseFails=true;},outage(){outage=true;},
   raceResume(){resumeGate=new Promise<void>(resolve=>{releaseResume=resolve;});}};
 }
 it("hands a retained process to a new run after controller reconstruction",async()=>{
  const f=await fixture();
  expect(f.first.lease.leasePolicy).toBe("reuse_by_environment");
  expect(f.calls).not.toContain("stop");expect(f.calls).not.toContain("environmentReleaseLease");
  const runId=await f.nextRun(),next=await f.acquire();
  expect(next.lease.providerLeaseId).toBe(f.first.lease.providerLeaseId);
  expect(next.lease.id).not.toBe(f.first.lease.id);
  const identity={...f.identity,runId,turnId:"next-turn",itemId:"next-item"};
  const operation={kind:"prepare" as const,projectIds:[],priorIdentity:f.identity,accountIdentity:"account",requirements:{
   schema:"paperclip.runner.launch-requirements.v1" as const,identity,provider:"codex" as const,model:null,instructions:"Current run",runtimeContext:null,settings:{},approvalPolicy:"never" as const,readOnly:false,preparedConversation:false,includeCollaborationModeInstructions:false}};
  await expect(f.runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation:{kind:"read_state",identity:f.identity}})).resolves.toMatchObject({kind:"state"});
  await expect(f.runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation})).resolves.toMatchObject({kind:"prepared"});
  await expect(f.runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation})).resolves.toMatchObject({kind:"prepared"});
  await expect(f.runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation:{...operation,priorIdentity:{...f.identity,itemId:"foreign"}}})).rejects.toThrow("prior identity mismatch");
  await expect(f.runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation:{kind:"read_state",identity:f.identity}})).resolves.toMatchObject({kind:"state"});
  await expect(f.runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation:{kind:"read_state",identity:{...f.identity,itemId:"foreign"}}})).rejects.toThrow("state identity mismatch");
  expect(f.calls.filter(call=>call==="submit")).toHaveLength(1);
  const [old]=await db.select().from(environmentLeases).where(eq(environmentLeases.id,f.first.lease.id));
  expect(old.status).toBe("expired");
 });
 it("keeps successful warm state readable for retirement before and after lease handoff",async()=>{
  const f=await fixture();
  const read=()=>f.runtime().task({companyId:f.companyId,leaseId:f.first.lease.id,operation:{kind:"read_state",identity:f.identity}});
  await expect(read()).resolves.toMatchObject({kind:"state"});
  await f.nextRun();await f.acquire();
  await expect(read()).resolves.toMatchObject({kind:"state"});
  const [prior]=await db.select().from(environmentLeases).where(eq(environmentLeases.id,f.first.lease.id));
  expect(prior.status).toBe("expired");
  await expect(f.runtime().task({companyId:f.companyId,leaseId:f.first.lease.id,operation:{kind:"describe"}})).rejects.toThrow("not active");
  await expect(f.runtime().task({companyId:f.companyId,leaseId:f.first.lease.id,operation:{kind:"read_state",identity:{...f.identity,itemId:"foreign"}}})).rejects.toThrow();
  expect(f.calls).not.toContain("stop");
  expect(f.calls.filter(call=>call==="submit")).toHaveLength(1);
 });
 it("resumes stopped checkpoints through a new physical task instead of reusing a tombstone",async()=>{
  const f=await fixture();f.stopped();await f.nextRun();
  const next=await f.acquire();
  expect(next.lease.providerLeaseId).not.toBe(f.first.lease.providerLeaseId);
  expect(f.calls).toContain("complete");
  await expect(resolvePluginTaskResume(db,{companyId:f.companyId,leaseId:next.lease.id,priorIdentity:f.identity})).resolves.toBe(f.first.lease.providerLeaseId);
 });
 it("does not allocate a replacement when the retained computer cannot be inspected",async()=>{
  const f=await fixture();f.outage();await f.nextRun();
  await expect(f.acquire()).rejects.toThrow("unreachable");
  expect(f.calls.filter(call=>call==="environmentAcquireLease")).toHaveLength(1);
 });
 it("atomically admits only one successor to a retained task",async()=>{
  const f=await fixture();await f.nextRun();f.raceResume();
  const results=await Promise.allSettled([f.acquire(),f.acquire()]);
  expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
  expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
  expect(f.calls.filter(call=>call==="environmentAcquireLease")).toHaveLength(1);
 });
 it("replaces a task that stops after lease handoff before preparing the next run",async()=>{
  const f=await fixture();await f.nextRun();const next=await f.acquire();f.stopped();
  const result=await f.runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation:{kind:"describe"}});
  expect(result.taskId).not.toBe(f.first.lease.providerLeaseId);
  await expect(resolvePluginTaskResume(db,{companyId:f.companyId,leaseId:next.lease.id,priorIdentity:f.identity})).resolves.toBe(f.first.lease.providerLeaseId);
 });

 it.each(["ownership-lost","database-error","cleanup-error","spool"] as const)("compensates an unowned replacement task: %s",async mode=>{
  const f=await fixture();await f.nextRun();const next=await f.acquire();f.stopped();
  if(mode==="cleanup-error" || mode==="spool") f.failRelease();
  const append=vi.fn(async()=>true);
  let delayFlush=false,flushCalls=0,releaseFlush!:()=>void;
  const flushGate=new Promise<void>(resolve=>{releaseFlush=resolve;});
  const stopGate=mode==="spool" ? registerDeferredEnvironmentCleanup(db,async()=>{
   if(delayFlush && ++flushCalls===1) await flushGate;
   return {recovered:0,pending:0};
  }) : undefined;
  const wake=vi.fn();
  const unsubscribe=subscribeDeferredEnvironmentCleanup(db,wake);
  const spool=mode==="spool" ? vi.spyOn(orphanCleanup,"createSandboxOrphanCleanupSpool").mockReturnValue({append,load:async()=>[],remove:async()=>{}}) : undefined;
  const transaction=mode==="spool" ? vi.spyOn(db,"transaction").mockRejectedValue(Error("database unavailable")) : undefined;
  const original=db.update.bind(db);
  const update=vi.spyOn(db,"update").mockImplementation(((table:any)=>{
   const query=original(table),set=query.set.bind(query);
   query.set=((values:any)=>values.providerLeaseId === "task-2"
    ? {where:()=>({returning:async()=>{if(mode!=="ownership-lost") throw Error("replacement write failed");return [];}})}
    : set(values)) as never;
   return query;
  }) as never);
  try {
   await expect(f.runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation:{kind:"describe"}}))
    .rejects.toThrow("reconcile the same task");
   if(mode==="spool") {
    expect(wake).toHaveBeenCalledOnce();
    expect(hasDeferredEnvironmentCleanup(db)).toBe(true);
    await expect(flushDeferredEnvironmentCleanup(db)).rejects.toThrow("Deferred orphan cleanup failed");
    expect(hasDeferredEnvironmentCleanup(db)).toBe(true);
   }
  } finally {update.mockRestore();transaction?.mockRestore();spool?.mockRestore();unsubscribe();}
  expect(f.calls).toContain("environmentReleaseLease");
  if(mode==="spool") expect(append).toHaveBeenCalledWith(expect.objectContaining({providerLeaseId:"task-2",metadata:expect.objectContaining({driver:"plugin",runnerTaskDispatched:false})}));
  const rows=await db.select().from(environmentLeases).where(eq(environmentLeases.companyId,f.companyId));
  expect(rows.filter(row=>row.providerLeaseId === "task-2")).toEqual(mode==="cleanup-error"
   ? [expect.objectContaining({status:"pending_cleanup",failureReason:"plugin_task_replacement_unowned",metadata:expect.objectContaining({runnerTaskDispatched:false})})] : []);
  if(mode==="spool") {
   delayFlush=true;
   const delayed=flushDeferredEnvironmentCleanup(db);
   try { expect(await flushDeferredEnvironmentCleanup(db)).toEqual({recovered:1,pending:0}); }
   finally { releaseFlush(); stopGate!(); }
   expect(await delayed).toEqual({recovered:1,pending:0});
   expect(hasDeferredEnvironmentCleanup(db)).toBe(false);
   const recovered=await db.select().from(environmentLeases).where(eq(environmentLeases.companyId,f.companyId));
   expect(recovered.filter(row=>row.providerLeaseId==="task-2")).toEqual([
    expect.objectContaining({status:"pending_cleanup",failureReason:"plugin_task_replacement_unowned"}),
   ]);
  }
 });

 it.each(["added","removed"] as const)("retires retained mounts when an authorized project is %s after controller restart",async mode=>{
  const projectId=randomUUID(),f=await fixture(mode==="removed" ? [projectId] : []);
  if(mode==="added") await db.insert(projects).values({id:projectId,companyId:f.companyId,name:"Added project"});
  f.setProjects(mode==="added" ? [projectId] : []);await f.nextRun();
  const next=await f.acquire();
  expect(next.lease.providerLeaseId).not.toBe(f.first.lease.providerLeaseId);
  expect(next.lease.metadata?.runnerTaskProjectIds).toEqual(mode==="added" ? [projectId] : []);
  expect(f.calls).toContain("stop");expect(f.calls).toContain("complete");
  expect(f.calls).not.toContain("environmentResumeLease");
  await expect(resolvePluginTaskResume(db,{companyId:f.companyId,leaseId:next.lease.id,priorIdentity:f.identity})).resolves.toBe(f.first.lease.providerLeaseId);
 });

 it.each(["later","none","bounded","violating","missing-bounded","invalid","expired"] as const)("replaces task expiry without losing caller bounds: %s",async mode=>{
  const bounded=["bounded","violating","missing-bounded"].includes(mode);
  const deadline=bounded ? new Date("2099-03-01T00:00:00.000Z") : undefined;
  const f=await fixture([],"2099-01-01T00:00:00.000Z",deadline);
  await f.nextRun();const next=await f.acquire();f.stopped();
  const expiry=mode === "invalid" ? "invalid-expiry" : mode === "expired" ? "2000-01-01T00:00:00.000Z" : mode === "none" || mode === "missing-bounded" ? undefined
   : mode === "violating" ? "2099-04-01T00:00:00.000Z" : "2099-02-01T00:00:00.000Z";
  f.setExpiry(expiry);
  const replacing=f.runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation:{kind:"describe"}});
  if(["violating","missing-bounded","invalid","expired"].includes(mode)) {
   await expect(replacing).rejects.toThrow("reconcile the same task");
   expect(f.calls).toContain("environmentReleaseLease");
  } else {
   const description=await replacing;
   const [saved]=await db.select().from(environmentLeases).where(eq(environmentLeases.id,next.lease.id));
   expect(saved.providerLeaseId).toBe(description.taskId);
   expect(saved.expiresAt?.toISOString() ?? null).toBe(expiry ?? null);
  }
  expect(f.acquireRequests.at(-1)?.requestedExpiresAt).toBe(deadline?.toISOString());
 });

});
