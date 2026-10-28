import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../services/delivery-work-notifications.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { agents, companies, projects, activityLog, heartbeatRuns, issues, issueComments, issueDocuments, documents, nativeRunFinalizations, agentWakeupRequests,
  museAgentBindings as bindings, museCredentials as credentials, museRunnerAssignments as assignments, museRunnerOperations as operations,
  museMailboxItems as mailbox, museInputDeliveries as inputs, museIdleReceipts as idleReceipts, externalAgentHolds as holds,
  museReceiverContactBuckets, mcpOauthGrants, mcpOauthTokens, type Db } from "@paperclipai/db";
import { MUSE_TICKET_TTL_MS, MUSE_CLEANUP_TTL_MS, MUSE_RESOURCE_PATH, museStopBoundarySchema, MUSE_ASSET_VERSION, type AgentConnectionSubject, type MuseBinding, type MuseCommand,
  type MuseQuery, type MusePairing, type MuseStopBoundary, type MuseQualificationEvidence, type MuseQualificationBeginResult, museDetectorCleanupAttestationSchema, type MuseDetectorCleanupEvidence, type MuseDetectorCleanupAttestationInput } from "@paperclipai/shared";
import { externalOperationDigest, parsePaperclipQuestionSet, type MuseBindingSnapshot, type ExternalProviderPort, type ExternalProviderOperation } from "../../vendor/paperclip-runner/index.js";
import { conflict, forbidden, notFound, unprocessable } from "../../errors.js";
import { museIdentity, museCredentialHash, assertMuseCurrentAuthority, assertMuseSubjectCredential, inspectMuseConnectionCredential, assertMuseCleanupCredential, museCleanupBoundaryIds, assertMuseDisabledStopControlCredential, museStopControlBoundaryIds } from "../../services/muse-identity.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { updateAgentConfigurationInTransaction } from "../../services/agent-configuration-transaction.js";
import { AgentLifecycleConflict, canConfigureAgentConnection } from "../agent-lifecycle/index.js";
import { createAgentLifecycle } from "../../services/agent-lifecycle.js";
import { authorizationService, issueReadSqlCondition, type AuthorizationActor } from "../../services/authorization.js";
import { logActivity, publishActivity, type ActivityPublication } from "../../services/activity-log.js";
import { issueService } from "../../services/issues.js";
import { resolveCoreTrustPreset } from "../../services/trust-preset-resolver.js";
import { normalizeIssueExecutionPolicy } from "../../services/issue-execution-policy.js";
import { buildLowTrustSourceTrust, isLowTrustQuarantined, redactQuarantinedBodyForHigherTrust, resolveActorSourceTrustForIssue, sanitizeQuarantinedCommentForHigherTrust } from "../../services/source-trust.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext } from "../../services/native-runtime/native-review-participant.js";
import { withExternalAdmissionGuard, assertNoExternalOverlap, type ExternalAdmissionTransaction } from "./admission.js";
import { createNativeExternalBroker } from "./native-broker.js";
import { consumeMuseHistoryReceipt } from "../../services/muse-assignment-follow-up.js";
import type { heartbeatService } from "../../services/heartbeat.js";
import { buildMuseSetupInstruction, musePublicOrigin } from "../../services/muse-setup.js";

