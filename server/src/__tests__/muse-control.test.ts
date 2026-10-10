import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, closeRegisteredClients, applyPendingMigrations, externalAgentHolds, heartbeatRuns, issueAccessGrants, issueComments, issues, projects, principalPermissionGrants, museAgentBindings as bindings, museCredentials, museInputDeliveries, museMailboxItems as mailbox, museRunnerAssignments as assignments, museRunnerOperations as operations, nativeRunFinalizations } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { startAgentLifecycle } from "../services/agent-lifecycle.js";
import { agentHarnessVerificationService } from "../services/agent-harness-verification.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { MuseCredentials } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { museIdentity, museCredentialHash } from "../services/muse-identity.js";
import { museRunnerBroker } from "../services/muse-runner-broker.js";
import { museReceiver } from "../services/muse-receiver.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { assertNoExternalOverlap, withExternalAdmissionGuard } from "../modules/external-agents/index.js";
import { digestPaperclipSemanticContent, externalOperationDigest, type ExternalProviderOperation } from "../vendor/paperclip-runner/index.js";

/** Real database/transport authority tests; synthetic provider receipts do not
 * count as live Muse/native qualification evidence. */
describe("personal Muse control plane",()=>{
  let temporary:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>|undefined,db:ReturnType<typeof createDb>,externalDatabaseUrl:string|undefined;
  beforeAll(async()=>{
    externalDatabaseUrl=process.env.PAPERCLIP_MUSE_CONTROL_TEST_DATABASE_URL?.trim();
    if(externalDatabaseUrl){await applyPendingMigrations(externalDatabaseUrl);db=createDb(externalDatabaseUrl);}
    else {temporary=await startEmbeddedPostgresTestDatabase("muse-control-");db=createDb(temporary.connectionString);}
    await instanceSettingsService(db).updateExperimental({enableNativeRunner:true,enableMuse:true});
  },30000);
  afterAll(async()=>{vi.unstubAllEnvs();await museReceiver(db).stop();if(externalDatabaseUrl)await closeRegisteredClients(externalDatabaseUrl);await temporary?.cleanup();});
  async function fixture(ready=true) {
    const operatorId=randomUUID();await db.insert(authUsers).values({id:operatorId,name:"Muse authorizer",email:operatorId+"@example.test",createdAt:new Date(),updatedAt:new Date()});
    const [company]=await db.insert(companies).values({name:"Muse control",issuePrefix:"MU"+randomBytes(3).toString("hex")}).returning();
    const [agent]=await db.insert(agents).values({companyId:company.id,name:"Muse",role:"engineer",status:"active",adapterType:"paperclip_runner",adapterConfig:{provider:"muse",allowUnmeteredProvider:true,lifecycle:"per_turn"},permissions:{canCreateTasks:true}}).returning();
    await db.insert(companyMemberships).values([{companyId:company.id,principalType:"user",principalId:operatorId,membershipRole:"owner",status:"active"},{companyId:company.id,principalType:"agent",principalId:agent.id,membershipRole:"member",status:"active"}]);
    const ticket=randomBytes(32).toString("base64url");const [binding]=await db.insert(bindings).values({companyId:company.id,agentId:agent.id,operatorId,ticketHash:museCredentialHash(ticket),ticketExpiresAt:new Date(Date.now()+600000)}).returning();
    await db.update(agents).set({adapterConfig:{...agent.adapterConfig,museBindingId:binding.id}}).where(eq(agents.id,agent.id));
    const identity=museIdentity(db),credentials=await identity.pair(ticket,"1"),broker=museRunnerBroker(db,{publicOrigin:"https://paperclip.example",heartbeat:{wakeup:vi.fn().mockResolvedValue(null),cancelRun:vi.fn()}});
    if(ready)await db.update(bindings).set({status:"ready",receiverContactAt:new Date(),verifiedReplyAt:new Date()}).where(eq(bindings.id,binding.id));
    return {company,agent,operatorId,binding,ticket,identity,credentials,broker,subject:await identity.authenticate(credentials.accessToken)};
  }
  async function active() {
    const f=await fixture(),runId=randomUUID(),session=randomUUID(),turnId="turn_"+randomUUID();
    const [issue]=await db.insert(issues).values({companyId:f.company.id,title:"Muse task",status:"in_progress",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    await db.insert(heartbeatRuns).values({id:runId,companyId:f.company.id,agentId:f.agent.id,status:"running",runtimeMode:"native",driverKind:"muse_external",nativeIssueId:issue.id,nativeSessionId:session,nativePhase:"turn_running",responsibleUserId:f.operatorId});
    await db.update(issues).set({checkoutRunId:runId,executionRunId:runId}).where(eq(issues.id,issue.id));
    await db.insert(nativeRunFinalizations).values({runId,companyId:f.company.id,issueId:issue.id,phase:"running",controllerGeneration:1,leaseExpiresAt:new Date(Date.now()+600000)});
    const execution={binding:{companyId:f.company.id,agentId:f.agent.id,runId},provider:{binding:await f.broker.snapshot(f.company.id,f.agent.id,f.binding.id)}};
    const port=f.broker.port(execution),sent:ExternalProviderOperation[]=[];
    const detach=await port.attach(async command=>{sent.push(command);await port.settle({sourceEventId:"settle_"+command.requestId,payload:{binding:ref,requestId:command.requestId,outcome:command.action==="consume_input"?{status:"consumed",requestId:command.input.requestId,inputDigest:command.input.inputDigest}:{status:command.action==="accept"?"accepted":"completed"}}});});
    const ref={...execution.provider.binding,runId,normalizedSessionId:session,turnId,assignmentRevision:1};
    await port.dispatch({sourceEventId:"offer_"+randomUUID(),payload:{kind:"assignment",binding:ref,tools:[],acceptByUnixMs:Date.now()+600000,expiresAtUnixMs:Date.now()+3600000}});
    const [assignment]=await db.select().from(assignments).where(eq(assignments.runId,runId));
    return {...f,runId,issue,port,ref,assignment,sent,detach};
  }
  it("consumes a ten-minute ticket once and separates credential lanes",async()=>{
    const f=await fixture(false);await expect(f.identity.pair(f.ticket,"1")).rejects.toThrow("consumed");
    expect(f.credentials.accessToken).not.toBe(f.credentials.signalToken);
    await expect(f.identity.authenticate(f.credentials.signalToken)).rejects.toThrow();
    await expect(f.identity.authenticate(f.credentials.accessToken,"signal")).rejects.toThrow();
    const rows=await db.select().from(museCredentials).where(eq(museCredentials.bindingId,f.binding.id));
    expect(rows).toHaveLength(5);expect(rows.some(r=>r.tokenHash===f.credentials.accessToken)).toBe(false);
    expect(new Date(f.credentials.accessExpiresAt).getTime()-Date.now()).toBeLessThanOrEqual(15*60000);
  });
  it("rotates refresh once and commits family revocation on consumed-token replay",async()=>{
    const f=await fixture(),rotated=await f.identity.refresh(f.credentials.refreshToken);
    await expect(f.identity.authenticate(f.credentials.accessToken)).rejects.toThrow();
    await expect(f.identity.refresh(f.credentials.refreshToken)).rejects.toThrow("replay");
    await expect(f.identity.authenticate(rotated.accessToken)).rejects.toThrow();
    await expect(f.identity.authenticate(rotated.signalToken,"signal")).rejects.toThrow();
  });
  it("polling does not extend refresh inactivity and independent contact creates the first challenge",async()=>{
    const f=await fixture(false),signal=await f.identity.authenticate(f.credentials.signalToken,"signal");
    const [before]=await db.select().from(museCredentials).where(and(eq(museCredentials.bindingId,f.binding.id),eq(museCredentials.kind,"refresh")));
    expect((await museReceiver(db).signal(signal)).signal).toBeNull();await museReceiver(db).flush();
    const [after]=await db.select().from(museCredentials).where(eq(museCredentials.id,before.id));expect(after.expiresAt).toEqual(before.expiresAt);
    const items=await f.broker.inspect(f.subject,{version:1,query:"mailbox",after:0}) as {items:Array<{references:{nonce:string}}>};expect(items.items).toHaveLength(1);
    await f.broker.act(f.subject,{version:1,command:"challenge.confirm",nonce:items.items[0].references.nonce,requestId:randomUUID()});
    expect((await f.broker.bindingForAgent(f.company.id,f.agent.id))?.backgroundReplyVerified).toBe(true);
  });
  it("retains a mailbox batch until its prior durable cursor is acknowledged",async()=>{
    const f=await fixture();await db.insert(mailbox).values({companyId:f.company.id,bindingId:f.binding.id,bindingGeneration:1,kind:"follow_up",sourceEventId:randomUUID(),references:{}});
    const batch=await f.broker.inspect(f.subject,{version:1,query:"mailbox",after:0}) as {nextCursor:number};
    expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].workerCursor).toBe(0);
    await f.broker.inspect(f.subject,{version:1,query:"mailbox",after:batch.nextCursor});
    expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].workerCursor).toBe(batch.nextCursor);
  });
  it("filters current idle task visibility even with global privacy disabled",async()=>{
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE","off");const f=await fixture();
    const other=randomUUID();await db.insert(authUsers).values({id:other,name:"other",email:other+"@example.test",createdAt:new Date(),updatedAt:new Date()});
    const [issue]=await db.insert(issues).values({companyId:f.company.id,title:"secret",visibility:"private",responsibleUserId:other,assigneeAgentId:f.agent.id}).returning();
    expect((await f.broker.inspect(f.subject,{version:1,query:"task.list"}) as {tasks:unknown[]}).tasks).toEqual([]);
    await db.insert(issueAccessGrants).values({issueId:issue.id,subjectType:"user",subjectId:f.operatorId,source:"explicit"});
    expect((await f.broker.inspect(f.subject,{version:1,query:"task.list"}) as {tasks:unknown[]}).tasks).toHaveLength(1);
    await db.update(companyMemberships).set({status:"inactive"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));
    await expect(f.broker.inspect(f.subject,{version:1,query:"task.read",issueId:issue.id})).rejects.toThrow();vi.unstubAllEnvs();
  });
  it("creates visible idle tasks with supported creation authority and a stable mutation receipt",async()=>{
    const f=await fixture(),command={version:1 as const,command:"task.create" as const,requestId:randomUUID(),title:"Idle intake",description:"Ordinary task intake"};
    const result=await f.broker.act(f.subject,command);
    expect(result.status).toBe("created");expect(await f.broker.act(f.subject,command)).toEqual(result);
    const [issue]=await db.select().from(issues).where(eq(issues.id,String(result.issueId)));
    expect(issue.createdByAgentId).toBe(f.agent.id);expect(issue.responsibleUserId).toBe(f.operatorId);expect(issue.status).toBe("todo");
    await expect(f.broker.act(f.subject,{...command,title:"Changed intake"})).rejects.toThrow("changed input");
  });
  it("comments on an idle task using its complete current permission resource",async()=>{
    const f=await fixture();const [issue]=await db.insert(issues).values({companyId:f.company.id,title:"Idle comment",status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    const command={version:1 as const,command:"task.comment" as const,requestId:randomUUID(),issueId:issue.id,body:"Idle coordination"};
    const result=await f.broker.act(f.subject,command);expect(result.status).toBe("commented");expect(await f.broker.act(f.subject,command)).toEqual(result);
    const rows=await db.select().from(issueComments).where(eq(issueComments.issueId,issue.id));
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({authorAgentId:f.agent.id,authorUserId:null,onBehalfOfUserId:f.operatorId,body:command.body});
    await db.update(companyMemberships).set({membershipRole:"viewer"}).where(and(eq(companyMemberships.companyId,f.company.id),eq(companyMemberships.principalId,f.operatorId)));
    await expect(f.broker.act(f.subject,{...command,requestId:randomUUID()})).rejects.toThrow("authority");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId,issue.id))).toHaveLength(1);
  });
  it("applies idle creation grants to the actual inherited parent project",async()=>{
    const f=await fixture();const [project]=await db.insert(projects).values({companyId:f.company.id,name:"Protected intake",executionWorkspacePolicy:{authorizationPolicy:{assignmentPolicy:{mode:"protected"}}}}).returning();
    const [parent]=await db.insert(issues).values({companyId:f.company.id,title:"Intake parent",projectId:project.id,status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    const command={version:1 as const,command:"task.create" as const,requestId:randomUUID(),title:"Scoped child",parentId:parent.id};
    await expect(f.broker.act(f.subject,command)).rejects.toThrow("protected");
    await db.insert(principalPermissionGrants).values({companyId:f.company.id,principalType:"agent",principalId:f.agent.id,permissionKey:"tasks:assign_scope",scope:{projectIds:[randomUUID()]}});
    await expect(f.broker.act(f.subject,command)).rejects.toThrow();
    await db.update(principalPermissionGrants).set({scope:{projectIds:[project.id]}}).where(and(eq(principalPermissionGrants.companyId,f.company.id),eq(principalPermissionGrants.principalId,f.agent.id)));
    await expect(f.broker.act(f.subject,command)).rejects.toThrow("Authorizing user");
    await db.insert(principalPermissionGrants).values({companyId:f.company.id,principalType:"user",principalId:f.operatorId,permissionKey:"tasks:assign_scope",scope:{projectIds:[randomUUID()]}});
    await expect(f.broker.act(f.subject,command)).rejects.toThrow();
    await db.update(principalPermissionGrants).set({scope:{projectIds:[project.id]}}).where(and(eq(principalPermissionGrants.companyId,f.company.id),eq(principalPermissionGrants.principalId,f.operatorId)));
    const result=await f.broker.act(f.subject,command);expect(result.status).toBe("created");
    const [child]=await db.select().from(issues).where(eq(issues.id,String(result.issueId)));expect(child.parentId).toBe(parent.id);expect(child.projectId).toBe(project.id);
  });
  it("creates an assigned turn intake atomically before requesting ordinary admission",async()=>{
    const f=await fixture(),wakeup=vi.fn().mockImplementation(async(agentId,options)=>{
      const [issue]=await db.select().from(issues).where(eq(issues.id,options.payload.issueId));
      expect(agentId).toBe(f.agent.id);expect(issue.assigneeAgentId).toBe(f.agent.id);expect(issue.responsibleUserId).toBe(f.operatorId);return null;
    });
    museRunnerBroker(db,{heartbeat:{wakeup,cancelRun:vi.fn()}});
    const command={version:1 as const,command:"turn.request" as const,requestId:randomUUID(),prompt:"Research ordinary intake"};
    expect((await f.broker.act(f.subject,command)).status).toBe("requested");expect(wakeup).toHaveBeenCalledTimes(1);
    await expect(f.broker.act(f.subject,{...command,prompt:"Changed intake"})).rejects.toThrow("changed input");
    expect(await db.select().from(issues).where(eq(issues.companyId,f.company.id))).toHaveLength(1);
  });
  it("atomically reserves a work identity across competing issue locks and replays its original run",async()=>{
    const f=await active(),heartbeat=heartbeatService(db),wakeup=vi.fn(heartbeat.wakeup);
    museRunnerBroker(db,{heartbeat:{wakeup,cancelRun:heartbeat.cancelRun}});
    await db.update(companies).set({defaultResponsibleUserId:f.operatorId}).where(eq(companies.id,f.company.id));
    await db.update(agents).set({runtimeConfig:{heartbeat:{maxConcurrentRuns:20,wakeOnDemand:true}}}).where(eq(agents.id,f.agent.id));
    const task=async(title:string)=>(await db.insert(issues).values({companyId:f.company.id,title,status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning())[0]!;
    const first=await task("First request"),second=await task("Changed request"),requestId=randomUUID();
    const commands=[first,second].map(issue=>({version:1 as const,command:"work.request" as const,requestId,issueId:issue.id}));
    try {
      const race=await Promise.allSettled(commands.map(command=>f.broker.act(f.subject,command)));
      expect(race.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(race.filter(r=>r.status==="rejected")).toHaveLength(1);
      const receipts=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId,f.agent.id),eq(agentWakeupRequests.idempotencyKey,`muse-work:${f.binding.id}:1:${requestId}`)));
      expect(receipts).toHaveLength(1);const receipt=receipts[0],command=commands.find(c=>c.issueId===receipt.payload?.issueId)!;
      expect(receipt.payload?.museRequestDigest).toBe(externalOperationDigest("tool",{command}));expect(receipt.runId).toBeTruthy();
      const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,receipt.runId!));expect(run.contextSnapshot?.issueId).toBe(command.issueId);expect(run.status).toBe("queued");
      const response=(race.find(r=>r.status==="fulfilled") as PromiseFulfilledResult<Record<string,unknown>>).value;
      wakeup.mockClear();
      expect(await Promise.all(Array.from({length:3},()=>f.broker.act(f.subject,command)))).toEqual([response,response,response]);
      await db.update(heartbeatRuns).set({status:"succeeded",finishedAt:new Date()}).where(eq(heartbeatRuns.id,run.id));
      await db.update(issues).set({status:"done"}).where(eq(issues.id,command.issueId));
      expect(await f.broker.act(f.subject,command)).toEqual(response);expect(wakeup).not.toHaveBeenCalled();
      await expect(f.broker.act(f.subject,commands.find(c=>c.issueId!==command.issueId)!)).rejects.toThrow("changed input");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agent.id))).toHaveLength(2);
    }finally{await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.agentId,f.agent.id));await f.detach();}
  },30000);
  it("keeps concurrent turn retries on one assigned intake and one durable wake",async()=>{
    const f=await active(),heartbeat=heartbeatService(db),wakeup=vi.fn(heartbeat.wakeup);
    museRunnerBroker(db,{heartbeat:{wakeup,cancelRun:heartbeat.cancelRun}});
    await db.update(companies).set({defaultResponsibleUserId:f.operatorId}).where(eq(companies.id,f.company.id));
    await db.update(agents).set({runtimeConfig:{heartbeat:{maxConcurrentRuns:20,wakeOnDemand:true}}}).where(eq(agents.id,f.agent.id));
    const command={version:1 as const,command:"turn.request" as const,requestId:randomUUID(),prompt:"One ordinary turn intake"};
    try {
      const responses=await Promise.all(Array.from({length:3},()=>f.broker.act(f.subject,command)));
      expect(responses).toEqual([responses[0],responses[0],responses[0]]);
      const intake=await db.select().from(issues).where(and(eq(issues.companyId,f.company.id),eq(issues.title,command.prompt)));
      expect(intake).toHaveLength(1);expect(intake[0].assigneeAgentId).toBe(f.agent.id);
      const rows=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId,f.agent.id),eq(agentWakeupRequests.idempotencyKey,`muse-work:${f.binding.id}:1:${command.requestId}`)));
      expect(rows).toHaveLength(1);expect(rows[0].payload?.museRequestDigest).toBe(externalOperationDigest("tool",{command}));expect(rows[0].runId).toBe(responses[0].runId);
      wakeup.mockClear();expect(await f.broker.act(f.subject,command)).toEqual(responses[0]);expect(wakeup).not.toHaveBeenCalled();
      await expect(f.broker.act(f.subject,{version:1,command:"work.request",issueId:intake[0].id,requestId:command.requestId})).rejects.toThrow("changed input");
      await expect(f.broker.act(f.subject,{...command,prompt:"Changed turn prompt"})).rejects.toThrow("changed input");expect(wakeup).not.toHaveBeenCalled();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agent.id))).toHaveLength(2);
    }finally{await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.agentId,f.agent.id));await f.detach();}
  },30000);
  it("does not enqueue a replacement for an older receipt without an exact payload digest",async()=>{
    const f=await fixture(),wakeup=vi.fn();museRunnerBroker(db,{heartbeat:{wakeup,cancelRun:vi.fn()}});
    const [issue]=await db.insert(issues).values({companyId:f.company.id,title:"Old receipt",status:"todo",assigneeAgentId:f.agent.id,responsibleUserId:f.operatorId}).returning();
    const command={version:1 as const,command:"work.request" as const,issueId:issue.id,requestId:randomUUID()};
    await db.insert(agentWakeupRequests).values({companyId:f.company.id,agentId:f.agent.id,source:"assignment",requestedByActorType:"agent",requestedByActorId:f.agent.id,idempotencyKey:`muse-work:${f.binding.id}:1:${command.requestId}`,payload:{issueId:issue.id,museRequestId:command.requestId}});
    await expect(f.broker.act(f.subject,command)).rejects.toThrow("changed input");expect(wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,f.agent.id))).toHaveLength(1);
  });
  it("admits one authenticated claim and keeps claimed/native accepted times distinct",async()=>{
    const f=await active();try {
      const requestId=randomUUID(),claim={version:1 as const,command:"accept" as const,assignmentId:f.assignment.id,requestId};
      expect((await f.broker.act(f.subject,claim)).status).toBe("accepted");expect(f.sent).toHaveLength(1);
      expect((await f.broker.act(f.subject,claim)).status).toBe("accepted");expect(f.sent).toHaveLength(1);
      await expect(f.broker.act(f.subject,{...claim,requestId:randomUUID()})).rejects.toThrow("claimed");
      const [a]=await db.select().from(assignments).where(eq(assignments.id,f.assignment.id));expect(a.claimedAt).toBeInstanceOf(Date);expect(a.nativeAcceptedAt).toBeInstanceOf(Date);
      await expect(db.transaction(tx=>withExternalAdmissionGuard(tx,f.company.id,f.agent.id,()=>assertNoExternalOverlap(tx,f.company.id,f.agent.id)))).rejects.toMatchObject({details:{code:"external_agent_overlap"}});
    }finally{await f.detach();}
  });
  it("persists canonical input before ACK and separates client proof from exact native input",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const requestId="native_question",response={schema:"paperclip.question_response.v1",answers:[]},inputDigest=digestPaperclipSemanticContent({requestId,turnId:f.ref.turnId,response});
      await f.port.inputAvailable({sourceEventId:randomUUID(),payload:{binding:f.ref,requestId,turnId:f.ref.turnId,inputDigest,response}});
      expect(await db.select().from(museInputDeliveries).where(eq(museInputDeliveries.assignmentId,f.assignment.id))).toHaveLength(1);
      await expect(f.broker.act(f.subject,{version:1,command:"finish",assignmentId:f.assignment.id,requestId:randomUUID(),result:{}})).rejects.toThrow("input");
      const proof=randomUUID();await f.broker.act(f.subject,{version:1,command:"consume_input",assignmentId:f.assignment.id,requestId:randomUUID(),nativeRequestId:requestId,inputDigest,continuationReceiptId:proof,continuationPersisted:true});
      expect(f.sent.at(-1)?.input).toEqual({requestId,inputDigest});expect((await db.select().from(museInputDeliveries).where(eq(museInputDeliveries.assignmentId,f.assignment.id)))[0].continuationReceiptId).toBe(proof);
    }finally{await f.detach();}
  });
  it("fences without fabricating private stop and retains unknown native effects across operator attestation",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await db.update(externalAgentHolds).set({nativeEffectsUnknown:true}).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      await f.broker.revoke(f.company.id,f.agent.id,f.operatorId,{bindingId:f.binding.id,generation:1,expectedRevision:state.revision});
      const stopped=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!,boundary=stopped.stop.boundary!;expect(stopped.stop.status).toBe("cannot_confirm");
      await instanceSettingsService(db).updateExperimental({enableMuse:false});
      const cleanup=await f.identity.authenticate(f.credentials.cleanupToken,"cleanup");expect((await f.broker.cleanup(cleanup,{command:"worker.quiescent",boundary,requestId:randomUUID()})).externalStopConfirmed).toBe(false);
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary,expectedRevision:stopped.revision,workerStopped:true});
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));expect(hold.workerUnknown).toBe(false);expect(hold.nativeEffectsUnknown).toBe(true);expect(hold.releasedAt).toBeNull();
      await expect(f.identity.authenticate(f.credentials.accessToken)).rejects.toThrow();
    }finally{await instanceSettingsService(db).updateExperimental({enableMuse:true});await f.detach();}
  });
  it("reports the exact old stop revision after repair and cancels only the fenced native run",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      const cancelRun=vi.fn().mockResolvedValue(null);
      museRunnerBroker(db,{heartbeat:{wakeup:vi.fn().mockResolvedValue(null),cancelRun}});
      const before=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      const pairing=await f.broker.createPairing({companyId:f.company.id,agentId:f.agent.id,operatorId:f.operatorId,replaceBindingId:f.binding.id,expectedRevision:before.revision});
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      expect(state.id).toBe(pairing.bindingId);expect(state.stop.boundary?.bindingId).toBe(f.binding.id);
      expect(state.stop.bindingRevision).toBe(before.revision+1);expect(state.revision).not.toBe(state.stop.bindingRevision);
      expect(cancelRun).toHaveBeenCalledWith(f.runId,"Muse connection replaced");
      const boundary=state.stop.boundary!;
      await expect(f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary,expectedRevision:state.revision,workerStopped:true})).rejects.toThrow("Stop boundary changed");
      await db.update(bindings).set({revision:state.revision+10}).where(eq(bindings.id,state.id));
      const refreshed=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
      expect(refreshed.stop.bindingRevision).toBe(state.stop.bindingRevision);expect(refreshed.stop.boundary).toEqual(boundary);
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary,expectedRevision:refreshed.stop.bindingRevision!,workerStopped:true});
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));
      expect(hold.workerUnknown).toBe(false);expect(hold.operatorAttestedAt).toBeInstanceOf(Date);
      await expect(f.identity.authenticate(f.credentials.accessToken)).rejects.toThrow();
    }finally{await f.detach();}
  });
  it("preserves a persisted qualification deadline on retry and enforces it without a watcher",async()=>{
    const f=await fixture(),state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!,qualificationId=randomUUID(),input={companyId:f.company.id,agentId:f.agent.id,bindingId:f.binding.id,generation:1,expectedRevision:state.revision,operatorId:f.operatorId,qualificationId,expiresAt:new Date(Date.now()+86400000)};
    const start=await f.broker.beginQualification(input),retry=await f.broker.beginQualification({...input,expiresAt:new Date(Date.now()+86400000)});expect(retry.expiresAt).toEqual(start.expiresAt);expect(Date.parse(start.expiresAt)-Date.parse(start.startedAt)).toBe(86400000);
    await db.update(bindings).set({qualificationExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
    await expect(f.identity.authenticate(f.credentials.signalToken,"signal")).rejects.toThrow("deadline");
    const [ended]=await db.select().from(bindings).where(eq(bindings.id,f.binding.id));expect(ended.revokedAt).toBeInstanceOf(Date);expect(ended.deadlineEnforcedAt).toBeInstanceOf(Date);
  });
  it("rejects a claim when reassignment commits while its exact issue lock is held",async()=>{
    const f=await active();let unlock!:()=>void,held!:()=>void;
    const gate=new Promise<void>(resolve=>{unlock=resolve;}),locked=new Promise<void>(resolve=>{held=resolve;});
    const reassignment=db.transaction(async tx=>{await tx.select({id:issues.id}).from(issues).where(eq(issues.id,f.issue.id)).for("update");held();await gate;await tx.update(issues).set({assigneeAgentId:null,checkoutRunId:null,executionRunId:null}).where(eq(issues.id,f.issue.id));});
    await locked;let settled=false;
    const claim=f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()}).finally(()=>{settled=true;});
    try {await new Promise(resolve=>setTimeout(resolve,50));expect(settled).toBe(false);unlock();await reassignment;await expect(claim).rejects.toThrow("task");expect(f.sent).toEqual([]);expect((await db.select().from(assignments).where(eq(assignments.id,f.assignment.id)))[0].claimedAt).toBeNull();}finally{unlock();await f.detach();}
  });
  it("reconciles pending sends to an independent unknown barrier on controller recovery",async()=>{
    const f=await active();await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});await f.detach();
    const requestId=randomUUID(),input={name:"write_document",arguments:{}},command={requestId,bindingId:f.binding.id,bindingGeneration:1,runId:f.runId,normalizedSessionId:f.assignment.normalizedSessionId,turnId:f.assignment.turnId,assignmentRevision:1,action:"tool",input,digest:externalOperationDigest("tool",input)};
    await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId,digest:command.digest,command,status:"pending"});
    const send=vi.fn(),detach=await f.port.attach(send,undefined,true);
    try {expect((await db.select().from(operations).where(eq(operations.requestId,requestId)))[0].status).toBe("unknown");expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0].nativeEffectsUnknown).toBe(true);expect((await f.broker.act(f.subject,{version:1,command:"tool",assignmentId:f.assignment.id,requestId,name:input.name,arguments:{}})).status).toBe("unknown");expect(send).not.toHaveBeenCalled();}finally{await detach();}
  });
  it("rearms an unclaimed offer after a lost wake but never restarts a claimed assignment",async()=>{
    const f=await active();try {
      const signal=await f.identity.authenticate(f.credentials.signalToken,"signal"),first=await museReceiver(db).signal(signal);
      await db.update(mailbox).set({signalNotifiedAt:new Date(Date.now()-31000)}).where(eq(mailbox.assignmentId,f.assignment.id));
      const retry=await museReceiver(db).signal(signal);expect(retry.signal?.reference).not.toEqual(first.signal?.reference);
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});expect((await museReceiver(db).signal(signal)).signal).toBeNull();
    }finally{await f.detach();}
  });
  it("rejects missing public origin before replacing a durable connection",async()=>{
    const f=await fixture(),state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;
    // A broker instance keeps its configured public origin; use a fresh DB
    // wrapper to exercise the same persisted binding with a bad setup origin.
    const bad=museRunnerBroker(createDb(externalDatabaseUrl??temporary!.connectionString),{publicOrigin:"http://invalid.example"});
    await expect(bad.createPairing({companyId:f.company.id,agentId:f.agent.id,operatorId:f.operatorId,replaceBindingId:f.binding.id,expectedRevision:state.revision})).rejects.toThrow("HTTPS");
    expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].revokedAt).toBeNull();
  });

  it("denies an existing subject after its same-provider configured binding changes",async()=>{
    const f=await fixture();await db.update(agents).set({adapterConfig:{provider:"muse",museBindingId:randomUUID(),allowUnmeteredProvider:true}}).where(eq(agents.id,f.agent.id));
    await expect(f.broker.inspect(f.subject,{version:1,query:"task.list"})).rejects.toThrow("authority");
    await expect(f.identity.authenticate(f.credentials.signalToken,"signal")).rejects.toThrow("authority");
  });

  it("gives a settled result an exact stop boundary when native finalization fails",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await db.update(assignments).set({status:"settled",acceptedResultAt:new Date()}).where(eq(assignments.id,f.assignment.id));
      await db.update(heartbeatRuns).set({status:"failed",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.runId));
      await f.broker.reconcileTerminalAssignments(f.company.id,f.agent.id,f.binding.id);
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;expect(state.stop.status).toBe("cannot_confirm");expect(state.stop.boundary?.assignmentId).toBe(f.assignment.id);
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary:state.stop.boundary!,expectedRevision:state.revision,workerStopped:true});
      expect((await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id)))[0].releasedAt).toBeInstanceOf(Date);
    }finally{await f.detach();}
  });

  it("keeps the native-effect barrier when a Runner fence precedes worker attestation",async()=>{
    const f=await active();try {
      await f.broker.act(f.subject,{version:1,command:"accept",assignmentId:f.assignment.id,requestId:randomUUID()});
      await db.insert(operations).values({companyId:f.company.id,assignmentId:f.assignment.id,requestId:randomUUID(),digest:"pending",command:{action:"tool"},status:"pending"});
      await f.port.dispatch({sourceEventId:randomUUID(),payload:{kind:"authority_revoked",binding:f.ref}});
      const state=(await f.broker.bindingForAgent(f.company.id,f.agent.id))!;expect(state.stop.nativeEffectsUnknown).toBe(true);
      await f.broker.attestStop(f.company.id,f.agent.id,f.operatorId,{boundary:state.stop.boundary!,expectedRevision:state.revision,workerStopped:true});
      const [hold]=await db.select().from(externalAgentHolds).where(eq(externalAgentHolds.assignmentId,f.assignment.id));expect(hold.releasedAt).toBeNull();expect(hold.nativeEffectsUnknown).toBe(true);
    }finally{await f.detach();}
  });

  it("denies already-dispatched native authority immediately at the qualification deadline",async()=>{
    const f=await active();try {
      await db.update(bindings).set({qualificationId:randomUUID(),qualificationExpiresAt:new Date(Date.now()-1)}).where(eq(bindings.id,f.binding.id));
      await expect(f.broker.assertRunAuthority({binding:{companyId:f.company.id,agentId:f.agent.id,runId:f.runId},provider:{binding:f.ref}})).rejects.toThrow("deadline");
      await expect(f.broker.authorizingUserIdForBinding(f.ref)).rejects.toThrow("deadline");
      expect((await db.select().from(bindings).where(eq(bindings.id,f.binding.id)))[0].revokedAt).toBeNull();
    }finally{await f.detach();}
  });

  it("promotes a verifying Muse hire through the ordinary lifecycle after authenticated background confirmation",async()=>{
    const f=await fixture(false);
    await db.update(agents).set({status:"paused",lifecycleState:"verifying",lifecycleOperation:{id:randomUUID(),hostComplete:false,completedPluginIds:[],attempts:0,responsibleUserId:f.operatorId},lifecycleRequiredPluginIds:[]}).where(eq(agents.id,f.agent.id));
    const harness=agentHarnessVerificationService(db,{} as PluginWorkerManager),onReady=vi.fn();
    const lifecycle=startAgentLifecycle(db,{requiredPluginIds:async()=>[],runPlugin:async()=>"complete",runHost:snapshot=>harness.verify(snapshot),onReady},()=>true);
    try {
      await lifecycle.sweep();expect((await db.select().from(agents).where(eq(agents.id,f.agent.id)))[0].lifecycleState).toBe("verifying");
      await museReceiver(db).signal(await f.identity.authenticate(f.credentials.signalToken,"signal"));await museReceiver(db).flush();
      const items=await f.broker.inspect(f.subject,{version:1,query:"mailbox",after:0}) as {items:Array<{references:{nonce:string}}>};
      await f.broker.act(f.subject,{version:1,command:"challenge.confirm",nonce:items.items[0].references.nonce,requestId:randomUUID()});
      await expect.poll(async()=> (await db.select().from(agents).where(eq(agents.id,f.agent.id)))[0].lifecycleState,{timeout:8000,interval:100}).toBe("ready");
      expect((await db.select().from(agents).where(eq(agents.id,f.agent.id)))[0].status).toBe("idle");expect(onReady).toHaveBeenCalledOnce();
    }finally{await lifecycle.stop();}
  });

});
