import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, applyPendingMigrations, environmentLeases, environments, heartbeatRuns, issues, plugins, projects, sandboxCreationOperations } from "@paperclipai/db";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { recordSandboxCreationResource } from "../services/sandbox-creation-operations.js";
import { resolvePluginTaskResume } from "../services/environment-task-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const external=resolveExternalTestDatabaseUrl("PAPERCLIP_PLUGIN_WARM_TASKS_TEST_DATABASE_URL");
const support=external ? {supported:true} : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("retained Codex plugin task leases",()=>{
 let db:ReturnType<typeof createDb>,stop:()=>Promise<void>;
 beforeAll(async()=>{if(external){await applyPendingMigrations(external);db=createDb(external);stop=()=>db.$client.end({timeout:1});return;}const started=await startEmbeddedPostgresTestDatabase("plugin-warm-tasks");db=createDb(started.connectionString);stop=started.stop;});
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
  const runtime=(orphanCleanupSpoolDir?:string)=>environmentRuntimeService(db,{pluginWorkerManager:workers,orphanCleanupSpoolDir});
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

 it.each(["ownership-lost","database-error"] as const)("retains a durable operation for an unattached replacement task: %s",async mode=>{
  const f=await fixture();await f.nextRun();const next=await f.acquire();f.stopped();
  const disk=await mkdtemp(join(tmpdir(),"replacement-intent-"));
  const runtime=()=>f.runtime(disk);
  await db.execute(sql.raw(`create or replace function reject_task_replacement() returns trigger language plpgsql as $$ begin
    if new.provider_lease_id = 'task-2' then ${mode === "ownership-lost" ? "return null;" : "raise exception 'replacement write failed';"} end if; return new; end $$`));
  await db.execute(sql`create trigger reject_task_replacement before update on environment_leases for each row execute function reject_task_replacement()`);
  try {
   await expect(runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation:{kind:"describe"}})).rejects.toThrow("reconcile the same task");
  } finally { await db.execute(sql`drop trigger reject_task_replacement on environment_leases`); }
  expect(f.calls).not.toContain("environmentReleaseLease");
  const [lease]=await db.select().from(environmentLeases).where(eq(environmentLeases.id,next.lease.id));
  expect(lease.providerLeaseId).toBe(next.lease.providerLeaseId);
  const operations=await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.companyId,f.companyId));
  const pending=operations.filter(row=>row.state === "pending");
  expect(pending).toHaveLength(1);expect(pending[0].requestKey).toBe(next.lease.providerLeaseId);
  expect(pending[0].metadata.creationProviderLeaseId).toBe("task-2");expect(pending[0].config).toEqual({});
  expect(f.acquireRequests.at(-1)?.creationOperationId).toBe(pending[0].id);
  const creates=f.acquireRequests.length;
  await expect(runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation:{kind:"describe"}})).rejects.toThrow("reconcile the same task");
  expect(f.acquireRequests).toHaveLength(creates);
  await db.update(sandboxCreationOperations).set({nextAttemptAt:new Date(0)}).where(eq(sandboxCreationOperations.id,pending[0].id));
  await runtime().flushDeferredOrphanCleanups();
  const [manual]=await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.id,pending[0].id));
  expect(manual.state).toBe("needs_reconciliation");expect(manual.metadata.creationProviderLeaseId).toBe("task-2");
  await runtime().flushDeferredOrphanCleanups();expect(f.acquireRequests).toHaveLength(creates);
  expect(f.calls).not.toContain("environmentReleaseLease");
  expect(await readdir(disk)).toEqual([]);
  await rm(disk,{recursive:true,force:true});
 });

 it("retains the known replacement identity after a committed attachment response is lost",async()=>{
  const f=await fixture();await f.nextRun();const next=await f.acquire();f.stopped();
  const transaction=db.transaction.bind(db);let lost=false;
  const response=vi.spyOn(db,"transaction").mockImplementation((async(...args:any[])=>{
   const result=await (transaction as any)(...args);
   if(!lost && result?.providerLeaseId === "task-2") {lost=true;throw new Error("Attachment commit response lost");}
   return result;
  }) as typeof db.transaction);
  try {
   await expect(f.runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation:{kind:"describe"}})).rejects.toThrow("reconcile the same task");
  } finally {response.mockRestore();}
  expect(lost).toBe(true);
  const operations=await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.companyId,f.companyId));
  const replacement=operations.find(operation=>operation.requestKey === next.lease.providerLeaseId)!;
  expect(replacement).toMatchObject({state:"attached",leaseId:next.lease.id,metadata:{creationProviderLeaseId:"task-2"}});
  const identity={id:replacement.id,companyId:f.companyId,environmentId:replacement.originalEnvironmentId,providerLeaseId:"task-2"};
  await recordSandboxCreationResource(db,identity);
  await expect(recordSandboxCreationResource(db,{...identity,providerLeaseId:"different-resource"})).rejects.toThrow("identity changed");
  await expect(recordSandboxCreationResource(db,{...identity,companyId:randomUUID()})).rejects.toThrow("identity changed");
  expect((await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.id,replacement.id)))[0])
   .toMatchObject({state:"attached",metadata:{creationProviderLeaseId:"task-2"}});
  const [saved]=await db.select().from(environmentLeases).where(eq(environmentLeases.id,next.lease.id));
  expect(saved).toMatchObject({providerLeaseId:"task-2",status:"active"});
  await db.update(sandboxCreationOperations).set({nextAttemptAt:new Date(0)}).where(eq(sandboxCreationOperations.id,replacement.id));
  await f.runtime().flushDeferredOrphanCleanups();
  expect((await f.runtime().task({companyId:f.companyId,leaseId:next.lease.id,operation:{kind:"describe"}})).taskId).toBe("task-2");
  expect(f.acquireRequests).toHaveLength(2);expect(f.calls).not.toContain("environmentReleaseLease");
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
   expect(f.calls).not.toContain("environmentReleaseLease");
   const operations=await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.companyId,f.companyId));
   expect(operations.filter(row=>row.state === "pending")).toHaveLength(1);
  } else {
   const description=await replacing;
   const [saved]=await db.select().from(environmentLeases).where(eq(environmentLeases.id,next.lease.id));
   expect(saved.providerLeaseId).toBe(description.taskId);
   expect(saved.expiresAt?.toISOString() ?? null).toBe(expiry ?? null);
  }
  expect(f.acquireRequests.at(-1)?.requestedExpiresAt).toBe(deadline?.toISOString());
 });

});
