import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { agents, companies, heartbeatRuns, issues, issueComments, issueDocuments, documents, nativeRunFinalizations, agentWakeupRequests,
  museAgentBindings as bindings, museCredentials as credentials, museRunnerAssignments as assignments, museRunnerOperations as operations,
  museMailboxItems as mailbox, museInputDeliveries as inputs, museIdleReceipts as idleReceipts, externalAgentHolds as holds,
  museReceiverContactBuckets, type Db } from "@paperclipai/db";
import { MUSE_TICKET_TTL_MS, MUSE_CLEANUP_TTL_MS, museStopBoundarySchema, type AgentConnectionSubject, type MuseBinding, type MuseCommand,
  type MuseQuery, type MusePairing, type MuseStopBoundary, type MuseQualificationEvidence, type MuseQualificationBeginResult } from "@paperclipai/shared";
import { externalOperationDigest, parsePaperclipQuestionSet, type MuseBindingSnapshot, type ExternalProviderPort, type ExternalProviderOperation } from "../../vendor/paperclip-runner/index.js";
import { conflict, forbidden, notFound } from "../../errors.js";
import { museIdentity, museCredentialHash, assertMuseCurrentAuthority } from "../../services/muse-identity.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { updateAgentConfigurationInTransaction } from "../../services/agent-configuration-transaction.js";
import { canConfigureAgentConnection, scheduleAgentLifecycle } from "../agent-lifecycle/index.js";
import { authorizationService, issueReadSqlCondition, type AuthorizationActor } from "../../services/authorization.js";
import { logActivity } from "../../services/activity-log.js";
import { issueService } from "../../services/issues.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext } from "../../services/native-runtime/native-review-participant.js";
import { withExternalAdmissionGuard, assertNoExternalOverlap, type ExternalAdmissionTransaction } from "./admission.js";
import { createNativeExternalBroker } from "./native-broker.js";
import { consumeMuseHistoryReceipt } from "../../services/muse-assignment-follow-up.js";
import type { heartbeatService } from "../../services/heartbeat.js";
import { buildMuseSetupInstruction } from "../../services/muse-setup.js";

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
  async function heartbeat() { const configured=heartbeatContexts.get(db); if(configured)return configured; return (await import("../../services/heartbeat.js")).heartbeatService(db); }
  function agentActor(s:AgentConnectionSubject,runId?:string,responsibleUserId?:string|null):AuthorizationActor {return {type:"agent",agentId:s.agentId,companyId:s.companyId,runId,authorizingUserId:s.authorizingUserId,onBehalfOfUserId:responsibleUserId};}
  function authorizerActor(s:AgentConnectionSubject):AuthorizationActor { return {type:"board",userId:s.authorizingUserId,source:"session",ignoreInstanceAdmin:true}; }
  async function subjectBinding(s:AgentConnectionSubject,ready=true,paused=false) {
    const [b]=await db.select().from(bindings).where(and(eq(bindings.id,s.bindingId),eq(bindings.companyId,s.companyId),eq(bindings.agentId,s.agentId),eq(bindings.generation,s.generation),eq(bindings.operatorId,s.authorizingUserId),isNull(bindings.revokedAt)));
    const [c]=await db.select({id:credentials.id}).from(credentials).where(and(eq(credentials.id,s.credentialId),eq(credentials.bindingId,s.bindingId),eq(credentials.bindingGeneration,s.generation),eq(credentials.kind,"access"),isNull(credentials.revokedAt),isNull(credentials.consumedAt),gt(credentials.expiresAt,new Date())));
    if(s.provider!=="muse" || !b || !c || !await identity.enabled()) throw forbidden("Muse normal authority is unavailable.");
    if(b.qualificationExpiresAt && b.qualificationExpiresAt<=new Date()) { await broker.endQualification({companyId:b.companyId,agentId:b.agentId,bindingId:b.id,qualificationId:b.qualificationId!,operatorId:b.operatorId}); throw forbidden("Qualification deadline elapsed."); }
    await assertMuseCurrentAuthority(db,b,!ready,paused);
    return b;
  }
  async function visible(s:AgentConnectionSubject,database:Db|ExternalAdmissionTransaction=db):Promise<SQL> {
    return issueReadSqlCondition(database,agentActor(s));
  }
  async function assertIssue(s:AgentConnectionSubject,issueId:string,runResponsibleUserId?:string|null) {
    const conditions=[eq(issues.companyId,s.companyId),eq(issues.id,issueId),await issueReadSqlCondition(db,agentActor(s,undefined,runResponsibleUserId)),isNull(issues.hiddenAt),isNull(issues.harnessKind)];
    const [issue]=await db.select().from(issues).where(and(...conditions));
    if(!issue) throw notFound("Task is unavailable to the current Muse agent and authorizer.");
    return issue;
  }
  async function authorizeAssignment(s:AgentConnectionSubject,id:string,allowSettled=false) {
    const b=await subjectBinding(s);
    const [a]=await db.select().from(assignments).where(and(eq(assignments.id,id),eq(assignments.companyId,s.companyId),eq(assignments.agentId,s.agentId),eq(assignments.bindingId,b.id),eq(assignments.bindingGeneration,b.generation)));
    if(!a || a.status==="fenced" || (!allowSettled && a.status==="settled") || (!allowSettled && a.expiresAt<=new Date())) throw forbidden("Assignment authority expired or was fenced.");
    const [run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,a.runId),eq(heartbeatRuns.companyId,a.companyId),eq(heartbeatRuns.agentId,a.agentId)));
    if(run?.nativeIssueId) await assertIssue(s,run.nativeIssueId,run.responsibleUserId);
    if(a.status==="settled" && allowSettled) return {b,a,run};
    const [owner]=await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId,a.runId),eq(nativeRunFinalizations.companyId,a.companyId)));
    const [company]=await db.select().from(companies).where(eq(companies.id,a.companyId));
    const [agent]=await db.select().from(agents).where(eq(agents.id,a.agentId));
    const issue=run?.nativeIssueId?await assertIssue(s,run.nativeIssueId,run.responsibleUserId):null;
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
  const nativeBroker=createNativeExternalBroker<AgentConnectionSubject>(db,"muse",{enabled:identity.enabled,authorize:async(s,id,settled)=>{const {b,a}=await authorizeAssignment(s,id,settled);return {binding:b,assignment:a};}});
  const operation=nativeBroker.operation;
  const broker={
    enabled:identity.enabled,
    async createPairing(input:{companyId:string;agentId:string;operatorId:string;replaceBindingId?:string;expectedRevision?:number}):Promise<MusePairing> {
      if(!await identity.enabled())throw forbidden("Enable Muse and Paperclip Runner before connecting.");
      const ticket=randomBytes(32).toString("base64url"),bindingId=randomUUID();
      // Validate the public assets before changing any existing invitation.
      const setupInstruction=await buildMuseSetupInstruction(publicOrigin,ticket,bindingId);
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
          await tx.update(credentials).set({expiresAt:new Date(Date.now()+MUSE_CLEANUP_TTL_MS)}).where(and(eq(credentials.bindingId,old.id),inArray(credentials.kind,["cleanup","detector_cleanup"]),isNull(credentials.revokedAt)));
        } else if(input.replaceBindingId)throw conflict("Invitation changed. Refresh before replacing its ticket.");
        const [latest]=await tx.select({generation:bindings.generation}).from(bindings).where(and(eq(bindings.companyId,input.companyId),eq(bindings.agentId,input.agentId))).orderBy(desc(bindings.generation)).limit(1);
        const [created]=await tx.insert(bindings).values({id:bindingId,companyId:input.companyId,agentId:input.agentId,operatorId:input.operatorId,generation:(latest?.generation??0)+1,ticketHash:museCredentialHash(ticket),ticketExpiresAt:new Date(Date.now()+MUSE_TICKET_TTL_MS)}).returning();
        await logActivity(tx as unknown as Db,{companyId:input.companyId,actorType:"user",actorId:input.operatorId,action:"muse.pairing_created",entityType:"agent",entityId:input.agentId,details:{bindingId:created!.id,generation:created!.generation}});
        await updateAgentConfigurationInTransaction(tx as unknown as Db,agent.id,{adapterConfig:{...agent.adapterConfig,museBindingId:created!.id}},{recordRevision:{createdByUserId:input.operatorId,source:"muse-pairing"}});
        return {binding:created!,replacedRuns};
      }));
      await Promise.all(replacedRuns.map(async runId=>{await nativeBroker.revokeRun(runId);await(await heartbeat()).cancelRun(runId,"Muse connection replaced");}));
      return {bindingId:b.id,generation:b.generation,revision:b.revision,ticket,expiresAt:b.ticketExpiresAt!.toISOString(),assetVersion:1,setupInstruction};
    },
    async bindingForAgent(companyId:string,agentId:string):Promise<MuseBinding|null> {
      const [b]=await db.select().from(bindings).where(and(eq(bindings.companyId,companyId),eq(bindings.agentId,agentId))).orderBy(desc(bindings.generation)).limit(1);
      if(!b)return null;
      const live=await db.select({id:assignments.id}).from(assignments).where(and(eq(assignments.companyId,companyId),eq(assignments.agentId,agentId),inArray(assignments.status,["offered","claimed","accepted"])));
      const unknown=await db.select({id:operations.id}).from(operations).innerJoin(assignments,eq(assignments.id,operations.assignmentId)).where(and(eq(assignments.companyId,companyId),eq(assignments.agentId,agentId),inArray(operations.status,["unknown","dispatched","pending"])));
      const pending=await db.select({id:inputs.id}).from(inputs).innerJoin(assignments,eq(assignments.id,inputs.assignmentId)).where(and(eq(assignments.companyId,companyId),eq(assignments.agentId,agentId),isNull(inputs.consumedAt)));
      const [stop]=await db.select().from(holds).where(and(eq(holds.companyId,companyId),eq(holds.agentId,agentId),eq(holds.provider,"muse"),isNull(holds.releasedAt))).orderBy(desc(holds.createdAt)).limit(1);
      const [stopBinding]=stop?.stopBoundary ? await db.select({revision:bindings.revision}).from(bindings).where(and(eq(bindings.id,stop.stopBoundary.bindingId),eq(bindings.generation,stop.stopBoundary.generation),eq(bindings.companyId,companyId),eq(bindings.agentId,agentId))) : [];
      return {id:b.id,generation:b.generation,revision:b.revision,status:b.status,paired:!!b.pairedAt,receiverDetected:!!b.receiverContactAt,backgroundReplyVerified:!!b.verifiedReplyAt,
        pairingExpiresAt:iso(b.ticketExpiresAt),challengeExpiresAt:iso(b.challengeExpiresAt),lastReceiverContactAt:iso(b.receiverContactAt),lastWorkerActivityAt:iso(b.workerActivityAt),lastVerifiedReplyAt:iso(b.verifiedReplyAt),contactPersistenceLagMs:30000,clientVersion:b.clientVersion,
        qualification:b.qualificationId&&b.qualificationExpiresAt?{id:b.qualificationId,expiresAt:b.qualificationExpiresAt.toISOString()}:null,
        liveAssignments:live.length,uncertainOperations:unknown.length,pendingInputs:pending.length,
        cleanup:{detectorRemovalRequested:!!b.detectorRemovalRequestedAt,pending:!!b.cleanupExpiresAt&&b.cleanupExpiresAt>new Date()&&(!b.detectorRemovedAt||!!stop),detectorRemoved:!!b.detectorRemovedAt,workerQuiescenceReported:!!stop?.workerReportedAt,expiresAt:iso(b.cleanupExpiresAt)},
        stop:{status:!stop?.stopBoundary?"none":stop.operatorAttestedAt?"operator_attested":stop.workerReportedAt?"worker_reported":"cannot_confirm",nativeEffectsUnknown:!!stop?.nativeEffectsUnknown,boundary:stop?.stopBoundary??null,bindingRevision:stopBinding?.revision??null}};
    },
    async snapshot(companyId:string,agentId:string,bindingId:string):Promise<MuseBindingSnapshot> {
      if(!await identity.enabled())throw forbidden("Muse is disabled for new work.");
      const [b]=await db.select().from(bindings).where(and(eq(bindings.id,bindingId),eq(bindings.companyId,companyId),eq(bindings.agentId,agentId),isNull(bindings.revokedAt)));
      if(!b||b.status!=="ready"||!b.receiverContactAt||!b.verifiedReplyAt)throw conflict("Pair Muse, detect its receiver, and verify an independent background reply first.");
      if(b.qualificationExpiresAt&&b.qualificationExpiresAt<=new Date()){await broker.endQualification({companyId,agentId,bindingId,qualificationId:b.qualificationId!,operatorId:b.operatorId});throw conflict("Qualification deadline elapsed.");}
      await assertMuseCurrentAuthority(db,b);
      return {companyId,agentId,bindingId,bindingGeneration:b.generation,acceptByUnixMs:Date.now()+10*60_000,expiresAtUnixMs:Math.min(Date.now()+2*60*60_000,b.qualificationExpiresAt?.getTime()??Infinity)};
    },
    async verify(companyId:string,agentId:string,input:{bindingId:string;generation:number;expectedRevision:number}) {
      if(!await identity.enabled())throw forbidden("Muse is disabled.");
      const nonce=randomBytes(24).toString("base64url");
      return db.transaction(tx=>withExternalAdmissionGuard(tx,companyId,agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.id,input.bindingId),eq(bindings.companyId,companyId),eq(bindings.agentId,agentId),eq(bindings.generation,input.generation),eq(bindings.revision,input.expectedRevision),isNull(bindings.revokedAt))).for("update");
        if(!b||!b.pairedAt||!b.receiverContactAt)throw conflict("Pair Muse and detect the receiver before verifying.");
        await assertMuseCurrentAuthority(tx,b,true);
        if(b.challengeHash&&b.challengeExpiresAt&&b.challengeExpiresAt>new Date())return {bindingId:b.id,generation:b.generation,revision:b.revision,expiresAt:b.challengeExpiresAt.toISOString(),status:"pending" as const};
        const expiry=new Date(Date.now()+10*60_000);
        await tx.update(bindings).set({challengeHash:museCredentialHash(nonce),challengeExpiresAt:expiry,revision:b.revision+1,updatedAt:new Date()}).where(eq(bindings.id,b.id));
        await tx.insert(mailbox).values({companyId,bindingId:b.id,bindingGeneration:b.generation,kind:"readiness_challenge",sourceEventId:`muse-challenge:${randomUUID()}`,references:{nonce}});
        return {bindingId:b.id,generation:b.generation,revision:b.revision+1,expiresAt:expiry.toISOString(),status:"pending" as const};
      }));
    },
    async revoke(companyId:string,agentId:string,operatorId:string,input?:{bindingId:string;generation:number;expectedRevision:number}) {
      const runs=await db.transaction(tx=>withExternalAdmissionGuard(tx,companyId,agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.companyId,companyId),eq(bindings.agentId,agentId),input?eq(bindings.id,input.bindingId):undefined,isNull(bindings.revokedAt))).for("update");
        if(!b)return [];
        if(input&&(b.generation!==input.generation||b.revision!==input.expectedRevision))throw conflict("Connection changed; refresh before disconnecting.");
        const runs=await fence(tx,b,"disconnect");
        await tx.update(bindings).set({status:"revoked",revokedAt:new Date(),ticketHash:null,challengeHash:null,cleanupExpiresAt:new Date(Date.now()+MUSE_CLEANUP_TTL_MS),deadlineEnforcedAt:b.deadlineEnforcedAt??(b.qualificationExpiresAt&&b.qualificationExpiresAt<=new Date()?new Date():null),revision:b.revision+1,updatedAt:new Date()}).where(eq(bindings.id,b.id));
        await tx.update(credentials).set({revokedAt:new Date()}).where(and(eq(credentials.bindingId,b.id),inArray(credentials.kind,["access","refresh","signal"])));
        await tx.update(credentials).set({expiresAt:new Date(Date.now()+MUSE_CLEANUP_TTL_MS)}).where(and(eq(credentials.bindingId,b.id),inArray(credentials.kind,["cleanup","detector_cleanup"]),isNull(credentials.revokedAt)));
        await logActivity(tx as unknown as Db,{companyId,actorType:"user",actorId:operatorId,action:"muse.binding_revoked",entityType:"agent",entityId:agentId,details:{bindingId:b.id,generation:b.generation,externalStopConfirmed:false}});
        return runs;
      }));
      await Promise.all(runs.map(async runId=>{await nativeBroker.revokeRun(runId);await(await heartbeat()).cancelRun(runId,"Muse connection revoked");}));
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
    async reconcileTerminalAssignments(companyId:string,agentId:string,bindingId:string) {
      await db.transaction(tx=>withExternalAdmissionGuard(tx,companyId,agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.id,bindingId),eq(bindings.companyId,companyId),eq(bindings.agentId,agentId))).for("update");if(!b)return;
        const terminal=await tx.select({a:assignments,run:heartbeatRuns}).from(assignments).innerJoin(heartbeatRuns,eq(heartbeatRuns.id,assignments.runId)).where(and(eq(assignments.bindingId,b.id),inArray(heartbeatRuns.status,["succeeded","failed","cancelled","timed_out","interrupted"])));
        for(const {a,run}of terminal) {
          if(a.status==="settled"&&a.acceptedResultAt) {
            await tx.update(assignments).set({finalizedAt:run.finishedAt}).where(eq(assignments.id,a.id));
            const [unknown]=await tx.select({id:operations.id}).from(operations).where(and(eq(operations.assignmentId,a.id),inArray(operations.status,["unknown","dispatched","pending"]))).limit(1);
            if(run.status!=="succeeded"||unknown) {await fence(tx,b,"run_terminal_after_result");continue;}
            if(!unknown&&run.status==="succeeded")await tx.update(holds).set({workerUnknown:false,releasedAt:new Date(),updatedAt:new Date()}).where(and(eq(holds.provider,"muse"),eq(holds.assignmentId,a.id),eq(holds.nativeEffectsUnknown,false)));
          } else if(["offered","claimed","accepted"].includes(a.status)) await fence(tx,b,"run_terminal");
        }
      }));
    },
    async beginQualification(input:{companyId:string;agentId:string;bindingId:string;generation:number;expectedRevision:number;qualificationId:string;expiresAt:Date;operatorId:string}) {
      if(input.expiresAt<=new Date()||input.expiresAt.getTime()>Date.now()+24*60*60_000)throw conflict("Qualification requires a bounded future deadline of at most 24 hours.");
      return db.transaction(tx=>withExternalAdmissionGuard(tx,input.companyId,input.agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.id,input.bindingId),eq(bindings.companyId,input.companyId),eq(bindings.agentId,input.agentId),eq(bindings.generation,input.generation),eq(bindings.revision,input.expectedRevision),eq(bindings.status,"ready"),isNull(bindings.revokedAt))).for("update");
        if(!b) {
          const [same]=await tx.select().from(bindings).where(and(eq(bindings.id,input.bindingId),eq(bindings.companyId,input.companyId),eq(bindings.agentId,input.agentId),eq(bindings.qualificationId,input.qualificationId)));
          if(same?.qualificationStartedAt&&same.qualificationExpiresAt)return {qualificationId:input.qualificationId,startedAt:same.qualificationStartedAt.toISOString(),expiresAt:same.qualificationExpiresAt.toISOString(),revision:same.revision};
          throw conflict("Connection changed or qualification already exists.");
        }
        if(b.qualificationId===input.qualificationId&&b.qualificationStartedAt&&b.qualificationExpiresAt)return {qualificationId:input.qualificationId,startedAt:b.qualificationStartedAt.toISOString(),expiresAt:b.qualificationExpiresAt.toISOString(),revision:b.revision};
        if(b.qualificationId)throw conflict("Another qualification already exists.");
        await assertMuseCurrentAuthority(tx,b);
        await tx.update(bindings).set({qualificationId:input.qualificationId,qualificationStartedAt:new Date(input.expiresAt.getTime()-24*60*60_000),qualificationExpiresAt:input.expiresAt,revision:b.revision+1,updatedAt:new Date()}).where(eq(bindings.id,b.id));
        return {qualificationId:input.qualificationId,startedAt:new Date(input.expiresAt.getTime()-24*60*60_000).toISOString(),expiresAt:input.expiresAt.toISOString(),revision:b.revision+1};
      }));
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
      const samples=await db.select({id:assignments.id,runId:assignments.runId,issueId:heartbeatRuns.nativeIssueId,status:assignments.status,offeredAt:assignments.offeredAt,claimedAt:assignments.claimedAt,nativeAcceptedAt:assignments.nativeAcceptedAt,acceptedResultAt:assignments.acceptedResultAt,finalizedAt:assignments.finalizedAt}).from(assignments).innerJoin(heartbeatRuns,eq(heartbeatRuns.id,assignments.runId)).where(and(eq(assignments.bindingId,bindingId),sql`${assignments.offeredAt} >= ${startedAt.toISOString()}::timestamptz`,sql`${assignments.offeredAt} <= ${endAt.toISOString()}::timestamptz`)).orderBy(asc(assignments.offeredAt)).limit(100);
      const inputPeriods=await db.select({start:inputs.createdAt,end:inputs.consumedAt}).from(inputs).innerJoin(assignments,eq(assignments.id,inputs.assignmentId)).where(and(eq(assignments.agentId,agentId),eq(assignments.companyId,companyId))).limit(1000);
      const runPeriods=await db.select({start:heartbeatRuns.startedAt,end:heartbeatRuns.finishedAt}).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,agentId),eq(heartbeatRuns.companyId,companyId),eq(heartbeatRuns.driverKind,"muse_external"),sql`(${heartbeatRuns.finishedAt} is null or ${heartbeatRuns.finishedAt} >= ${startedAt.toISOString()}::timestamptz)`)).limit(1000);
      const idleWindows:Array<{startedAt:string;endedAt:string}>=[];
      // Receiver gaps beyond the 30s persistence interval break idle coverage;
      // the separate cadence qualification still requires 90% of gaps <=7s.
      // Only receiver-observed intervals with no run/assignment/input period
      // count as idle. Missing ingress or bounded-reader overflow proves none.
      if(!b.cadenceEvidenceIncompleteAt&&!contacts.some(c=>c.incomplete)&&contactRows.length<contactLimit&&samples.length<100&&inputPeriods.length<1000&&runPeriods.length<1000) {
        const minimum=startedAt.getTime(),maximum=Math.min(endAt.getTime(),b.qualificationExpiresAt!.getTime());
        const occupied=[...samples.map(a=>({start:a.offeredAt,end:a.finalizedAt})),...inputPeriods,...runPeriods].map(p=>[Math.max(minimum,p.start?.getTime()??minimum),Math.min(maximum,p.end?.getTime()??maximum)] as const).filter(([start,end])=>start<end).sort((a,b)=>a[0]-b[0]);
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
      return {qualificationId,startedAt:startedAt.toISOString(),expiresAt:b.qualificationExpiresAt!.toISOString(),stoppedAt:iso(b.revokedAt),deadlineEnforcedAt:iso(b.deadlineEnforcedAt),authorityRevoked:!!b.revokedAt,
        contacts:contacts.map(c=>({replicaId:c.replicaId,bucketAt:c.bucketAt.toISOString(),firstAt:c.timestamps[0]!,lastAt:c.timestamps.at(-1)!,contacts:c.timestamps.length,gapsAtMostSevenSeconds:c.gapsAtMostSevenSeconds,maxGapMs:c.maxGapMs,timestamps:c.timestamps,incomplete:c.incomplete})),
        assignments:samples.map(a=>({...a,offeredAt:a.offeredAt.toISOString(),claimedAt:iso(a.claimedAt),nativeAcceptedAt:iso(a.nativeAcceptedAt),acceptedResultAt:iso(a.acceptedResultAt),finalizedAt:iso(a.finalizedAt)})),idleWindows,persistenceLagMs:30000,cadenceEvidenceComplete:!b.cadenceEvidenceIncompleteAt&&!contacts.some(c=>c.incomplete)&&contactRows.length<contactLimit&&samples.length<100&&inputPeriods.length<1000&&runPeriods.length<1000&&!!b.revokedAt};
    },
    async act(s:AgentConnectionSubject,c:MuseCommand):Promise<Record<string,unknown>> {
      if(c.command==="challenge.confirm") {
        const b=await subjectBinding(s,false);
        if(!b.receiverContactAt)throw conflict("No persisted receiver contact yet.");
        const [ready]=await db.update(bindings).set({status:"ready",verifiedReplyAt:new Date(),challengeHash:null,challengeExpiresAt:null,revision:b.revision+1,updatedAt:new Date()}).where(and(eq(bindings.id,b.id),eq(bindings.generation,b.generation),eq(bindings.challengeHash,museCredentialHash(c.nonce)),gt(bindings.challengeExpiresAt,new Date()),isNull(bindings.revokedAt))).returning();
        if(!ready)throw conflict("Challenge expired or does not match.");
        void scheduleAgentLifecycle(db,b.agentId);
        return {status:"ready",bindingId:b.id,generation:b.generation};
      }
      if(c.command==="task.create"||c.command==="task.comment")return idleMutation(s,c);
      if(c.command==="work.request"||c.command==="turn.request")return requestWork(s,c);
      const input=c.command==="accept"?{}:c.command==="tool"?{name:c.name,arguments:c.arguments}:c.command==="progress"?{text:c.text}:c.command==="finish"?{result:c.result}:c.command==="renew"?{expiresAtUnixMs:c.expiresAtUnixMs}:c.command==="request_user_input"?{requestId:c.nativeRequestId,questionSet:c.questionSet}:{requestId:c.nativeRequestId,inputDigest:c.inputDigest};
      return operation(s,c.assignmentId,c.requestId,c.command,input,c.command==="consume_input"?{continuationReceiptId:c.continuationReceiptId,continuationPersisted:c.continuationPersisted}:undefined);
    },
    async inspect(s:AgentConnectionSubject,q:MuseQuery):Promise<Record<string,unknown>> {
      const b=await subjectBinding(s,q.query!=="mailbox"&&q.query!=="identify",q.query==="mailbox");
      if(q.query==="identify")return {companyId:b.companyId,agentId:b.agentId,bindingId:b.id,generation:b.generation,authorizingUserId:b.operatorId,idleOperations:["identify","task.list","task.search","task.read","task.history","task.document.read","task.create","task.comment"],usage:null,cost:null};
      if(q.query==="mailbox")return db.transaction(async tx=>{
        const [current]=await tx.select().from(bindings).where(and(eq(bindings.id,b.id),eq(bindings.generation,b.generation),isNull(bindings.revokedAt))).for("update");if(!current)throw forbidden("Binding changed.");
        const rows=await tx.select().from(mailbox).where(and(eq(mailbox.bindingId,b.id),eq(mailbox.bindingGeneration,b.generation),gt(mailbox.id,q.after))).orderBy(asc(mailbox.id)).limit(50);
        const cursor=rows.at(-1)?.id??q.after;
        await tx.update(bindings).set({workerCursor:Math.max(current.workerCursor,q.after)}).where(eq(bindings.id,b.id));
        return {bindingId:b.id,generation:b.generation,items:rows,nextCursor:cursor};
      });
      if(q.query==="assignment.read") {const {a}=await authorizeAssignment(s,q.assignmentId);return {assignmentId:a.id,revision:a.revision,status:a.status,...a.projection,accounting:{usage:null,cost:null}};}
      if(q.query==="operation.receipt") return nativeBroker.operationStatus(s,q.assignmentId,q.requestId);
      if(q.query==="input.pending") {const {a}=await authorizeAssignment(s,q.assignmentId);const [delivery]=await db.select().from(inputs).where(and(eq(inputs.assignmentId,a.id),eq(inputs.requestId,q.nativeRequestId),eq(inputs.turnId,a.turnId)));return delivery?{assignmentId:a.id,bindingId:b.id,generation:b.generation,requestId:delivery.requestId,turnId:delivery.turnId,inputDigest:delivery.inputDigest,response:delivery.response,consumed:!!delivery.consumedAt}:{status:"pending"};}
      if(q.query==="task.list"||q.query==="task.search") {const condition=await visible(s);const rows=await db.select({id:issues.id,identifier:issues.identifier,title:issues.title,status:issues.status,assigneeAgentId:issues.assigneeAgentId}).from(issues).where(and(eq(issues.companyId,s.companyId),condition,isNull(issues.hiddenAt),isNull(issues.harnessKind),q.after?gt(issues.id,q.after):undefined,q.query==="task.search"?sql`(${issues.title} ilike ${`%${q.text}%`} or ${issues.description} ilike ${`%${q.text}%`})`:undefined)).orderBy(asc(issues.id)).limit(50);return {tasks:rows,nextCursor:rows.at(-1)?.id??null};}
      const issue=await assertIssue(s,q.issueId);
      if(q.query==="task.read")return {task:issue};
      if(q.query==="task.history")return {comments:await issueService(db).listComments(issue.id,{limit:100})};
      const [document]=await db.select({key:issueDocuments.key,title:documents.title,body:documents.latestBody,revision:documents.latestRevisionNumber}).from(issueDocuments).innerJoin(documents,and(eq(documents.id,issueDocuments.documentId),eq(documents.companyId,s.companyId))).where(and(eq(issueDocuments.companyId,s.companyId),eq(issueDocuments.issueId,issue.id),eq(issueDocuments.key,q.key)));
      if(!document)throw notFound("Document not found.");return {document};
    },
    async cleanup(s:AgentConnectionSubject,command:{command:"control.inspect"}|{command:"worker.quiescent";boundary:MuseStopBoundary;requestId:string}) {
      if(command.command==="control.inspect") {const rows=await db.select({boundary:holds.stopBoundary,workerReportedAt:holds.workerReportedAt,nativeEffectsUnknown:holds.nativeEffectsUnknown}).from(holds).where(and(eq(holds.bindingId,s.bindingId),eq(holds.bindingGeneration,s.generation),eq(holds.companyId,s.companyId)));return {boundaries:rows,externalStopConfirmed:false};}
      return db.transaction(tx=>withExternalAdmissionGuard(tx,s.companyId,s.agentId,async()=>{
        const [hold]=await tx.select().from(holds).where(and(eq(holds.companyId,s.companyId),eq(holds.agentId,s.agentId),eq(holds.bindingId,s.bindingId),eq(holds.bindingGeneration,s.generation),eq(holds.assignmentId,command.boundary.assignmentId))).for("update");
        if(!hold?.stopBoundary||externalOperationDigest("tool",{boundary:hold.stopBoundary})!==externalOperationDigest("tool",{boundary:command.boundary}))throw conflict("Cleanup boundary does not match.");
        await tx.update(holds).set({workerReportedAt:new Date(),updatedAt:new Date()}).where(eq(holds.id,hold.id));return {status:"worker_reported",externalStopConfirmed:false,nativeEffectsUnknown:hold.nativeEffectsUnknown};
      }));
    },
    async detectorCleanup(s:AgentConnectionSubject,removed:boolean) {await db.update(bindings).set({...(removed?{detectorRemovedAt:new Date()}:{detectorRemovalRequestedAt:new Date()}),updatedAt:new Date()}).where(and(eq(bindings.id,s.bindingId),eq(bindings.generation,s.generation),eq(bindings.companyId,s.companyId)));return {status:removed?"detector_removed":"detector_removal_requested",externalStopConfirmed:false};},
    async authorizingUserIdForBinding(ref:{companyId:string;agentId:string;bindingId:string;bindingGeneration:number}) {
      const [b]=await db.select().from(bindings).where(and(eq(bindings.id,ref.bindingId),eq(bindings.generation,ref.bindingGeneration),eq(bindings.companyId,ref.companyId),eq(bindings.agentId,ref.agentId),isNull(bindings.revokedAt)));
      if(!b||!await identity.enabled())throw forbidden("Muse binding unavailable.");await assertMuseCurrentAuthority(db,b);return b.operatorId;
    },
    async assertRunAuthority(execution:Execution) {const ref=execution.provider.binding;const [b]=await db.select().from(bindings).where(and(eq(bindings.id,ref.bindingId),eq(bindings.generation,ref.bindingGeneration),eq(bindings.companyId,ref.companyId),eq(bindings.agentId,ref.agentId),isNull(bindings.revokedAt)));if(!b||!await identity.enabled())throw forbidden("Muse binding unavailable.");await assertMuseCurrentAuthority(db,b);const [a]=await db.select().from(assignments).where(and(eq(assignments.runId,execution.binding.runId),eq(assignments.bindingId,b.id),eq(assignments.bindingGeneration,b.generation)));if(!a||a.status==="fenced")throw forbidden("Muse assignment unavailable.");},
    port:(execution:Execution):ExternalProviderPort & Required<Pick<ExternalProviderPort,"inputAvailable">>=>nativeBroker.port(execution),
  };
  async function idleMutation(s:AgentConnectionSubject,c:Extract<MuseCommand,{command:"task.create"|"task.comment"}>) {
    await subjectBinding(s);
    const digest=externalOperationDigest("tool",{command:c});
    return db.transaction(async tx=>{
      // Task lock precedes admission and binding. Parent creation locks its
      // existing parent first; new issue rows cannot be owned by another tx.
      if(c.command==="task.create")await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-privacy-tree:${s.companyId}`},0))`);
      const issueId=c.command==="task.comment"?c.issueId:c.parentId;
      if(issueId)await tx.select({id:issues.id}).from(issues).where(and(eq(issues.id,issueId),eq(issues.companyId,s.companyId))).for("update");
      return withExternalAdmissionGuard(tx,s.companyId,s.agentId,async()=>{
        const [b]=await tx.select().from(bindings).where(and(eq(bindings.id,s.bindingId),eq(bindings.generation,s.generation),isNull(bindings.revokedAt))).for("update");
        if(!b)throw forbidden("Muse binding was fenced.");await assertMuseCurrentAuthority(tx,b);
        const [old]=await tx.select().from(idleReceipts).where(and(eq(idleReceipts.bindingId,b.id),eq(idleReceipts.bindingGeneration,b.generation),eq(idleReceipts.requestId,c.requestId)));
        if(old){if(old.digest!==digest)throw conflict("Request ID reused with changed input.");if(typeof old.outcome.issueId==="string")await assertIssue(s,old.outcome.issueId);return old.outcome;}
        const authorization=authorizationService(tx as unknown as Db);
        const resource={type:"issue" as const,companyId:s.companyId,issueId:c.command==="task.comment"?c.issueId:undefined,parentIssueId:c.command==="task.create"?c.parentId:undefined,projectId:c.command==="task.create"?c.projectId:undefined};
        for(const actor of [agentActor(s),authorizerActor(s)]) {const decision=await authorization.decide({actor,action:c.command==="task.comment"?"issue:comment":"issue:mutate",resource});if(!decision.allowed)throw forbidden(decision.explanation);}
        let outcome:Record<string,unknown>;
        if(c.command==="task.comment") {
          await assertIssue(s,c.issueId);
          const comment=await issueService(db).addComment(c.issueId,c.body,{agentId:s.agentId,onBehalfOfUserId:s.authorizingUserId},{},tx);
          outcome={status:"commented",issueId:c.issueId,commentId:comment.id};
        } else {
          const issue=await issueService(tx as unknown as Db).create(s.companyId,{title:c.title,description:c.description,parentId:c.parentId,projectId:c.projectId,status:"todo",createdByAgentId:s.agentId,responsibleUserId:s.authorizingUserId,actorResponsibleUserId:s.authorizingUserId},tx);
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
    let issueId:string;
    if(c.command==="turn.request") {
      const result=await idleMutation(s,{version:1,command:"task.create",requestId:c.requestId,title:c.prompt.slice(0,500),description:c.prompt});
      issueId=String(result.issueId);
      // Visible intake remains ordinary work; assigning it requires the current
      // agent's task-assignment authority, not a receiver capability.
      const issue=await assertIssue(s,issueId);
      const decision=await authorizationService(db).decide({actor:agentActor(s),action:"tasks:assign",resource:{type:"issue",companyId:s.companyId,issueId}});
      if(!decision.allowed)throw forbidden(decision.explanation);
      if(!issue.assigneeAgentId)await issueService(db).update(issueId,{assigneeAgentId:s.agentId},{actorAgentId:s.agentId,actorResponsibleUserId:s.authorizingUserId});
    } else issueId=c.issueId;
    const issue=await assertIssue(s,issueId);
    if(issue.assigneeAgentId!==s.agentId||!["todo","in_progress"].includes(issue.status))throw conflict("Request work only for an eligible task assigned to this Muse agent.");
    const [prior]=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,s.companyId),eq(agentWakeupRequests.agentId,s.agentId),eq(agentWakeupRequests.idempotencyKey,requestKey)));
    if(prior){if(prior.payload?.issueId!==issueId)throw conflict("Request ID reused for another task.");return {status:"requested",runId:prior.runId};}
    const run=await(await heartbeat()).wakeup(s.agentId,{source:"assignment",triggerDetail:"system",reason:"issue_assigned",payload:{issueId,museRequestId:c.requestId},contextSnapshot:{issueId},idempotencyKey:requestKey,requestedByActorType:"agent",requestedByActorId:s.agentId,allowRunCoalescing:false});
    return {status:"requested",issueId,runId:run?.id??null};
  }
  return broker;
}