type Heartbeat = Pick<ReturnType<typeof heartbeatService>,"wakeup"|"cancelRun">;
type Execution = {binding:{companyId:string;agentId:string;runId:string};provider:{binding:MuseBindingSnapshot}};
const iso=(value:Date|null)=>value?.toISOString()??null;
const instances=new WeakMap<Db,ReturnType<typeof createMuseBroker>>();
const heartbeatContexts=new WeakMap<Db,Heartbeat>();
export function museExternalAgents(db:Db, options?:{heartbeat?:Heartbeat;publicOrigin?:string}) {
  if(options?.heartbeat) heartbeatContexts.set(db,options.heartbeat);
  let broker=instances.get(db);
  if(!broker) { broker=createMuseBroker(db,options?.publicOrigin); instances.set(db,broker); }
  return broker;
}
function createMuseBroker(db:Db, publicOrigin?:string) {
  const identity=museIdentity(db);
  const connectionResource=()=>{try{return musePublicOrigin(publicOrigin)+MUSE_RESOURCE_PATH;}catch{return "";}};
  async function heartbeat() { const configured=heartbeatContexts.get(db); if(configured)return configured; return (await import("../../services/heartbeat.js")).heartbeatService(db); }
  function agentActor(s:AgentConnectionSubject,runId?:string,responsibleUserId?:string|null):AuthorizationActor {return {type:"agent",agentId:s.agentId,companyId:s.companyId,runId,authorizingUserId:s.authorizingUserId,onBehalfOfUserId:responsibleUserId};}
  function authorizerActor(s:AgentConnectionSubject):AuthorizationActor { return {type:"board",userId:s.authorizingUserId,source:"session",ignoreInstanceAdmin:true}; }
  async function subjectBinding(s:AgentConnectionSubject,ready=true,paused=false,stopControl=false) {
    const b=await assertMuseSubjectCredential(db,s,s.credentialSource==="oauth"?connectionResource():undefined);
    if(!await identity.enabled()) {
      if(!stopControl)throw forbidden("Muse normal authority is unavailable.");
      await assertMuseDisabledStopControlCredential(db,s,s.credentialSource==="oauth"?connectionResource():undefined);
    }
    if(b.qualificationExpiresAt && b.qualificationExpiresAt<=new Date()) { await broker.endQualification({companyId:b.companyId,agentId:b.agentId,bindingId:b.id,qualificationId:b.qualificationId!,operatorId:b.operatorId}); throw forbidden("Qualification deadline elapsed."); }
    await assertMuseCurrentAuthority(db,b,!ready,paused);
    return b;
  }
  async function canReadIssue(authorization:ReturnType<typeof authorizationService>,actor:AuthorizationActor,issue:Pick<typeof issues.$inferSelect,"id"|"companyId"|"projectId"|"parentId"|"assigneeAgentId"|"assigneeUserId"|"status"|"originKind"|"originId">) {
    const scope={issueId:issue.id,projectId:issue.projectId,parentIssueId:issue.parentId,assigneeAgentId:issue.assigneeAgentId,assigneeUserId:issue.assigneeUserId};
    // decide intersects the agent, responsible user and current authorizer;
    // privacy SQL alone does not enforce the ordinary work/trust boundary.
    return (await authorization.decide({actor,action:"issue:read",resource:{type:"issue",companyId:issue.companyId,...scope,status:issue.status,originKind:issue.originKind,originId:issue.originId},scope})).allowed;
  }
  async function assertIssue(s:AgentConnectionSubject,issueId:string,runResponsibleUserId?:string|null,database:Db|ExternalAdmissionTransaction=db,runId?:string) {
    const actor=agentActor(s,runId,runResponsibleUserId);
    const conditions=[eq(issues.companyId,s.companyId),eq(issues.id,issueId),await issueReadSqlCondition(database,actor),isNull(issues.hiddenAt),isNull(issues.harnessKind)];
    const [issue]=await database.select().from(issues).where(and(...conditions));
    if(!issue||!await canReadIssue(authorizationService(database),actor,issue)) throw notFound("Task is unavailable to the current Muse agent and authorizer.");
    return issue;
  }
  async function listReadableIssues(s:AgentConnectionSubject,q:Extract<MuseQuery,{query:"task.list"|"task.search"}>) {
    const actor=agentActor(s),condition=await issueReadSqlCondition(db,actor),authorization=authorizationService(db);
    const tasks:Array<Pick<typeof issues.$inferSelect,"id"|"identifier"|"title"|"status"|"assigneeAgentId">>=[];
    let cursor=q.after,scanned=0;
    // Bound ordinary decisions without exposing the last denied candidate as
    // a cursor. Search can narrow collections beyond this 200-candidate limit.
    while(scanned<200) {
      const candidates=await db.select({id:issues.id,companyId:issues.companyId,identifier:issues.identifier,title:issues.title,status:issues.status,projectId:issues.projectId,parentId:issues.parentId,assigneeAgentId:issues.assigneeAgentId,assigneeUserId:issues.assigneeUserId,originKind:issues.originKind,originId:issues.originId}).from(issues).where(and(eq(issues.companyId,s.companyId),condition,isNull(issues.hiddenAt),isNull(issues.harnessKind),cursor?gt(issues.id,cursor):undefined,q.query==="task.search"?sql`(${issues.title} ilike ${`%${q.text}%`} or ${issues.description} ilike ${`%${q.text}%`})`:undefined)).orderBy(asc(issues.id)).limit(50);
      for(const issue of candidates) {
        scanned++;cursor=issue.id;
        if(await canReadIssue(authorization,actor,issue))tasks.push({id:issue.id,identifier:issue.identifier,title:issue.title,status:issue.status,assigneeAgentId:issue.assigneeAgentId});
        if(tasks.length===50)return {tasks,nextCursor:tasks.at(-1)!.id};
      }
      if(candidates.length<50)return {tasks,nextCursor:tasks.at(-1)?.id??null};
    }
    throw unprocessable("Task collection exceeds its read limit. Use task.search with a narrower query.");
  }
  async function authorizeAssignment(s:AgentConnectionSubject,id:string,allowSettled=false) {
    const b=await subjectBinding(s);
    const [a]=await db.select().from(assignments).where(and(eq(assignments.id,id),eq(assignments.companyId,s.companyId),eq(assignments.agentId,s.agentId),eq(assignments.bindingId,b.id),eq(assignments.bindingGeneration,b.generation)));
    if(!a || a.status==="fenced" || (!allowSettled && a.status==="settled") || (!allowSettled && a.expiresAt<=new Date())) throw forbidden("Assignment authority expired or was fenced.");
    const [run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,a.runId),eq(heartbeatRuns.companyId,a.companyId),eq(heartbeatRuns.agentId,a.agentId)));
    if(run?.nativeIssueId) await assertIssue(s,run.nativeIssueId,run.responsibleUserId,db,run.id);
    if(a.status==="settled" && allowSettled) return {b,a,run};
    const [owner]=await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId,a.runId),eq(nativeRunFinalizations.companyId,a.companyId)));
    const [company]=await db.select().from(companies).where(eq(companies.id,a.companyId));
    const [agent]=await db.select().from(agents).where(eq(agents.id,a.agentId));
    const issue=run?.nativeIssueId?await assertIssue(s,run.nativeIssueId,run.responsibleUserId,db,run.id):null;
    const reviewContext=readNativeReviewAssignmentContext(run?.contextSnapshot);
    const review=run&&issue&&reviewContext?await getNativeReviewAssignment(db,{companyId:a.companyId,issueId:issue.id,agentId:a.agentId,contextSnapshot:run.contextSnapshot,actingRunId:run.id,allowResolvedByRunId:run.id}):null;
    const owns=run&&issue&&(reviewContext?!!review&&(review.interaction.status!=="pending"||issue.executionRunId===run.id):issue.assigneeAgentId===a.agentId&&[issue.checkoutRunId,issue.executionRunId].includes(run.id));
    if(!run||run.status!=="running"||run.runtimeMode!=="native"||run.nativeSessionId!==a.normalizedSessionId||!owns||!owner||owner.controllerGeneration!==a.controllerGeneration||!owner.leaseExpiresAt||owner.leaseExpiresAt<=new Date()
      ||["terminal_failure","turn_stopping","turn_stopped"].includes(run.nativePhase??"")||company?.status!=="active"||!agent||["paused","terminated","pending_approval"].includes(agent.status)
      ||(company.budgetMonthlyCents>0&&company.spentMonthlyCents>=company.budgetMonthlyCents)||(agent.budgetMonthlyCents>0&&agent.spentMonthlyCents>=agent.budgetMonthlyCents)) throw forbidden("Native run no longer owns execution authority.");
    return {b,a,run};
  }
  async function fence(tx:ExternalAdmissionTransaction,b:typeof bindings.$inferSelect,reason:string) {
    const live=await tx.select().from(assignments).where(and(eq(assignments.bindingId,b.id),eq(assignments.bindingGeneration,b.generation),sql`(${assignments.status} in ('offered','claimed','accepted') or (${assignments.status}='settled' and exists(select 1 from ${holds} where ${holds.assignmentId}=${assignments.id} and ${holds.provider}='muse' and ${holds.releasedAt} is null)))`));
    for(const a of live) {
      const [last]=await tx.select({id:operations.requestId}).from(operations).where(eq(operations.assignmentId,a.id)).orderBy(desc(operations.createdAt)).limit(1);
      const boundary:MuseStopBoundary={bindingId:b.id,generation:b.generation,assignmentId:a.id,runId:a.runId,turnId:a.turnId,assignmentRevision:a.revision,stopNonce:randomUUID(),operationBoundary:last?.id??null};
      await tx.update(assignments).set({status:"fenced"}).where(eq(assignments.id,a.id));
      const [unresolved]=await tx.select({id:operations.id}).from(operations).where(and(eq(operations.assignmentId,a.id),inArray(operations.status,["dispatched","pending","unknown"]))).limit(1);
      if(a.claimedAt) await tx.insert(holds).values({companyId:b.companyId,agentId:b.agentId,provider:"muse",assignmentId:a.id,bindingId:b.id,bindingGeneration:b.generation,runId:a.runId,workerUnknown:true,nativeEffectsUnknown:!!unresolved,stopBoundary:boundary}).onConflictDoUpdate({target:[holds.provider,holds.assignmentId],set:{stopBoundary:boundary,workerUnknown:true,nativeEffectsUnknown:sql`${holds.nativeEffectsUnknown} or ${!!unresolved}`,releasedAt:null,updatedAt:new Date()}});
      await tx.insert(mailbox).values({companyId:b.companyId,bindingId:b.id,bindingGeneration:b.generation,assignmentId:a.id,kind:"authority_revoked",sourceEventId:`muse-stop:${boundary.stopNonce}`,references:{boundary,reason,externalStopConfirmed:false}}).onConflictDoNothing();
    }
    return live.map(a=>a.runId);
  }
  async function revokeOAuthAuthority(tx:ExternalAdmissionTransaction,b:typeof bindings.$inferSelect) {
    if(!b.grantId)return;
    await tx.update(mcpOauthGrants).set({revokedAt:new Date()}).where(and(eq(mcpOauthGrants.id,b.grantId),eq(mcpOauthGrants.companyId,b.companyId),eq(mcpOauthGrants.agentId,b.agentId),eq(mcpOauthGrants.userId,b.operatorId)));
    await tx.update(mcpOauthTokens).set({usedAt:new Date(),expiresAt:new Date()}).where(eq(mcpOauthTokens.grantId,b.grantId));
  }
  async function revokeBinding(tx:ExternalAdmissionTransaction,b:typeof bindings.$inferSelect,operatorId:string,reason:string,actorType:"user"|"system"="user") {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.museMaintenance);
    const runs=await fence(tx,b,reason);
    await tx.update(bindings).set({status:"revoked",revokedAt:new Date(),ticketHash:null,challengeHash:null,cleanupExpiresAt:new Date(Date.now()+MUSE_CLEANUP_TTL_MS),deadlineEnforcedAt:b.deadlineEnforcedAt??(b.qualificationExpiresAt&&b.qualificationExpiresAt<=new Date()?new Date():null),revision:b.revision+1,updatedAt:new Date()}).where(eq(bindings.id,b.id));
    await tx.update(credentials).set({revokedAt:new Date()}).where(and(eq(credentials.bindingId,b.id),inArray(credentials.kind,["access","refresh","signal"])));
    await tx.update(credentials).set({expiresAt:new Date(Date.now()+MUSE_CLEANUP_TTL_MS)}).where(and(eq(credentials.bindingId,b.id),inArray(credentials.kind,["cleanup","detector_cleanup"]),isNull(credentials.revokedAt)));
    await revokeOAuthAuthority(tx,b);
    await logActivity(tx as unknown as Db,{companyId:b.companyId,actorType,actorId:operatorId,action:"muse.binding_revoked",entityType:"agent",entityId:b.agentId,details:{bindingId:b.id,generation:b.generation,authorizingUserId:b.operatorId,source:reason,externalStopConfirmed:false}});
    return runs;
  }
  const nativeBroker=createNativeExternalBroker<AgentConnectionSubject>(db,"muse",{enabled:identity.enabled,expectedResource:connectionResource,
    assertSubjectCredential:async(tx,s)=>{await assertMuseSubjectCredential(tx,s,s.credentialSource==="oauth"?connectionResource():undefined);},
    authorize:async(s,id,settled)=>{const {b,a}=await authorizeAssignment(s,id,settled);return {binding:b,assignment:a};}});
  const operation=nativeBroker.operation;
  const detectorHook=(b:typeof bindings.$inferSelect)=>`~/hooks/scripts/paperclip-muse-${b.id}.sh`;
  async function detectorEvidence(database:Db|ExternalAdmissionTransaction,b:typeof bindings.$inferSelect):Promise<MuseDetectorCleanupEvidence|null> {
    if(!b.detectorRemovedAt)return null;
    const rows=await database.select().from(activityLog).where(and(eq(activityLog.companyId,b.companyId),eq(activityLog.entityType,"agent"),eq(activityLog.entityId,b.agentId),eq(activityLog.agentId,b.agentId),
      inArray(activityLog.action,["muse.detector_cleanup_attested","muse.detector_removal_reported"]),
      sql`${activityLog.details}->>'bindingId' = ${b.id}`,sql`${activityLog.details}->>'generation' = ${String(b.generation)}`,
      sql`((${activityLog.actorType}='user' and ${activityLog.action}='muse.detector_cleanup_attested' and ${activityLog.responsibleUserId}=${activityLog.actorId}) or (${activityLog.actorType}='agent' and ${activityLog.action}='muse.detector_removal_reported' and ${activityLog.actorId}=${b.agentId} and ${activityLog.responsibleUserId}=${b.operatorId}))`)).orderBy(sql`case when ${activityLog.action}='muse.detector_cleanup_attested' then 0 else 1 end`,desc(activityLog.createdAt)).limit(2);
    for(const row of rows) {
      const d=row.details??{},operator=row.action==="muse.detector_cleanup_attested";
      if(operator&&(d.source!=="operator_runtime_attestation"||d.qualificationId!==b.qualificationId||d.hookScript!==detectorHook(b)||d.recordedAt!==b.detectorRemovedAt.toISOString()||typeof d.observedAt!=="string"||!Number.isFinite(Date.parse(d.observedAt))||d.method!=="hooks.list"||d.includeDisabled!==true||typeof d.hookId!=="string"||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(d.hookId)||d.outcome!=="exact_hook_absent"))continue;
      const recordedAt=operator?b.detectorRemovedAt:row.createdAt;
      return {bindingId:b.id,generation:b.generation,qualificationId:b.qualificationId,hookScript:detectorHook(b),source:operator?"operator_runtime_attestation":"authenticated_worker_report",recordedAt:recordedAt.toISOString(),observedAt:operator?d.observedAt as string:recordedAt.toISOString(),operatorId:operator?row.actorId:null,hookId:operator?d.hookId as string:null};
    }
    return null;
  }
  function staleWorkerDetectorEvidence(b:typeof bindings.$inferSelect,evidence:MuseDetectorCleanupEvidence) {
    return evidence.source==="authenticated_worker_report"&&(Date.parse(evidence.recordedAt)<(b.revokedAt?.getTime()??Infinity)||!!b.qualificationExpiresAt&&Date.parse(evidence.recordedAt)<b.qualificationExpiresAt.getTime());
  }
  function detectorAttestationEligible(b:typeof bindings.$inferSelect) {
    return b.status==="revoked"&&!!b.revokedAt&&(!b.qualificationId||!!b.qualificationExpiresAt&&b.qualificationExpiresAt<=new Date()&&!!b.deadlineEnforcedAt&&b.deadlineEnforcedAt>=b.qualificationExpiresAt&&b.revokedAt>=b.qualificationExpiresAt);
  }
  const broker={
    enabled:identity.enabled,
    async createPairing(input:{companyId:string;agentId:string;operatorId:string;replaceBindingId?:string;expectedRevision?:number}):Promise<MusePairing> {
      if(!await identity.enabled())throw forbidden("Enable Muse and Paperclip Runner before connecting.");
      const ticket=randomBytes(32).toString("base64url"),bindingId=randomUUID();
      // Validate the public assets before changing any existing invitation.
      const [scopeAgent]=await db.select({id:agents.id,name:agents.name}).from(agents).where(and(eq(agents.id,input.agentId),eq(agents.companyId,input.companyId)));
      const [scopeCompany]=await db.select({id:companies.id,name:companies.name}).from(companies).where(eq(companies.id,input.companyId));
      if(!scopeAgent||!scopeCompany)throw notFound("Muse pairing scope not found.");
      const setupInstruction=await buildMuseSetupInstruction(publicOrigin,ticket,bindingId,{companyId:scopeCompany.id,companyName:scopeCompany.name,agentId:scopeAgent.id,agentName:scopeAgent.name});
      const {binding:b,replacedRuns}=await db.transaction(tx=>withExternalAdmissionGuard(tx,input.companyId,input.agentId,async()=>{
        const [agent]=await tx.select().from(agents).where(and(eq(agents.id,input.agentId),eq(agents.companyId,input.companyId))).for("update");
        if(!agent||agent.adapterType!=="paperclip_runner"||agent.adapterConfig.provider!=="muse"||!canConfigureAgentConnection(agent))throw conflict("Choose an approved Muse Runner agent.");
        const [old]=await tx.select().from(bindings).where(and(eq(bindings.companyId,input.companyId),eq(bindings.agentId,input.agentId),isNull(bindings.revokedAt))).for("update");
        let replacedRuns:string[]=[];
        if(old) {
          if(old.id!==input.replaceBindingId||old.revision!==input.expectedRevision||old.operatorId!==input.operatorId)throw conflict("Invitation changed. Refresh before replacing its ticket.");
          replacedRuns=await fence(tx,old,"reconnect");
          await tx.update(bindings).set({status:"revoked",revokedAt:new Date(),cleanupExpiresAt:new Date(Date.now()+MUSE_CLEANUP_TTL_MS),ticketHash:null,revision:old.revision+1,updatedAt:new Date()}).where(eq(bindings.id,old.id));
          await tx.update(credentials).set({revokedAt:new Date()}).where(and(eq(credentials.bindingId,old.id),inArray(credentials.kind,["access","refresh","signal"])));
          await revokeOAuthAuthority(tx,old);
          await tx.update(credentials).set({expiresAt:new Date(Date.now()+MUSE_CLEANUP_TTL_MS)}).where(and(eq(credentials.bindingId,old.id),inArray(credentials.kind,["cleanup","detector_cleanup"]),isNull(credentials.revokedAt)));
        } else if(input.replaceBindingId)throw conflict("Invitation changed. Refresh before replacing its ticket.");
        const [latest]=await tx.select({generation:bindings.generation}).from(bindings).where(and(eq(bindings.companyId,input.companyId),eq(bindings.agentId,input.agentId))).orderBy(desc(bindings.generation)).limit(1);
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.museMaintenance);
        const [created]=await tx.insert(bindings).values({id:bindingId,companyId:input.companyId,agentId:input.agentId,operatorId:input.operatorId,generation:(latest?.generation??0)+1,ticketHash:museCredentialHash(ticket),ticketExpiresAt:new Date(Date.now()+MUSE_TICKET_TTL_MS)}).returning();
        await logActivity(tx as unknown as Db,{companyId:input.companyId,actorType:"user",actorId:input.operatorId,action:"muse.pairing_created",entityType:"agent",entityId:input.agentId,details:{bindingId:created!.id,generation:created!.generation}});
        await updateAgentConfigurationInTransaction(tx as unknown as Db,agent.id,{adapterConfig:{...agent.adapterConfig,museBindingId:created!.id}},{recordRevision:{createdByUserId:input.operatorId,source:"muse-pairing"}});
        return {binding:created!,replacedRuns};
      }));
      await Promise.all(replacedRuns.map(async runId=>{await nativeBroker.revokeRun(runId);await(await heartbeat()).cancelRun(runId,"Muse connection replaced");}));
      return {bindingId:b.id,generation:b.generation,revision:b.revision,ticket,expiresAt:b.ticketExpiresAt!.toISOString(),assetVersion:MUSE_ASSET_VERSION,setupInstruction};
    },
    async bindingForAgent(companyId:string,agentId:string):Promise<MuseBinding|null> {
      const [b]=await db.select().from(bindings).where(and(eq(bindings.companyId,companyId),eq(bindings.agentId,agentId))).orderBy(desc(bindings.generation)).limit(1);
      if(!b)return null;
      const live=await db.select({id:assignments.id}).from(assignments).where(and(eq(assignments.companyId,companyId),eq(assignments.agentId,agentId),inArray(assignments.status,["offered","claimed","accepted"])));
      const unknown=await db.select({id:operations.id}).from(operations).innerJoin(assignments,eq(assignments.id,operations.assignmentId)).where(and(eq(assignments.companyId,companyId),eq(assignments.agentId,agentId),inArray(operations.status,["unknown","dispatched","pending"])));
      // Fenced/settled answers remain audit history and cannot be consumed by
      // their former worker. Independent stop/effect holds still block work.
      const pending=await db.select({id:inputs.id}).from(inputs).innerJoin(assignments,eq(assignments.id,inputs.assignmentId)).where(and(eq(assignments.companyId,companyId),eq(assignments.agentId,agentId),inArray(assignments.status,["offered","claimed","accepted"]),isNull(inputs.consumedAt)));
      const [stop]=await db.select().from(holds).where(and(eq(holds.companyId,companyId),eq(holds.agentId,agentId),eq(holds.provider,"muse"),isNull(holds.releasedAt))).orderBy(desc(holds.createdAt)).limit(1);
      const [stopBinding]=stop?.stopBoundary ? await db.select({revision:bindings.revision}).from(bindings).where(and(eq(bindings.id,stop.stopBoundary.bindingId),eq(bindings.generation,stop.stopBoundary.generation),eq(bindings.companyId,companyId),eq(bindings.agentId,agentId))) : [];
      const cleanupEvidence=await detectorEvidence(db,b);
      const credential=await inspectMuseConnectionCredential(db,b,b.grantId?connectionResource():undefined);
      return {id:b.id,generation:b.generation,revision:b.revision,status:b.status,paired:!!b.pairedAt,receiverDetected:!!b.receiverContactAt,backgroundReplyVerified:!!b.verifiedReplyAt,
        pairingExpiresAt:iso(b.ticketExpiresAt),challengeExpiresAt:iso(b.challengeExpiresAt),lastReceiverContactAt:iso(b.receiverContactAt),lastWorkerActivityAt:iso(b.workerActivityAt),lastVerifiedReplyAt:iso(b.verifiedReplyAt),credentialState:credential.state,refreshExpiresAt:credential.refreshExpiresAt,receiverContactTrust:"public_untrusted",contactPersistenceLagMs:30000,clientVersion:b.clientVersion,
        qualification:b.qualificationId&&b.qualificationExpiresAt?{id:b.qualificationId,expiresAt:b.qualificationExpiresAt.toISOString()}:null,
        liveAssignments:live.length,uncertainOperations:unknown.length,pendingInputs:pending.length,
        cleanup:{detectorEvidence:cleanupEvidence,attestationEligible:detectorAttestationEligible(b)&&(!cleanupEvidence||staleWorkerDetectorEvidence(b,cleanupEvidence)),hookScript:detectorHook(b),authenticatedAfterRevocation:!b.grantId,detectorRemovalRequested:!!b.detectorRemovalRequestedAt,pending:!!b.cleanupExpiresAt&&b.cleanupExpiresAt>new Date()&&(!b.detectorRemovedAt||!!stop),detectorRemoved:!!b.detectorRemovedAt,workerQuiescenceReported:!!stop?.workerReportedAt,expiresAt:b.grantId?null:iso(b.cleanupExpiresAt)},
        stop:{status:!stop?.stopBoundary?"none":stop.operatorAttestedAt?"operator_attested":stop.workerReportedAt?"worker_reported":"cannot_confirm",nativeEffectsUnknown:!!stop?.nativeEffectsUnknown,boundary:stop?.stopBoundary??null,bindingRevision:stopBinding?.revision??null}};
    },
    async snapshot(companyId:string,agentId:string,bindingId:string):Promise<MuseBindingSnapshot> {
      if(!await identity.enabled())throw forbidden("Muse is disabled for new work.");
      const [b]=await db.select().from(bindings).where(and(eq(bindings.id,bindingId),eq(bindings.companyId,companyId),eq(bindings.agentId,agentId),isNull(bindings.revokedAt)));
      if(!b||b.status!=="ready"||!b.receiverContactAt||!b.verifiedReplyAt)throw conflict("Pair Muse, detect its receiver, and verify an independent background reply first.");
      if(b.qualificationExpiresAt&&b.qualificationExpiresAt<=new Date()){await broker.endQualification({companyId,agentId,bindingId,qualificationId:b.qualificationId!,operatorId:b.operatorId});throw conflict("Qualification deadline elapsed.");}
      await assertMuseCurrentAuthority(db,b);
      if((await inspectMuseConnectionCredential(db,b,b.grantId?connectionResource():undefined)).state!=="active")throw forbidden("Muse credentials expired or were revoked. Reconnect Muse before dispatching work.");
      return {companyId,agentId,bindingId,bindingGeneration:b.generation,acceptByUnixMs:Date.now()+10*60_000,expiresAtUnixMs:Math.min(Date.now()+2*60*60_000,b.qualificationExpiresAt?.getTime()??Infinity)};
    },
    async verify(companyId:string,agentId:string,input:{bindingId:string;generation:number;expectedRevision:number},operatorId?:string) {
      if(!await identity.enabled())throw forbidden("Muse is disabled.");
      const nonce=randomBytes(24).toString("base64url");
      const publications:ActivityPublication[]=[];
      const result=await db.transaction(tx=>withExternalAdmissionGuard(tx,companyId,agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.id,input.bindingId),eq(bindings.companyId,companyId),eq(bindings.agentId,agentId),eq(bindings.generation,input.generation),eq(bindings.revision,input.expectedRevision),isNull(bindings.revokedAt))).for("update");
        if(!b||!b.pairedAt||!b.receiverContactAt)throw conflict("Pair Muse and detect the receiver before verifying.");
        await assertMuseCurrentAuthority(tx,b,true);
        if(b.challengeHash&&b.challengeExpiresAt&&b.challengeExpiresAt>new Date())return {bindingId:b.id,generation:b.generation,revision:b.revision,expiresAt:b.challengeExpiresAt.toISOString(),status:"pending" as const};
        const expiry=new Date(Date.now()+10*60_000);
        await tx.update(bindings).set({challengeHash:museCredentialHash(nonce),challengeExpiresAt:expiry,revision:b.revision+1,updatedAt:new Date()}).where(eq(bindings.id,b.id));
        await tx.insert(mailbox).values({companyId,bindingId:b.id,bindingGeneration:b.generation,kind:"readiness_challenge",sourceEventId:`muse-challenge:${randomUUID()}`,references:{nonce}});
        await logActivity(tx as unknown as Db,{companyId,actorType:operatorId?"user":"system",actorId:operatorId??"muse-runner",agentId, responsibleUserIdOverride:operatorId??b.operatorId,action:"muse.readiness_challenge_created",entityType:"agent",entityId:agentId,details:{bindingId:b.id,generation:b.generation,revision:b.revision+1,authorizingUserId:b.operatorId,expiresAt:expiry.toISOString()}},publications);
        return {bindingId:b.id,generation:b.generation,revision:b.revision+1,expiresAt:expiry.toISOString(),status:"pending" as const};
      }));
      publications.forEach(publishActivity);return result;
    },
    async revoke(companyId:string,agentId:string,operatorId:string,input?:{bindingId:string;generation:number;expectedRevision:number}) {
      const runs=await db.transaction(tx=>withExternalAdmissionGuard(tx,companyId,agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.companyId,companyId),eq(bindings.agentId,agentId),input?eq(bindings.id,input.bindingId):undefined,isNull(bindings.revokedAt))).for("update");
        if(!b)return [];
        if(input&&(b.generation!==input.generation||b.revision!==input.expectedRevision))throw conflict("Connection changed; refresh before disconnecting.");
        return revokeBinding(tx,b,operatorId,"disconnect");
      }));
      await Promise.all(runs.map(async runId=>{await nativeBroker.revokeRun(runId);await(await heartbeat()).cancelRun(runId,"Muse connection revoked");}));
    },
    async revokeOAuthGrant(input:{grantId:string;companyId:string;agentId:string;authorizingUserId:string}) {
      const runs=await db.transaction(tx=>withExternalAdmissionGuard(tx,input.companyId,input.agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.grantId,input.grantId),eq(bindings.companyId,input.companyId),eq(bindings.agentId,input.agentId),eq(bindings.operatorId,input.authorizingUserId),isNull(bindings.revokedAt))).for("update");
        return b?revokeBinding(tx,b,"muse-oauth","oauth_grant","system"):[];
      }));
      await Promise.all(runs.map(async runId=>{await nativeBroker.revokeRun(runId);await(await heartbeat()).cancelRun(runId,"Muse OAuth authority revoked");}));
    },
    async attestStop(companyId:string,agentId:string,operatorId:string,input:{boundary:MuseStopBoundary;expectedRevision:number;workerStopped:true}) {
      return db.transaction(tx=>withExternalAdmissionGuard(tx,companyId,agentId,async()=>{
        const boundary=museStopBoundarySchema.parse(input.boundary);
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.id,boundary.bindingId),eq(bindings.companyId,companyId),eq(bindings.agentId,agentId),eq(bindings.generation,boundary.generation))).for("update");
        const [hold]=await tx.select().from(holds).where(and(eq(holds.companyId,companyId),eq(holds.agentId,agentId),eq(holds.provider,"muse"),eq(holds.assignmentId,boundary.assignmentId))).for("update");
        if(!b||b.revision!==input.expectedRevision||!hold?.stopBoundary||externalOperationDigest("tool",{boundary:hold.stopBoundary})!==externalOperationDigest("tool",{boundary}))throw conflict("Stop boundary changed. Refresh before attesting.");
        await tx.update(holds).set({operatorAttestedAt:new Date(),workerUnknown:false,releasedAt:hold.nativeEffectsUnknown?null:new Date(),updatedAt:new Date()}).where(eq(holds.id,hold.id));
        await tx.update(bindings).set({revision:b.revision+1,updatedAt:new Date()}).where(eq(bindings.id,b.id));
        await logActivity(tx as unknown as Db,{companyId,actorType:"user",actorId:operatorId,action:"muse.worker_stop_attested",entityType:"agent",entityId:agentId,details:{bindingId:b.id,assignmentId:boundary.assignmentId,stopNonce:boundary.stopNonce,nativeEffectsUnknown:hold.nativeEffectsUnknown,externalStopConfirmed:false}});
        return {status:"operator_attested",nativeEffectsUnknown:hold.nativeEffectsUnknown,externalStopConfirmed:false};
      }));
    },
    async attestDetectorCleanup(companyId:string,agentId:string,operatorId:string,value:MuseDetectorCleanupAttestationInput,actor:AuthorizationActor) {
      const input=museDetectorCleanupAttestationSchema.parse(value),publications:ActivityPublication[]=[];
      const result=await db.transaction(tx=>withExternalAdmissionGuard(tx,companyId,agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.companyId,companyId),eq(bindings.agentId,agentId))).orderBy(desc(bindings.generation)).limit(1).for("update");
        if(!b||b.id!==input.bindingId||b.generation!==input.generation||b.qualificationId!==input.qualificationId||input.hookScript!==detectorHook(b)||!detectorAttestationEligible(b))throw conflict("Detector cleanup scope changed or its deadline has not ended. Refresh before attesting.");
        if(actor.type!=="board"||actor.userId!==operatorId)throw forbidden("A current Board operator is required.");
        const decision=await authorizationService(tx).decide({actor,action:"agent_config:update",resource:{type:"agent",companyId,agentId},scope:{requiresChangeGrant:true}});
        if(!decision.allowed)throw forbidden(decision.explanation);
        const digest=externalOperationDigest("tool",{input,operatorId});
        const prior=await detectorEvidence(tx,b);
        if(prior&&!staleWorkerDetectorEvidence(b,prior)) {
          const [same]=await tx.select({id:activityLog.id}).from(activityLog).where(and(eq(activityLog.companyId,companyId),eq(activityLog.entityType,"agent"),eq(activityLog.entityId,agentId),eq(activityLog.agentId,agentId),eq(activityLog.action,"muse.detector_cleanup_attested"),eq(activityLog.actorType,"user"),eq(activityLog.actorId,operatorId),eq(activityLog.responsibleUserId,operatorId),sql`${activityLog.details}->>'inputDigest' = ${digest}`,sql`${activityLog.details}->>'bindingId' = ${b.id}`,sql`${activityLog.details}->>'generation' = ${String(b.generation)}`)).limit(1);
          if(same&&b.revision===input.expectedRevision+1&&prior.source==="operator_runtime_attestation")return {revision:b.revision,evidence:prior};
          throw conflict("Detector cleanup was already recorded or the connection changed.");
        }
        if(b.revision!==input.expectedRevision)throw conflict("Connection changed. Refresh before attesting.");
        const now=new Date(),observedAt=new Date(input.observation.observedAt);
        if(observedAt<b.revokedAt!||observedAt>now||(b.qualificationExpiresAt&&observedAt<b.qualificationExpiresAt))throw conflict("Use an observation made after revocation and the qualification deadline, not a future observation.");
        await tx.update(bindings).set({detectorRemovalRequestedAt:b.detectorRemovalRequestedAt??now,detectorRemovedAt:now,revision:b.revision+1,updatedAt:now}).where(eq(bindings.id,b.id));
        await logActivity(tx as unknown as Db,{companyId,actorType:"user",actorId:operatorId,agentId,responsibleUserIdOverride:operatorId,action:"muse.detector_cleanup_attested",entityType:"agent",entityId:agentId,
          details:{bindingId:b.id,generation:b.generation,qualificationId:b.qualificationId,expectedRevision:input.expectedRevision,revision:b.revision+1,source:"operator_runtime_attestation",hookScript:detectorHook(b),method:input.observation.method,includeDisabled:true,hookId:input.observation.hookId,outcome:input.observation.outcome,observedAt:observedAt.toISOString(),observationSha256:input.observation.sha256,recordedAt:now.toISOString(),inputDigest:digest,externalStopConfirmed:false}},publications);
        return {revision:b.revision+1,evidence:{bindingId:b.id,generation:b.generation,qualificationId:b.qualificationId,hookScript:detectorHook(b),source:"operator_runtime_attestation" as const,recordedAt:now.toISOString(),observedAt:observedAt.toISOString(),operatorId,hookId:input.observation.hookId}};
      }));
      for(const publication of publications){try{publishActivity(publication);}catch{}}
      return result;
    },
    async reconcileTerminalAssignments(companyId:string,agentId:string,bindingId:string) {
      await db.transaction(tx=>withExternalAdmissionGuard(tx,companyId,agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.id,bindingId),eq(bindings.companyId,companyId),eq(bindings.agentId,agentId))).for("update");if(!b)return;
        const terminal=await tx.select({a:assignments,run:heartbeatRuns}).from(assignments).innerJoin(heartbeatRuns,eq(heartbeatRuns.id,assignments.runId)).where(and(eq(assignments.bindingId,b.id),inArray(heartbeatRuns.status,["succeeded","failed","cancelled","timed_out","interrupted"])));
        for(const {a,run}of terminal) {
          if(a.status==="settled"&&a.acceptedResultAt) {
            await tx.update(assignments).set({finalizedAt:run.finishedAt}).where(eq(assignments.id,a.id));
            const [unknown]=await tx.select({id:operations.id}).from(operations).where(and(eq(operations.assignmentId,a.id),inArray(operations.status,["unknown","dispatched","pending"]))).limit(1);
            if(run.status!=="succeeded"||unknown) {await fence(tx,b,"run_terminal_after_result");continue;}
            if(!unknown&&run.status==="succeeded")await tx.update(holds).set({workerUnknown:false,releasedAt:new Date(),updatedAt:new Date()}).where(and(eq(holds.provider,"muse"),eq(holds.assignmentId,a.id),eq(holds.nativeEffectsUnknown,false),isNull(holds.releasedAt)));
          } else if(["offered","claimed","accepted"].includes(a.status)) await fence(tx,b,"run_terminal");
        }
      }));
    },
    async beginQualification(input:{companyId:string;agentId:string;bindingId:string;generation:number;expectedRevision:number;qualificationId:string;expiresAt:Date;operatorId:string}) {
      if(input.expiresAt<=new Date()||input.expiresAt.getTime()>Date.now()+24*60*60_000)throw conflict("Qualification requires a bounded future deadline of at most 24 hours.");
      const publications:ActivityPublication[]=[];
      const result=await db.transaction(tx=>withExternalAdmissionGuard(tx,input.companyId,input.agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.id,input.bindingId),eq(bindings.companyId,input.companyId),eq(bindings.agentId,input.agentId),eq(bindings.generation,input.generation),eq(bindings.revision,input.expectedRevision),eq(bindings.status,"ready"),isNull(bindings.revokedAt))).for("update");
        if(!b) {
          const [same]=await tx.select().from(bindings).where(and(eq(bindings.id,input.bindingId),eq(bindings.companyId,input.companyId),eq(bindings.agentId,input.agentId),eq(bindings.qualificationId,input.qualificationId)));
          if(same?.qualificationStartedAt&&same.qualificationExpiresAt)return {qualificationId:input.qualificationId,startedAt:same.qualificationStartedAt.toISOString(),expiresAt:same.qualificationExpiresAt.toISOString(),revision:same.revision};
          throw conflict("Connection changed or qualification already exists.");
        }
        if(b.qualificationId===input.qualificationId&&b.qualificationStartedAt&&b.qualificationExpiresAt)return {qualificationId:input.qualificationId,startedAt:b.qualificationStartedAt.toISOString(),expiresAt:b.qualificationExpiresAt.toISOString(),revision:b.revision};
        if(b.qualificationId)throw conflict("Another qualification already exists.");
        await assertMuseCurrentAuthority(tx,b);
        const startedAt=new Date(input.expiresAt.getTime()-24*60*60_000);
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.museMaintenance);
        await tx.update(bindings).set({qualificationId:input.qualificationId,qualificationStartedAt:startedAt,qualificationExpiresAt:input.expiresAt,revision:b.revision+1,updatedAt:new Date()}).where(eq(bindings.id,b.id));
        await logActivity(tx as unknown as Db,{companyId:input.companyId,actorType:"user",actorId:input.operatorId,agentId:input.agentId,action:"muse.qualification_started",entityType:"agent",entityId:input.agentId,details:{bindingId:b.id,generation:b.generation,revision:b.revision+1,authorizingUserId:b.operatorId,qualificationId:input.qualificationId,startedAt:startedAt.toISOString(),expiresAt:input.expiresAt.toISOString()}},publications);
        return {qualificationId:input.qualificationId,startedAt:startedAt.toISOString(),expiresAt:input.expiresAt.toISOString(),revision:b.revision+1};
      }));
      publications.forEach(publishActivity);return result;
    },
    async endQualification(input:{companyId:string;agentId:string;bindingId:string;qualificationId:string;operatorId:string}) {
      const [b]=await db.select().from(bindings).where(and(eq(bindings.id,input.bindingId),eq(bindings.companyId,input.companyId),eq(bindings.agentId,input.agentId),eq(bindings.qualificationId,input.qualificationId)));
      if(!b)throw notFound("Qualification not found.");
      if(!b.revokedAt)await broker.revoke(input.companyId,input.agentId,input.operatorId,{bindingId:b.id,generation:b.generation,expectedRevision:b.revision});
      await (await import("../../services/muse-receiver.js")).museReceiver(db).flush();
      if(b.qualificationExpiresAt&&b.qualificationExpiresAt<=new Date())await db.update(bindings).set({deadlineEnforcedAt:new Date()}).where(and(eq(bindings.id,b.id),eq(bindings.qualificationId,input.qualificationId),isNull(bindings.deadlineEnforcedAt)));
    },
    async readQualificationEvidence(companyId:string,agentId:string,bindingId:string,qualificationId:string):Promise<MuseQualificationEvidence> {
      const [b]=await db.select().from(bindings).where(and(eq(bindings.id,bindingId),eq(bindings.companyId,companyId),eq(bindings.agentId,agentId),eq(bindings.qualificationId,qualificationId)));
      if(!b)throw notFound("Qualification not found.");
      const startedAt=b.qualificationStartedAt??b.createdAt;
      const endAt=new Date(Math.min(b.revokedAt?.getTime()??Date.now(),b.qualificationExpiresAt!.getTime()));
      const contactLimit=20_000;
      const contactRows=await db.select().from(museReceiverContactBuckets).where(and(eq(museReceiverContactBuckets.bindingId,bindingId),eq(museReceiverContactBuckets.bindingGeneration,b.generation),sql`${museReceiverContactBuckets.bucketAt} >= ${new Date(Math.floor(startedAt.getTime()/30_000)*30_000).toISOString()}::timestamptz`,sql`${museReceiverContactBuckets.bucketAt} <= ${endAt.toISOString()}::timestamptz`)).orderBy(asc(museReceiverContactBuckets.bucketAt)).limit(contactLimit);
      const contacts=contactRows.map(c=>({...c,timestamps:c.timestamps.filter(at=>Date.parse(at)>=startedAt.getTime()&&Date.parse(at)<=endAt.getTime())})).filter(c=>c.timestamps.length>0);
      const samples=await db.select({id:assignments.id,runId:assignments.runId,issueId:heartbeatRuns.nativeIssueId,status:assignments.status,offeredAt:assignments.offeredAt,claimedAt:assignments.claimedAt,nativeAcceptedAt:assignments.nativeAcceptedAt,acceptedResultAt:assignments.acceptedResultAt,finalizedAt:assignments.finalizedAt,runFinishedAt:heartbeatRuns.finishedAt}).from(assignments).innerJoin(heartbeatRuns,eq(heartbeatRuns.id,assignments.runId)).where(and(eq(assignments.bindingId,bindingId),sql`${assignments.offeredAt} >= ${startedAt.toISOString()}::timestamptz`,sql`${assignments.offeredAt} <= ${endAt.toISOString()}::timestamptz`)).orderBy(asc(assignments.offeredAt)).limit(100);
      const inputRows=await db.select({start:inputs.createdAt,consumedAt:inputs.consumedAt,finishedAt:heartbeatRuns.finishedAt,finalizedAt:assignments.finalizedAt}).from(inputs).innerJoin(assignments,eq(assignments.id,inputs.assignmentId)).innerJoin(heartbeatRuns,eq(heartbeatRuns.id,assignments.runId)).where(and(eq(assignments.agentId,agentId),eq(assignments.companyId,companyId))).limit(1000);
      // An answer remains an immutable audit fact after cancellation. Its busy
      // period ends at consumption or recorded native termination, never just
      // because today's assignment status is fenced. Unknown private/effect
      // activity remains occupied independently, including previous bindings.
      const terminalEnd=(finishedAt:Date|null,finalizedAt:Date|null)=>{
        const times=[finishedAt,finalizedAt].filter((at):at is Date=>at!==null).map(at=>at.getTime());
        return times.length?new Date(Math.min(...times)):null;
      };
      const inputPeriods=inputRows.map(row=>({start:row.start,end:row.consumedAt??terminalEnd(row.finishedAt,row.finalizedAt)}));
      const holdPeriods=await db.select({start:holds.createdAt,end:holds.releasedAt}).from(holds).where(and(eq(holds.companyId,companyId),eq(holds.agentId,agentId),eq(holds.provider,"muse"),sql`(${holds.releasedAt} is null or ${holds.releasedAt} >= ${startedAt.toISOString()}::timestamptz)`)).limit(1000);
      const runPeriods=await db.select({start:heartbeatRuns.startedAt,end:heartbeatRuns.finishedAt}).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,agentId),eq(heartbeatRuns.companyId,companyId),eq(heartbeatRuns.driverKind,"muse_external"),sql`(${heartbeatRuns.finishedAt} is null or ${heartbeatRuns.finishedAt} >= ${startedAt.toISOString()}::timestamptz)`)).limit(1000);
      const idleWindows:Array<{startedAt:string;endedAt:string}>=[];
      // Receiver gaps beyond the 30s persistence interval break idle coverage;
      // the separate cadence qualification still requires 90% of gaps <=7s.
      // Only receiver-observed intervals with no run/assignment/input period
      // count as idle. Missing ingress or bounded-reader overflow proves none.
      if(!b.cadenceEvidenceIncompleteAt&&!contacts.some(c=>c.incomplete)&&contactRows.length<contactLimit&&samples.length<100&&inputPeriods.length<1000&&runPeriods.length<1000&&holdPeriods.length<1000) {
        const minimum=startedAt.getTime(),maximum=Math.min(endAt.getTime(),b.qualificationExpiresAt!.getTime());
        const occupied=[...samples.map(a=>({start:a.offeredAt,end:terminalEnd(a.runFinishedAt,a.finalizedAt)})),...inputPeriods,...runPeriods,...holdPeriods].map(p=>[Math.max(minimum,p.start?.getTime()??minimum),Math.min(maximum,p.end?.getTime()??maximum)] as const).filter(([start,end])=>start<end).sort((a,b)=>a[0]-b[0]);
        const ingress=[...new Set(contacts.flatMap(c=>c.timestamps.map(Date.parse)))].filter(at=>at>=minimum&&at<=maximum).sort((a,b)=>a-b);
        let start=ingress[0],previous=start;
        const append=(from:number,to:number)=>{
          let cursor=from;
          for(const [busyStart,busyEnd]of occupied){if(busyEnd<=cursor||busyStart>=to)continue;if(busyStart>cursor)idleWindows.push({startedAt:new Date(cursor).toISOString(),endedAt:new Date(Math.min(busyStart,to)).toISOString()});cursor=Math.max(cursor,busyEnd);if(cursor>=to)break;}
          if(cursor<to)idleWindows.push({startedAt:new Date(cursor).toISOString(),endedAt:new Date(to).toISOString()});
        };
        for(const at of ingress.slice(1)){if(at-previous>30_000){append(start,previous);start=at;}previous=at;}
        if(start!==undefined)append(start,previous);
      }
      return {detectorCleanup:await detectorEvidence(db,b),qualificationId,startedAt:startedAt.toISOString(),expiresAt:b.qualificationExpiresAt!.toISOString(),stoppedAt:iso(b.revokedAt),deadlineEnforcedAt:iso(b.deadlineEnforcedAt),authorityRevoked:!!b.revokedAt,
        contacts:contacts.map(c=>({trust:"public_untrusted" as const,replicaId:c.replicaId,bucketAt:c.bucketAt.toISOString(),firstAt:c.timestamps[0]!,lastAt:c.timestamps.at(-1)!,contacts:c.timestamps.length,gapsAtMostSevenSeconds:c.gapsAtMostSevenSeconds,maxGapMs:c.maxGapMs,timestamps:c.timestamps,incomplete:c.incomplete})),
        assignments:samples.map(({runFinishedAt:_runFinishedAt,...a})=>({...a,offeredAt:a.offeredAt.toISOString(),claimedAt:iso(a.claimedAt),nativeAcceptedAt:iso(a.nativeAcceptedAt),acceptedResultAt:iso(a.acceptedResultAt),finalizedAt:iso(a.finalizedAt)})),idleWindows,persistenceLagMs:30000,cadenceEvidenceComplete:!b.cadenceEvidenceIncompleteAt&&!contacts.some(c=>c.incomplete)&&contactRows.length<contactLimit&&samples.length<100&&inputPeriods.length<1000&&runPeriods.length<1000&&holdPeriods.length<1000&&!!b.revokedAt};
    },
    async act(s:AgentConnectionSubject,c:MuseCommand):Promise<Record<string,unknown>> {
      if(c.command==="challenge.confirm") {
        const b=await subjectBinding(s,false);
        if(!b.receiverContactAt)throw conflict("No persisted receiver contact yet.");
        const publications: ActivityPublication[] = [];
        await db.transaction(async tx => {
          const [ready]=await tx.update(bindings).set({status:"ready",verifiedReplyAt:new Date(),challengeHash:null,challengeExpiresAt:null,revision:b.revision+1,updatedAt:new Date()}).where(and(eq(bindings.id,b.id),eq(bindings.generation,b.generation),eq(bindings.challengeHash,museCredentialHash(c.nonce)),gt(bindings.challengeExpiresAt,new Date()),isNull(bindings.revokedAt))).returning();
          if(!ready)throw conflict("Challenge expired or does not match.");
          await logActivity(tx as unknown as Db,{companyId:b.companyId,actorType:"agent",actorId:b.agentId,agentId:b.agentId,responsibleUserIdOverride:b.operatorId,action:"muse.background_reply_verified",entityType:"agent",entityId:b.agentId,details:{bindingId:b.id,generation:b.generation,authorizingUserId:b.operatorId,requestId:c.requestId}},publications);
        });
        publications.forEach(publishActivity);
        // The completed challenge changes this hire's verification facts. Clear
        // its deferred retry durably; a wake alone cannot bypass that deadline.
        const lifecycle=createAgentLifecycle(db),agent=await lifecycle.get(b.agentId);
        if(agent&&["preparing","verifying"].includes(agent.lifecycleState)) {
          try { await lifecycle.retry(b.agentId); }
          catch(error) {
            // A concurrent lifecycle completion or Stop owns the newer phase.
            // Confirmation remains accepted; it must not restart that phase.
            const current=error instanceof AgentLifecycleConflict?await lifecycle.get(b.agentId):null;
            if(!current||["preparing","verifying"].includes(current.lifecycleState))throw error;
          }
        }
        return {status:"ready",bindingId:b.id,generation:b.generation};
      }
      if(c.command==="task.create"||c.command==="task.comment")return idleMutation(s,c);
      if(c.command==="work.request"||c.command==="turn.request")return requestWork(s,c);
      const input=c.command==="accept"?{}:c.command==="tool"?{name:c.name,arguments:c.arguments}:c.command==="progress"?{text:c.text}:c.command==="finish"?{result:c.result}:c.command==="renew"?{expiresAtUnixMs:c.expiresAtUnixMs}:c.command==="request_user_input"?{requestId:c.nativeRequestId,questionSet:c.questionSet}:{requestId:c.nativeRequestId,inputDigest:c.inputDigest};
      return operation(s,c.assignmentId,c.requestId,c.command,input,c.command==="consume_input"?{continuationReceiptId:c.continuationReceiptId,continuationPersisted:c.continuationPersisted}:undefined);
    },
    async inspect(s:AgentConnectionSubject,q:MuseQuery):Promise<Record<string,unknown>> {
      const b=await subjectBinding(s,q.query!=="mailbox"&&q.query!=="identify",q.query==="mailbox",q.query==="mailbox");
      if(q.query==="identify") {
        if(q.clientVersion)await db.transaction(tx=>withExternalAdmissionGuard(tx,b.companyId,b.agentId,async()=>{
          const [current]=await tx.select().from(bindings).where(and(eq(bindings.id,b.id),eq(bindings.companyId,s.companyId),eq(bindings.agentId,s.agentId),eq(bindings.generation,s.generation),isNull(bindings.revokedAt))).for("update");
          if(!current)throw forbidden("Muse connection authority is unavailable.");
          await assertMuseSubjectCredential(tx,s,connectionResource());await assertMuseCurrentAuthority(tx,current,true);
          await tx.update(bindings).set({clientVersion:q.clientVersion}).where(and(eq(bindings.id,current.id),eq(bindings.generation,s.generation),isNull(bindings.revokedAt)));
        }));
        return {companyId:b.companyId,agentId:b.agentId,bindingId:b.id,generation:b.generation,authorizingUserId:b.operatorId,idleOperations:["identify","task.list","task.search","task.read","task.history","task.document.read","task.create","task.comment"],usage:null,cost:null};
      }
      if(q.query==="mailbox")return db.transaction(async tx=>{
        const [current]=await tx.select().from(bindings).where(and(eq(bindings.id,b.id),eq(bindings.generation,b.generation),isNull(bindings.revokedAt))).for("update");if(!current)throw forbidden("Binding changed.");
        await assertMuseSubjectCredential(tx,s,s.credentialSource==="oauth"?connectionResource():undefined);
        await assertMuseCurrentAuthority(tx,current,true,true);
        const disabled=!await identity.enabled();
        if(disabled)await assertMuseDisabledStopControlCredential(tx,s,s.credentialSource==="oauth"?connectionResource():undefined);
        const boundaries=tx.select({boundary:holds.stopBoundary}).from(holds).where(inArray(holds.id,museStopControlBoundaryIds(tx,current)));
        const rows=await tx.select().from(mailbox).where(and(eq(mailbox.bindingId,b.id),eq(mailbox.bindingGeneration,b.generation),gt(mailbox.id,q.after),
          disabled?and(eq(mailbox.kind,"authority_revoked"),inArray(sql`${mailbox.references}->'boundary'`,boundaries)):undefined)).orderBy(asc(mailbox.id)).limit(50);
        const cursor=rows.at(-1)?.id??q.after;
        await tx.update(bindings).set({workerCursor:Math.max(current.workerCursor,q.after)}).where(eq(bindings.id,b.id));
        return {bindingId:b.id,generation:b.generation,items:rows,nextCursor:cursor};
      });
      if(q.query==="assignment.read") {const {a}=await authorizeAssignment(s,q.assignmentId);return {assignmentId:a.id,revision:a.revision,status:a.status,...a.projection,accounting:{usage:null,cost:null}};}
      if(q.query==="operation.receipt") return nativeBroker.operationStatus(s,q.assignmentId,q.requestId);
      if(q.query==="input.pending") {const {a}=await authorizeAssignment(s,q.assignmentId);const [delivery]=await db.select().from(inputs).where(and(eq(inputs.assignmentId,a.id),eq(inputs.requestId,q.nativeRequestId),eq(inputs.turnId,a.turnId)));return delivery?{assignmentId:a.id,bindingId:b.id,generation:b.generation,requestId:delivery.requestId,turnId:delivery.turnId,inputDigest:delivery.inputDigest,response:delivery.response,consumed:!!delivery.consumedAt}:{status:"pending"};}
      if(q.query==="task.list"||q.query==="task.search")return listReadableIssues(s,q);
      const issue=await assertIssue(s,q.issueId);
      if(q.query==="task.read")return {task:issue};
      if(q.query==="task.history") {
        const readerSourceTrust=await resolveActorSourceTrustForIssue({db,issue,actor:{actorType:"agent",actorId:s.agentId,agentId:s.agentId,runId:null}});
        const comments=await issueService(db).listComments(issue.id,{limit:100});
        return {comments:isLowTrustQuarantined(readerSourceTrust)?comments:comments.map(sanitizeQuarantinedCommentForHigherTrust)};
      }
      const [document]=await db.select({key:issueDocuments.key,title:documents.title,body:documents.latestBody,revision:documents.latestRevisionNumber,sourceTrust:documents.sourceTrust}).from(issueDocuments).innerJoin(documents,and(eq(documents.id,issueDocuments.documentId),eq(documents.companyId,s.companyId))).where(and(eq(issueDocuments.companyId,s.companyId),eq(issueDocuments.issueId,issue.id),eq(issueDocuments.key,q.key)));
      if(!document)throw notFound("Document not found.");
      const readerSourceTrust=await resolveActorSourceTrustForIssue({db,issue,actor:{actorType:"agent",actorId:s.agentId,agentId:s.agentId,runId:null}});
      return {document:isLowTrustQuarantined(readerSourceTrust)?document:redactQuarantinedBodyForHigherTrust(document)};
    },
    async cleanup(s:AgentConnectionSubject,command:{command:"control.inspect"}|{command:"worker.quiescent";boundary:MuseStopBoundary;requestId:string}) {
      const publications: ActivityPublication[] = [];
      const result = await db.transaction(tx=>withExternalAdmissionGuard(tx,s.companyId,s.agentId,async()=>{
        const binding=await assertMuseCleanupCredential(tx,s,s.credentialSource==="oauth"?connectionResource():undefined);
        const currentIds=museCleanupBoundaryIds(tx,s,!!binding.revokedAt);
        if(command.command==="control.inspect") {
          const rows=await tx.select({boundary:holds.stopBoundary,workerReportedAt:holds.workerReportedAt,nativeEffectsUnknown:holds.nativeEffectsUnknown}).from(holds).where(inArray(holds.id,currentIds));
          if(!binding.revokedAt&&!rows.length)throw forbidden("Cleanup boundary is unavailable.");
          return {boundaries:rows,externalStopConfirmed:false};
        }
        const [hold]=await tx.select().from(holds).where(and(eq(holds.provider,"muse"),eq(holds.companyId,s.companyId),eq(holds.agentId,s.agentId),eq(holds.bindingId,s.bindingId),eq(holds.bindingGeneration,s.generation),eq(holds.assignmentId,command.boundary.assignmentId))).for("update");
        if(!hold?.stopBoundary||externalOperationDigest("tool",{boundary:hold.stopBoundary})!==externalOperationDigest("tool",{boundary:command.boundary}))throw conflict("Cleanup boundary does not match.");
        const [current]=await tx.select({id:holds.id}).from(holds).where(and(eq(holds.id,hold.id),inArray(holds.id,currentIds)));
        if(!current) {
          // Revoked credentials may replay the same durable historical report,
          // but cannot create a new report for released or superseded work.
          const [reported]=s.credentialSource==="legacy"&&binding.revokedAt&&hold.workerReportedAt?await tx.select({id:activityLog.id}).from(activityLog).where(and(eq(activityLog.companyId,s.companyId),eq(activityLog.actorType,"agent"),eq(activityLog.actorId,s.agentId),eq(activityLog.agentId,s.agentId),eq(activityLog.entityType,"agent"),eq(activityLog.entityId,s.agentId),eq(activityLog.action,"muse.worker_quiescence_reported"),
            sql`${activityLog.details}->>'bindingId' = ${s.bindingId}`,
            sql`${activityLog.details}->>'generation' = ${String(s.generation)}`,
            sql`${activityLog.details}->>'authorizingUserId' = ${s.authorizingUserId}`,
            sql`${activityLog.details}->>'requestId' = ${command.requestId}`,
            sql`${activityLog.details}->'boundary' = ${JSON.stringify(command.boundary)}::jsonb`)).limit(1):[];
          if(!reported)throw conflict("Cleanup boundary is unavailable.");
          return {status:"worker_reported",externalStopConfirmed:false,nativeEffectsUnknown:hold.nativeEffectsUnknown};
        }
        if (!hold.workerReportedAt) {
          await tx.update(holds).set({workerReportedAt:new Date(),updatedAt:new Date()}).where(eq(holds.id,hold.id));
          await logActivity(tx as unknown as Db,{companyId:s.companyId,actorType:"agent",actorId:s.agentId,agentId:s.agentId,responsibleUserIdOverride:s.authorizingUserId,action:"muse.worker_quiescence_reported",entityType:"agent",entityId:s.agentId,details:{bindingId:s.bindingId,generation:s.generation,authorizingUserId:s.authorizingUserId,requestId:command.requestId,boundary:command.boundary,nativeEffectsUnknown:hold.nativeEffectsUnknown,externalStopConfirmed:false}},publications);
        }
        return {status:"worker_reported",externalStopConfirmed:false,nativeEffectsUnknown:hold.nativeEffectsUnknown};
      }));
      publications.forEach(publishActivity);
      return result;
    },
    async detectorCleanup(s:AgentConnectionSubject,removed:boolean) {
      const publications: ActivityPublication[] = [];
      await db.transaction(async tx => {
        const [b] = await tx.select().from(bindings).where(and(eq(bindings.id,s.bindingId),eq(bindings.generation,s.generation),eq(bindings.companyId,s.companyId),eq(bindings.agentId,s.agentId))).for("update");
        if (!b) throw forbidden("Cleanup binding changed.");
        if (s.credentialSource === "oauth") {
          await assertMuseCleanupCredential(tx,s,connectionResource());
        } else {
          const now=new Date();
          const [credential]=await tx.select({id:credentials.id}).from(credentials).where(and(
            eq(credentials.id,s.credentialId),eq(credentials.companyId,s.companyId),eq(credentials.bindingId,b.id),
            eq(credentials.bindingGeneration,b.generation),eq(credentials.kind,"detector_cleanup"),
            isNull(credentials.revokedAt),isNull(credentials.consumedAt),gt(credentials.expiresAt,now)));
          if(s.provider!=="muse"||b.operatorId!==s.authorizingUserId||!credential||!b.revokedAt||!b.cleanupExpiresAt||b.cleanupExpiresAt<=now)throw forbidden("Cleanup authority expired.");
        }
        if (removed ? !b.detectorRemovedAt : !b.detectorRemovalRequestedAt) {
          await tx.update(bindings).set({...(removed?{detectorRemovedAt:new Date()}:{detectorRemovalRequestedAt:new Date()}),updatedAt:new Date()}).where(eq(bindings.id,b.id));
          await logActivity(tx as unknown as Db,{companyId:b.companyId,actorType:"agent",actorId:b.agentId,agentId:b.agentId,responsibleUserIdOverride:b.operatorId,action:removed?"muse.detector_removal_reported":"muse.detector_removal_requested",entityType:"agent",entityId:b.agentId,details:{bindingId:b.id,generation:b.generation,authorizingUserId:b.operatorId,externalStopConfirmed:false}},publications);
        }
      });
      publications.forEach(publishActivity);
      return {status:removed?"detector_removed":"detector_removal_requested",externalStopConfirmed:false};
    },
    async authorizingUserIdForBinding(ref:{companyId:string;agentId:string;bindingId:string;bindingGeneration:number}, options: { allowPaused?: boolean } = {}) {
      const [b]=await db.select().from(bindings).where(and(eq(bindings.id,ref.bindingId),eq(bindings.generation,ref.bindingGeneration),eq(bindings.companyId,ref.companyId),eq(bindings.agentId,ref.agentId),isNull(bindings.revokedAt)));
      if(!b||!await identity.enabled())throw forbidden("Muse binding unavailable.");await assertMuseCurrentAuthority(db,b,false,options.allowPaused === true);if((await inspectMuseConnectionCredential(db,b,b.grantId?connectionResource():undefined)).state!=="active")throw forbidden("Muse credential authority is unavailable.");return b.operatorId;
    },
    async assertRunAuthority(execution:Execution,database:Db=db) {const ref=execution.provider.binding;const [b]=await database.select().from(bindings).where(and(eq(bindings.id,ref.bindingId),eq(bindings.generation,ref.bindingGeneration),eq(bindings.companyId,ref.companyId),eq(bindings.agentId,ref.agentId),isNull(bindings.revokedAt)));if(!b||!await museIdentity(database).enabled())throw forbidden("Muse binding unavailable.");await assertMuseCurrentAuthority(database,b);if((await inspectMuseConnectionCredential(database,b,b.grantId?connectionResource():undefined)).state!=="active")throw forbidden("Muse credential authority is unavailable.");const [a]=await database.select().from(assignments).where(and(eq(assignments.runId,execution.binding.runId),eq(assignments.bindingId,b.id),eq(assignments.bindingGeneration,b.generation)));if(!a||a.status==="fenced"||!Number.isFinite(a.expiresAt.getTime())||a.expiresAt.getTime()<=Date.now())throw forbidden("Muse assignment unavailable.");},
    port:(execution:Execution):ExternalProviderPort & Required<Pick<ExternalProviderPort,"inputAvailable">>=>nativeBroker.port(execution),
  };
  async function idleMutation(s:AgentConnectionSubject,c:Extract<MuseCommand,{command:"task.create"|"task.comment"}>,assignToSelf=false) {
    await subjectBinding(s);
    const digest=externalOperationDigest("tool",assignToSelf?{command:c,assigneeAgentId:s.agentId}:{command:c});
    return db.transaction(async tx=>{
      // Task lock precedes admission and binding. Parent creation locks its
      // existing parent first; new issue rows cannot be owned by another tx.
      if(c.command==="task.create")await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${s.companyId}`},0))`);
      const issueId=c.command==="task.comment"?c.issueId:c.parentId;
      if(issueId)await tx.select({id:issues.id}).from(issues).where(and(eq(issues.id,issueId),eq(issues.companyId,s.companyId))).for("update");
      return withExternalAdmissionGuard(tx,s.companyId,s.agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.id,s.bindingId),eq(bindings.generation,s.generation),isNull(bindings.revokedAt))).for("update");
        if(!b)throw forbidden("Muse binding was fenced.");await assertMuseSubjectCredential(tx,s,s.credentialSource==="oauth"?connectionResource():undefined);await assertMuseCurrentAuthority(tx,b);if((await inspectMuseConnectionCredential(tx,b,b.grantId?connectionResource():undefined)).state!=="active")throw forbidden("Muse credential authority is unavailable.");
        const [old]=await tx.select().from(idleReceipts).where(and(eq(idleReceipts.bindingId,b.id),eq(idleReceipts.bindingGeneration,b.generation),eq(idleReceipts.requestId,c.requestId)));
        if(old){if(old.digest!==digest)throw conflict("Request ID reused with changed input.");if(typeof old.outcome.issueId==="string")await assertIssue(s,old.outcome.issueId);return old.outcome;}
        const authorization=authorizationService(tx as unknown as Db);
        const actors=[agentActor(s),authorizerActor(s)];
        const assertWrite=async(issue:typeof issues.$inferSelect,action:"issue:comment"|"issue:mutate")=>{
          const resource={type:"issue" as const,companyId:s.companyId,issueId:issue.id,projectId:issue.projectId,parentIssueId:issue.parentId,
            status:issue.status,assigneeAgentId:issue.assigneeAgentId,assigneeUserId:issue.assigneeUserId,originKind:issue.originKind,originId:issue.originId};
          for(const actor of actors){const decision=await authorization.decide({actor,action,resource});if(!decision.allowed)throw forbidden(decision.explanation);}
        };
        let outcome:Record<string,unknown>;
        if(c.command==="task.comment") {
          const issue=await assertIssue(s,c.issueId,undefined,tx);
          await assertWrite(issue,"issue:comment");
          const sourceTrust=await resolveActorSourceTrustForIssue({db:tx as unknown as Db,issue,actor:{actorType:"agent",actorId:s.agentId,agentId:s.agentId,runId:null}});
          const comment=await issueService(db).addComment(c.issueId,c.body,{agentId:s.agentId,onBehalfOfUserId:s.authorizingUserId},{sourceTrust},tx);
          outcome={status:"commented",issueId:c.issueId,commentId:comment.id};
        } else {
          const parent=c.parentId?await assertIssue(s,c.parentId,undefined,tx):null;
          if(parent)await assertWrite(parent,"issue:mutate");
          const projectId=c.projectId??parent?.projectId??null;
          const scope={projectId,parentIssueId:c.parentId??null,assigneeAgentId:assignToSelf?s.agentId:null,assigneeUserId:null};
          for(const actor of actors){
            if(projectId){const projectAccess=await authorization.decide({actor,action:"project:read",resource:{type:"project",companyId:s.companyId,projectId}});if(!projectAccess.allowed)throw forbidden(projectAccess.explanation);}
            const decision=await authorization.decide({actor,action:"tasks:assign",resource:{type:"issue",companyId:s.companyId,...scope},scope});
            if(!decision.allowed)throw forbidden(decision.explanation);
          }
          const [agent]=await tx.select({companyId:agents.companyId,permissions:agents.permissions}).from(agents).where(and(eq(agents.id,s.agentId),eq(agents.companyId,s.companyId)));
          const project=projectId?(await tx.select({companyId:projects.companyId,executionWorkspacePolicy:projects.executionWorkspacePolicy}).from(projects).where(and(eq(projects.id,projectId),eq(projects.companyId,s.companyId))))[0]:null;
          const trust=resolveCoreTrustPreset({companyId:s.companyId,agent,project,issue:parent});
          if(trust.kind==="denied")throw forbidden(trust.detail);
          const issueId=randomUUID();
          const issue=await issueService(tx as unknown as Db).create(s.companyId,{id:issueId,title:c.title,description:c.description,parentId:c.parentId,projectId,status:"todo",assigneeAgentId:scope.assigneeAgentId,createdByAgentId:s.agentId,responsibleUserId:s.authorizingUserId,actorResponsibleUserId:s.authorizingUserId,
            ...(trust.kind==="low_trust_review"?{executionPolicy:{...normalizeIssueExecutionPolicy({authorizationPolicy:{trustPreset:trust.preset,trustBoundary:trust.boundary}})},sourceTrust:buildLowTrustSourceTrust({issueId,agentId:s.agentId})}:{}),
          },tx);
          outcome={status:"created",issueId:issue.id,identifier:issue.identifier};
        }
        await tx.insert(idleReceipts).values({companyId:s.companyId,bindingId:b.id,bindingGeneration:b.generation,requestId:c.requestId,digest,outcome});
        await logActivity(tx as unknown as Db,{companyId:s.companyId,actorType:"agent",actorId:s.agentId,action:`muse.${c.command}`,entityType:"issue",entityId:String(outcome.issueId),details:{authorizingUserId:s.authorizingUserId,requestId:c.requestId}});
        return outcome;
      });
    });
  }
  async function requestWork(s:AgentConnectionSubject,c:Extract<MuseCommand,{command:"work.request"|"turn.request"}>) {
    const b=await subjectBinding(s);
    const requestKey=`muse-work:${b.id}:${b.generation}:${c.requestId}`;
    const requestDigest=externalOperationDigest("tool",{command:c});
    let issueId:string;
    if(c.command==="turn.request") {
      // Reserve and assign ordinary intake in the same task transaction, with
      // both principals checked against the exact self-assignment scope.
      const result=await idleMutation(s,{version:1,command:"task.create",requestId:c.requestId,title:c.prompt.slice(0,500),description:c.prompt},true);
      issueId=String(result.issueId);
    } else issueId=c.issueId;
    const receipt=async()=>(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,s.companyId),eq(agentWakeupRequests.agentId,s.agentId),eq(agentWakeupRequests.idempotencyKey,requestKey))).limit(1))[0];
    const replay=async(row:typeof agentWakeupRequests.$inferSelect)=>{
      if(row.source!=="assignment"||row.requestedByActorType!=="agent"||row.requestedByActorId!==s.agentId||row.payload?.issueId!==issueId||row.payload?.museRequestId!==c.requestId||row.payload?.museBindingId!==b.id||row.payload?.museBindingGeneration!==b.generation||row.payload?.museRequestDigest!==requestDigest)throw conflict("Request ID reused with changed input.");
      await assertIssue(s,issueId);
      const [run]=row.runId?await db.select({status:heartbeatRuns.status}).from(heartbeatRuns).where(and(eq(heartbeatRuns.id,row.runId),eq(heartbeatRuns.companyId,s.companyId),eq(heartbeatRuns.agentId,s.agentId))):[];
      if(run&&["failed","cancelled","timed_out"].includes(run.status))return {status:"admission_failed",issueId,runId:row.runId,admissionStatus:run.status};
      return {status:"requested",issueId,runId:row.runId};
    };
    // A retry reads its original receipt even after task completion. It never
    // creates fresh admission authority or a replacement run.
    const prior=await receipt();if(prior)return replay(prior);
    const issue=await assertIssue(s,issueId);
    if(issue.assigneeAgentId!==s.agentId||!["todo","in_progress"].includes(issue.status))throw conflict("Request work only for an eligible task assigned to this Muse agent.");
    const hex=createHash("sha256").update(requestKey).digest("hex");
    const receiptId=`${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-${((parseInt(hex[16]!,16)&3)|8).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`;
    try {
      // The existing wake receipt PK reserves identity in the same transaction
      // as its queued run, including requests competing under different issues.
      const run=await(await heartbeat()).wakeup(s.agentId,{source:"assignment",triggerDetail:"system",reason:"issue_assigned",payload:{issueId,museRequestId:c.requestId,museBindingId:b.id,museBindingGeneration:b.generation,museRequestDigest:requestDigest},contextSnapshot:{issueId},idempotencyKey:requestKey,requestedByActorType:"agent",requestedByActorId:s.agentId,allowRunCoalescing:false,
        durableMuseRequest:{id:receiptId,companyId:s.companyId,agentId:s.agentId,issueId,requestId:c.requestId,idempotencyKey:requestKey,requestedAt:new Date(),bindingId:b.id,bindingGeneration:b.generation,requestDigest}});
      const reserved=await receipt();return reserved?replay(reserved):{status:"requested",issueId,runId:run?.id??null};
    } catch(error) {
      // Replay only this reservation's unique-key race, never an unrelated DB
      // failure or an uncertain native effect.
      let cause:unknown=error;
      for(let depth=0;depth<5&&cause&&typeof cause==="object";depth++){
        if((cause as {code?:string}).code==="23505"){const reserved=await receipt();if(reserved?.id===receiptId)return replay(reserved);break;}
        cause=(cause as {cause?:unknown}).cause;
      }
      throw error;
    }
  }
  return broker;
}
