import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, companies, agents, issues, issueRecoveryActions, heartbeatRuns, agentWakeupRequests,
  approvals, issueApprovals, issueRelations, issueThreadInteractions, activityLog, issueComments, subscribeDatabaseWork, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";
import { recoveryService as baselineService } from "../services/recovery/.bench-baseline-service.js";
import { collectDispositionRepairSourceState } from "../services/recovery/disposition-repair.js";
import { collectDispositionRepairSourceState as baselineState } from "../services/recovery/.bench-baseline-disposition-repair.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";

const evidence = process.env.RECOVERY_EVIDENCE_DIR;
if (!evidence) throw new Error("Run scripts/benchmark-active-recovery-projection.mjs to select a unique evidence directory.");
describe("actual active recovery attribution", () => {
 let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
 let db: Db; let companyId: string, agentId: string;

 const notifications: unknown[]=[]; const stops:Array<()=>void>=[];
 beforeAll(async()=>{
  temporary=await startEmbeddedPostgresTestDatabase("active-recovery-projection-");
  db=createDb(temporary.connectionString,{maxConnections:6,idleTimeoutSeconds:0,maxLifetimeSeconds:0});
  db.$client.options.onnotice=()=>{};
  for(const topic of Object.values(DELIVERY_QUEUES)) stops.push(subscribeDatabaseWork(db,topic,(event,hints)=>notifications.push({topic,event,hints:[...hints??[]]})));
 },30000);
 afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();await db.execute(sql`truncate companies cascade`);});
 afterAll(async()=>{for(const stop of stops)stop();await db?.$client.end({timeout:1});await temporary?.cleanup();});
 async function seed(size:number){
  companyId=randomUUID();agentId=randomUUID();
  await db.insert(companies).values({id:companyId,name:"Projection",issuePrefix:`P${companyId.slice(0,6)}`});
  await db.insert(agents).values({id:agentId,companyId,name:"Owner",role:"engineer",status:"idle"});
  const roots=await db.insert(issues).values(Array.from({length:size},(_,i)=>({companyId,title:`source-${i}`,status:"blocked",assigneeAgentId:agentId}))).returning();
  const actions=await db.insert(issueRecoveryActions).values(roots.map((r,i)=>({companyId,sourceIssueId:r.id,kind:"deliberate_wait_without_target",ownerType:i%4===0?"agent":"board",ownerAgentId:i%4===0?agentId:null,cause:"deliberate_wait_without_target",fingerprint:`fixture-${i}`,nextAction:"Board decision",wakePolicy:{type:i%4===0?"bounded_recovery_owner":"board_escalation"}}))).returning();
  return {roots,actions};
 }
 async function snapshot(database:Db=db){return {
  actions:await database.select().from(issueRecoveryActions).orderBy(issueRecoveryActions.id),
  issues:await database.select().from(issues).orderBy(issues.id),
  wakes:await database.select().from(agentWakeupRequests).orderBy(agentWakeupRequests.id),
  activity:await database.select().from(activityLog).orderBy(activityLog.id),
  comments:await database.select().from(issueComments).orderBy(issueComments.id),
  relations:(await database.select().from(issueRelations).orderBy(issueRelations.issueId,issueRelations.relatedIssueId)).map(({id,createdAt,updatedAt,...edge})=>edge),
 };}
 async function emptyCohort(size:number,includeTiming:boolean){
  const {roots,actions}=await seed(size);
  const foreign=randomUUID();await db.insert(companies).values({id:foreign,name:"Foreign",issuePrefix:`F${foreign.slice(0,6)}`});
  const [foreignIssue]=await db.insert(issues).values({companyId:foreign,title:"foreign",status:"blocked"}).returning();
  await db.insert(issueRecoveryActions).values({companyId:foreign,sourceIssueId:foreignIssue.id,kind:"deliberate_wait_without_target",ownerType:"board",cause:"deliberate_wait_without_target",fingerprint:"foreign",nextAction:"Decide"});
  const before=await snapshot();notifications.length=0;
  const enqueueWakeup=async()=>{throw new Error("Unexpected enqueue");};
  const services={baseline:baselineService(db,{enqueueWakeup}),treatment:recoveryService(db,{enqueueWakeup})};
  const counts:Record<string,unknown>={};
  for(const [arm,factory]of Object.entries({baseline:baselineService,treatment:recoveryService})){
   const countDb=createDb(temporary.connectionString,{maxConnections:6,idleTimeoutSeconds:0,maxLifetimeSeconds:0});
   await Promise.all(Array.from({length:6},()=>countDb.execute(sql`select pg_sleep(0.01)`)));
   const statements:string[]=[];let rows=0;
   countDb.$client.options.debug=(_c,q)=>statements.push(q);
   countDb.$client.options.transform.row.from=(row:any)=>{rows++;return row;};
   try{const result=await factory(countDb,{enqueueWakeup}).reconcileActiveRecoveryActions({companyId});counts[arm]={queries:statements.length,rows,sql:statements,result};}
   finally{await countDb.$client.end({timeout:1});}
  }
  // CPU client has no debug or row-transform observer installed.
  expect(db.$client.options.debug).toBe(false);
  expect(db.$client.options.transform.row.from).toBeUndefined();
  const samples=[];let exact:any=(counts.baseline as any).result;
  expect((counts.treatment as any).result).toEqual(exact);
  expect(exact).toEqual({requeued:0,escalated:0,resolved:0,skipped:actions.filter(a=>a.ownerType==="agent").length,issueIds:[]});
  for(let round=0;round<(includeTiming?12:0);round++){
   for(const arm of (round%2?["treatment","baseline"]:["baseline","treatment"])as Array<keyof typeof services>){
    const cpu=process.cpuUsage(),start=performance.now();
    const result=await services[arm].reconcileActiveRecoveryActions({companyId});
    const wallMs=performance.now()-start,used=process.cpuUsage(cpu);
    if(exact)expect(result).toEqual(exact);else exact=result;
    expect(result).toEqual({requeued:0,escalated:0,resolved:0,skipped:actions.filter(a=>a.ownerType==="agent").length,issueIds:[]});
    if(round>=3)samples.push({round,arm,cpuMs:(used.user+used.system)/1000,wallMs});
   }
  }
  expect(await snapshot()).toEqual(before);expect(notifications).toEqual([]);
  writeFileSync(`${evidence}/${includeTiming ? "paired" : "proof"}-${size}.json`,JSON.stringify({size,node:process.version,samples,counts,exact,before,after:await snapshot(),notifications},null,2),{flag:"wx"});
 }
 it.each([1,8,32,100])("measures mostly empty cohort %i",size=>emptyCohort(size,true),60000);
 it.each([1,8,32,100])("untimed count and empty-state proof %i",size=>emptyCohort(size,false),60000);
 it("records mixed current wait and ownership controls",async()=>{
  const {roots,actions}=await seed(12);
  const pending={status:"pending",currentStageId:null,currentStageIndex:null,currentStageType:null,currentParticipant:null,returnAssignee:null,completedStageIds:[],lastDecisionId:null,lastDecisionOutcome:null};
  // Four agent-owned rows select user, blocker, interaction and approval reasons.
  for(const i of [1,2,3,4,5]) await db.update(issueRecoveryActions).set({ownerType:"agent",ownerAgentId:agentId,wakePolicy:{type:"bounded_recovery_owner"}}).where(eq(issueRecoveryActions.id,actions[i].id));
  await db.update(issues).set({assigneeUserId:"board-user",assigneeAgentId:null,monitorNextCheckAt:new Date(Date.now()+3600000),executionState:pending}).where(eq(issues.id,roots[0].id));
  const [blocker]=await db.insert(issues).values({companyId,title:"blocker",status:"todo"}).returning();
  await db.insert(issueRelations).values({companyId,issueId:blocker.id,relatedIssueId:roots[1].id,type:"blocks"});
  await db.update(issues).set({monitorNextCheckAt:new Date(Date.now()+3600000),executionState:pending}).where(eq(issues.id,roots[1].id));
  await db.update(issues).set({monitorNextCheckAt:new Date(Date.now()+3600000),executionState:pending}).where(eq(issues.id,roots[2].id));
  await db.update(issues).set({executionState:pending}).where(eq(issues.id,roots[3].id));
  await db.insert(issueThreadInteractions).values([0,1,2,3,4,6].map(i=>({companyId,issueId:roots[i].id,kind:"request_confirmation",status:"pending",payload:{version:1,prompt:"Decide"}})));
  const ap=await db.insert(approvals).values([4,5].map(i=>({companyId,type:"hire_agent",payload:{index:i},status:"revision_requested"}))).returning();
  await db.insert(issueApprovals).values(ap.map((a,i)=>({companyId,issueId:roots[i+4].id,approvalId:a.id})));
  // Board interaction alone remains active. Same-action paths cannot clear recovery.
  await db.insert(heartbeatRuns).values({companyId,agentId,status:"running",contextSnapshot:{issueId:roots[7].id,recoveryActionId:actions[7].id}});
  await db.insert(agentWakeupRequests).values({companyId,agentId,source:"system",status:"queued",payload:{issueId:roots[7].id,recoveryActionId:actions[7].id}});
  // An independent path does clear a board action.
  await db.insert(heartbeatRuns).values({companyId,agentId,status:"running",contextSnapshot:{taskId:roots[9].id}});
  // Native reconciliation/export safety hold remains even with an independent path.
  await db.update(issueRecoveryActions).set({cause:"native_workspace_finalization_owner_unverified"}).where(eq(issueRecoveryActions.id,actions[10].id));
  await db.insert(heartbeatRuns).values({companyId,agentId,status:"running",contextSnapshot:{issueId:roots[10].id}});
  const [child]=await db.insert(issues).values({companyId,title:"healthy-child",status:"todo",parentId:roots[11].id,assigneeAgentId:agentId}).returning();
  await db.insert(issueThreadInteractions).values({companyId,issueId:child.id,kind:"request_confirmation",status:"pending",payload:{version:1,prompt:"Child decision"}});
  for(const issue of await db.select().from(issues).where(eq(issues.companyId,companyId))) expect(await collectDispositionRepairSourceState(db,{issue})).toEqual(await baselineState(db,{issue}));
  const before=await snapshot();
  const outcomes:any[]=[];
  vi.useFakeTimers({now:new Date("2026-11-03T15:00:00Z"),toFake:["Date"]});
  const rollback=new Error("owned fixture rollback");
  for(const factory of [baselineService,recoveryService]){
   try{await db.transaction(async tx=>{
    notifications.length=0;
    const result=await factory(tx as unknown as Db,{enqueueWakeup:async()=>{throw new Error("Unexpected enqueue");}}).reconcileActiveRecoveryActions({companyId});
    const after=await snapshot(tx as unknown as Db);
    outcomes.push({result,after,notifications:[...notifications]});
    throw rollback;
   });}catch(error){if(error!==rollback)throw error;}
  }
  vi.useRealTimers();
  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(await snapshot()).toEqual(before);
  const {result,after,notifications:observedNotifications}=outcomes[1];
  const state=(i:number)=>after.actions.find(a=>a.id===actions[i].id)!;
  for(const [i,reason]of [[0,"user_owner"],[1,"blocker"],[2,"monitor"],[3,"execution_stage"],[4,"interaction"],[5,"approval"]]as const) expect(state(i)).toMatchObject({status:"resolved",resolutionNote:`durable_path_restored:${reason}`});
  for(const i of [6,7,10])expect(state(i).status).toBe("active");
  expect(state(9)).toMatchObject({status:"resolved",resolutionNote:"new_source_execution_path"});
  expect(state(11)).toMatchObject({status:"resolved",resolutionNote:"durable_path_restored:healthy_child"});
  expect(after.wakes).toEqual(before.wakes);
  writeFileSync(`${evidence}/paired-mixed.json`,JSON.stringify({result,before,after,notifications:observedNotifications,outcomes},null,2),{flag:"wx"});
 },60000);

 it.each([false,true])("reads late query facts and preserves concurrent resolution: %s",async operatorResolves=>{
  const {roots,actions}=await seed(1);
  let started!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>{started=r;});const gate=new Promise<void>(r=>{release=r;});
  const execute=db.execute.bind(db),dialect=new PgDialect();
  const observer=vi.spyOn(db,"execute").mockImplementation(((query:any)=>{
   if(dialect.sqlToQuery(query).sql.includes('as "hasBlocker"')){started();return gate.then(()=>execute(query));}
   return execute(query);
  })as typeof db.execute);
  const running=recoveryService(db,{enqueueWakeup:async()=>{throw new Error("Unexpected enqueue");}}).reconcileActiveRecoveryActions({companyId});
  const operator=createDb(temporary.connectionString,{maxConnections:1});
  try{
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("fresh read gate not reached")),3000);})]);}finally{clearTimeout(timer);}
   await operator.insert(issueThreadInteractions).values({companyId,issueId:roots[0].id,kind:"request_confirmation",status:"pending",payload:{version:1,prompt:"Late decision"}});
   if(operatorResolves)await operator.update(issueRecoveryActions).set({status:"resolved",resolutionNote:"concurrent_board_decision",resolvedAt:new Date()}).where(eq(issueRecoveryActions.id,actions[0].id));
   release();const result=await running;
   const [state]=await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id,actions[0].id));
   expect(state).toMatchObject({status:"resolved",resolutionNote:operatorResolves?"concurrent_board_decision":"durable_path_restored:interaction"});
   expect(result.resolved).toBe(operatorResolves?0:1);
   writeFileSync(`${evidence}/late-${operatorResolves}.json`,JSON.stringify({result,state,lateFactObserved:true,concurrentDecisionPreserved:operatorResolves},null,2),{flag:"wx"});
  }finally{release();await running;observer.mockRestore();await operator.$client.end({timeout:1});}
 },15000);

});
