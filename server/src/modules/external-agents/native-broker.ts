import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, and, eq, isNull, gt, inArray } from "drizzle-orm";
import { agents, companies, issues, authUsers, companyMemberships, heartbeatRuns, nativeRunFinalizations, mcpOauthGrants,
  dotAgentBindings, dotRunnerOperations, museAgentBindings, museRunnerOperations, externalAgentHolds, type Db } from "@paperclipai/db";
import { issueReadSqlCondition } from "../../services/authorization.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext } from "../../services/native-runtime/native-review-participant.js";
import { conflict, forbidden } from "../../errors.js";
import { externalOperationDigest, digestPaperclipSemanticContent, parsePaperclipQuestionSet, type ExternalProviderOperation, type ExternalProviderPort, type DotBindingSnapshot } from "../../vendor/paperclip-runner/index.js";
import { consumeDotHistoryReceipt } from "../../services/dot-assignment-follow-up.js";
import { consumeMuseHistoryReceipt } from "../../services/muse-assignment-follow-up.js";
import { withExternalAdmissionGuard, type ExternalAdmissionTransaction } from "./admission.js";

// A closed pair of stores maps existing provider journals. There is no new
// universal assignment table, copied Dot state, or generic write-set API.
const STORES = {
  openai_dot: {binding:"dot_agent_bindings",assignment:"dot_runner_assignments",operation:"dot_runner_operations",mailbox:"dot_mailbox_items",replay:["reserved","admitted"],completed:"completed",pending:"admitted",acceptedAt:"accepted_at"},
  muse: {binding:"muse_agent_bindings",assignment:"muse_runner_assignments",operation:"muse_runner_operations",mailbox:"muse_mailbox_items",replay:["reserved"],completed:"settled",pending:"pending",acceptedAt:"native_accepted_at"},
} as const;
type Provider=keyof typeof STORES;
type Database=Db|ExternalAdmissionTransaction;
interface Binding extends Record<string,unknown> {id:string;companyId:string;agentId:string;generation:number;operatorId:string;status:string;revokedAt:Date|null;grantId:string|null}
interface Assignment extends Record<string,unknown> {id:string;companyId:string;agentId:string;bindingId:string;bindingGeneration:number;runId:string;normalizedSessionId:string;turnId:string;revision:number;controllerGeneration:number;status:string;acceptBy:Date;expiresAt:Date;createdAt:Date;claimedAt:Date|null;projection:Record<string,unknown>}
interface Receipt extends Record<string,unknown> {id:string;companyId:string;assignmentId:string;requestId:string;digest:string;command:Record<string,unknown>;status:string;outcome:Record<string,unknown>|null;continuationReceiptId:string|null}
interface Authority {binding:{id:string;companyId:string;agentId:string;generation:number};assignment:Pick<Assignment,"id"|"companyId"|"agentId"|"bindingId"|"bindingGeneration"|"runId"|"normalizedSessionId"|"turnId"|"revision"|"controllerGeneration"|"status"|"expiresAt"|"createdAt"> & {claimedAt?:Date|null}}
interface Identity<S> {authorize(subject:S,assignmentId:string,settled?:boolean):Promise<Authority>;enabled():Promise<boolean>}
type Execution={binding:{companyId:string;agentId:string;runId:string};provider:{binding:DotBindingSnapshot}};
const bindingSchema=z.object({bindingId:z.uuid(),bindingGeneration:z.number().int().positive(),companyId:z.uuid(),agentId:z.uuid(),runId:z.uuid(),normalizedSessionId:z.string().min(1),turnId:z.string().min(1),assignmentRevision:z.number().int().positive()});
const commandSchema=z.object({requestId:z.uuid(),bindingId:z.uuid(),bindingGeneration:z.number().int().positive(),runId:z.uuid(),normalizedSessionId:z.string().min(1),turnId:z.string().min(1),assignmentRevision:z.number().int().positive(),digest:z.string(),action:z.enum(["accept","tool","progress","finish","renew","request_user_input","consume_input"]),input:z.record(z.string(),z.unknown())}).strict();
/** Private shared broker. Its callers supply an identity adapter once, then
 * invoke whole domain operations; they cannot assemble lifecycle primitives. */
export function createNativeExternalBroker<S>(db:Db,provider:Provider,identity:Identity<S>) {
  const store=STORES[provider];
  const bindingTable=sql.raw(store.binding),assignmentTable=sql.raw(store.assignment),operationTable=sql.raw(store.operation),mailboxTable=sql.raw(store.mailbox);
  const ports=new Map<string,{token:symbol;generation:number;send:(command:ExternalProviderOperation)=>Promise<void>;revoke?:()=>Promise<void>}>();
  const bindingColumns=sql.raw(`id,company_id AS "companyId",agent_id AS "agentId",generation,operator_id AS "operatorId",status,revoked_at AS "revokedAt",${provider==="openai_dot"?"grant_id":"NULL::uuid"} AS "grantId"`);
  const assignmentColumns=sql.raw(`id,company_id AS "companyId",agent_id AS "agentId",binding_id AS "bindingId",binding_generation AS "bindingGeneration",run_id AS "runId",normalized_session_id AS "normalizedSessionId",turn_id AS "turnId",revision,controller_generation AS "controllerGeneration",status,accept_by AS "acceptBy",expires_at AS "expiresAt",created_at AS "createdAt",${provider==="muse"?"claimed_at":"accepted_at"} AS "claimedAt",projection`);
  const receiptColumns=sql.raw(`id,company_id AS "companyId",assignment_id AS "assignmentId",request_id AS "requestId",digest,command,status,outcome,${provider==="muse"?"continuation_receipt_id":"NULL::uuid"} AS "continuationReceiptId"`);
  async function withExecutionAdmission<T>(tx:ExternalAdmissionTransaction,companyId:string,agentId:string,runId:string,action:()=>Promise<T>) {
    const [run]=await tx.select({issueId:heartbeatRuns.nativeIssueId}).from(heartbeatRuns).where(and(eq(heartbeatRuns.id,runId),eq(heartbeatRuns.companyId,companyId),eq(heartbeatRuns.agentId,agentId)));
    if(!run?.issueId)throw forbidden("Native run task unavailable.");
    await tx.select({id:issues.id}).from(issues).where(and(eq(issues.id,run.issueId),eq(issues.companyId,companyId))).for("update");
    const [locked]=await tx.select({issueId:heartbeatRuns.nativeIssueId}).from(heartbeatRuns).where(eq(heartbeatRuns.id,runId)).for("update");
    if(locked?.issueId!==run.issueId)throw conflict("Native run task changed during admission.");
    return withExternalAdmissionGuard(tx,companyId,agentId,action);
  }
  async function assignment(database:Database,id:string) {return (await database.execute<Assignment>(sql`select ${assignmentColumns} from ${assignmentTable} where id=${id}::uuid`))[0];}
  async function receipt(database:Database,id:string) {return (await database.execute<Receipt>(sql`select ${receiptColumns} from ${operationTable} where id=${id}::uuid`))[0];}
  async function currentBinding(database:Database,id:string,generation:number,allowFence=false) {
    const [b]=await database.execute<Binding>(sql`select ${bindingColumns} from ${bindingTable} where id=${id}::uuid and generation=${generation} and (${allowFence} or revoked_at is null) for update`);
    if(!b)throw forbidden("External binding generation is unavailable.");return b;
  }
  async function assertCurrentAuthority(database:Database,b:Binding,allowFence=false) {
    if(allowFence)return;
    if(!await identity.enabled()||b.status!=="ready"||b.revokedAt)throw forbidden("External binding is unavailable for new effects.");
    const [agent]=await database.select().from(agents).where(and(eq(agents.id,b.agentId),eq(agents.companyId,b.companyId)));
    const [company]=await database.select().from(companies).where(eq(companies.id,b.companyId));
    const [user]=await database.select({id:authUsers.id}).from(authUsers).where(eq(authUsers.id,b.operatorId));
    const [membership]=await database.select().from(companyMemberships).where(and(eq(companyMemberships.companyId,b.companyId),eq(companyMemberships.principalType,"user"),eq(companyMemberships.principalId,b.operatorId),eq(companyMemberships.status,"active")));
    if(!agent||["paused","terminated","pending_approval"].includes(agent.status)||agent.adapterType!=="paperclip_runner"||agent.adapterConfig.provider!==provider||agent.adapterConfig[provider==="muse"?"museBindingId":"dotBindingId"]!==b.id||company?.status!=="active"||!user||!membership||membership.membershipRole==="viewer")throw forbidden("Current external agent or authorizer authority is unavailable.");
    if(provider==="muse") {
      const [member]=await database.select({id:companyMemberships.id}).from(companyMemberships).where(and(eq(companyMemberships.companyId,b.companyId),eq(companyMemberships.principalType,"agent"),eq(companyMemberships.principalId,b.agentId),eq(companyMemberships.status,"active")));
      const [binding]=await database.select({deadline:museAgentBindings.qualificationExpiresAt}).from(museAgentBindings).where(eq(museAgentBindings.id,b.id));
      if(!member||binding?.deadline&&binding.deadline<=new Date())throw forbidden("Current Muse membership or qualification authority expired.");
    }
    if(provider==="openai_dot") {
      const [grant]=b.grantId?await database.select().from(mcpOauthGrants).where(and(eq(mcpOauthGrants.id,b.grantId),isNull(mcpOauthGrants.revokedAt))):[];
      if(!grant||grant.companyId!==b.companyId||grant.agentId!==b.agentId||grant.userId!==b.operatorId)throw forbidden("Dot grant authority is unavailable.");
    }
    if((company.budgetMonthlyCents>0&&company.spentMonthlyCents>=company.budgetMonthlyCents)||(agent.budgetMonthlyCents>0&&agent.spentMonthlyCents>=agent.budgetMonthlyCents))throw forbidden("External execution budget is exhausted.");
  }
  async function authorizeController(database:Database,a:Assignment,generation:number) {
    const [owner]=await database.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId,a.runId),eq(nativeRunFinalizations.companyId,a.companyId),eq(nativeRunFinalizations.controllerGeneration,generation),gt(nativeRunFinalizations.leaseExpiresAt,new Date())));
    const [run]=await database.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,a.runId),eq(heartbeatRuns.companyId,a.companyId),eq(heartbeatRuns.agentId,a.agentId),eq(heartbeatRuns.status,"running"),eq(heartbeatRuns.runtimeMode,"native")));
    if(!owner||!run||run.nativeSessionId!==a.normalizedSessionId||["terminal_failure","turn_stopping","turn_stopped"].includes(run.nativePhase??""))throw forbidden("Native controller no longer owns this exact assignment.");
    const [binding]=await database.execute<Binding>(sql`select ${bindingColumns} from ${bindingTable} where id=${a.bindingId}::uuid`);
    const [issue]=run.nativeIssueId?await database.select().from(issues).where(and(eq(issues.id,run.nativeIssueId),eq(issues.companyId,a.companyId),provider==="muse"?await issueReadSqlCondition(database,{type:"agent",agentId:a.agentId,companyId:a.companyId,authorizingUserId:binding?.operatorId,onBehalfOfUserId:run.responsibleUserId}):undefined)):[];
    const reviewContext=readNativeReviewAssignmentContext(run.contextSnapshot);
    const review=issue&&reviewContext?await getNativeReviewAssignment(database as Db,{companyId:a.companyId,issueId:issue.id,agentId:a.agentId,contextSnapshot:run.contextSnapshot,actingRunId:run.id,allowResolvedByRunId:run.id}):null;
    if(!issue||(reviewContext? !review||(review.interaction.status==="pending"&&issue.executionRunId!==run.id): issue.assigneeAgentId!==a.agentId||![issue.checkoutRunId,issue.executionRunId].includes(run.id)))throw forbidden("Native run no longer owns this current task.");
  }
  async function consumeHistory(row:Receipt) {
    if(provider==="openai_dot") {const [r]=await db.select().from(dotRunnerOperations).where(eq(dotRunnerOperations.id,row.id));if(r)await consumeDotHistoryReceipt(db,r);}
    else {const [r]=await db.select().from(museRunnerOperations).where(eq(museRunnerOperations.id,row.id));if(r)await consumeMuseHistoryReceipt(db,r);}
  }
  async function forward(row:Receipt) {
    if(!store.replay.some(status=>status===row.status))return;
    const a=await assignment(db,row.assignmentId),port=a&&ports.get(a.runId);if(!a||!port)return;
    const command=commandSchema.parse(row.command);
    const send=await db.transaction(tx=>withExecutionAdmission(tx,a.companyId,a.agentId,a.runId,async()=>{
      const b=await currentBinding(tx,a.bindingId,a.bindingGeneration);await assertCurrentAuthority(tx,b);
      const [current]=await tx.execute<Assignment>(sql`select ${assignmentColumns} from ${assignmentTable} where id=${a.id}::uuid for update`);
      if(!current||current.status==="fenced"||current.status==="settled"||current.expiresAt<=new Date()||current.controllerGeneration!==port.generation)return false;
      await authorizeController(tx,current,port.generation);
      if(provider==="muse")return (await tx.execute(sql`update ${operationTable} set status='dispatched',updated_at=now() where id=${row.id}::uuid and status='reserved' returning id`)).length===1;
      return true;
    }));if(!send)return;
    try {
      await port.send(command);
      await db.execute(sql`update ${operationTable} set status=${store.pending},updated_at=now() where id=${row.id}::uuid and status=${provider==="muse"?"dispatched":"reserved"}`);
    } catch(error) {
      const rejected=error&&typeof error==="object"&&("dotOperationRejected" in error||"externalOperationRejected" in error);
      if(rejected)await db.execute(sql`update ${operationTable} set status='rejected',outcome=${JSON.stringify({status:"rejected",message:"Runner rejected this operation; inspect the assignment and arguments before proceeding."})}::jsonb,updated_at=now() where id=${row.id}::uuid and status=${provider==="muse"?"dispatched":"reserved"}`);
      else if(provider==="muse")await db.transaction(async tx=>{await tx.execute(sql`update ${operationTable} set status='unknown',updated_at=now() where id=${row.id}::uuid and status in ('dispatched','pending')`);await tx.update(externalAgentHolds).set({nativeEffectsUnknown:true,updatedAt:new Date()}).where(and(eq(externalAgentHolds.provider,provider),eq(externalAgentHolds.assignmentId,a.id)));});
      else throw error;
    }
  }
  async function reserveNativeOperation(authority:Authority,command:ExternalProviderOperation,proof?:{continuationReceiptId:string;continuationPersisted:true}) {
    const id=authority.assignment.id;
    return db.transaction(tx=>withExecutionAdmission(tx,authority.binding.companyId,authority.binding.agentId,authority.assignment.runId,async()=>{
      const b=await currentBinding(tx,authority.binding.id,authority.binding.generation);await assertCurrentAuthority(tx,b);
      const [a]=await tx.execute<Assignment>(sql`select ${assignmentColumns} from ${assignmentTable} where id=${id}::uuid and company_id=${b.companyId}::uuid and agent_id=${b.agentId}::uuid and binding_id=${b.id}::uuid and binding_generation=${b.generation} for update`);
      if(!a||a.status==="fenced"||a.status==="settled"||a.expiresAt<=new Date()||a.controllerGeneration!==authority.assignment.controllerGeneration)throw conflict("Assignment changed before operation admission.");
      await authorizeController(tx,a,a.controllerGeneration);
      const [old]=await tx.execute<Receipt>(sql`select ${receiptColumns} from ${operationTable} where assignment_id=${id}::uuid and request_id=${command.requestId}::uuid`);
      if(old){if(old.digest!==command.digest||old.continuationReceiptId!==(proof?.continuationReceiptId??null))throw conflict("requestId was reused with different arguments.");return old;}
      const [count]=await tx.execute<{count:number}>(sql`select count(*)::int as count from ${operationTable} where assignment_id=${id}::uuid`);if(count&&count.count>=4000)throw conflict("Assignment operation limit reached.");
      if(provider==="muse") {
        if(command.action!=="accept"&&!a.claimedAt)throw conflict("Claim the assignment before running operations.");
        if(command.action==="accept") {
          if(a.claimedAt||a.acceptBy<=new Date())throw conflict("Assignment already claimed or claim expired.");
          await tx.execute(sql`update ${assignmentTable} set status='claimed',claimed_at=now() where id=${id}::uuid`);
          await tx.insert(externalAgentHolds).values({companyId:b.companyId,agentId:b.agentId,provider,assignmentId:id,bindingId:b.id,bindingGeneration:b.generation,runId:a.runId,workerUnknown:true}).onConflictDoNothing();
        }
        if(command.action==="finish") {
          const [pending]=await tx.execute(sql`select 1 from muse_input_deliveries where assignment_id=${id}::uuid and consumed_at is null union all select 1 from ${operationTable} where assignment_id=${id}::uuid and command->>'action'='request_user_input' and status in ('reserved','dispatched','pending','unknown') limit 1`);if(pending)throw conflict("Pending or unconsumed runtime input blocks finish.");
        }
        if(command.action==="consume_input") {
          const [delivery]=await tx.execute(sql`select 1 from muse_input_deliveries where assignment_id=${id}::uuid and request_id=${String(command.input.requestId)} and turn_id=${a.turnId} and input_digest=${String(command.input.inputDigest)}`);
          if(!delivery||proof?.continuationPersisted!==true||!z.uuid().safeParse(proof.continuationReceiptId).success)throw conflict("Persist input in this exact turn before consumption.");
        }
      }
      const [created]=await tx.execute<Receipt>(sql`insert into ${operationTable} (company_id,assignment_id,request_id,digest,command${provider==="muse"?sql`,continuation_receipt_id`:sql``}) values (${a.companyId}::uuid,${id}::uuid,${command.requestId}::uuid,${command.digest},${JSON.stringify(command)}::jsonb${provider==="muse"?sql`,${proof?.continuationReceiptId??null}::uuid`:sql``}) returning ${receiptColumns}`);
      if(!created)throw conflict("Operation reservation failed.");return created;
    }));
  }
  async function operation(subject:S,id:string,requestId:string,action:ExternalProviderOperation["action"],input:Record<string,unknown>,proof?:{continuationReceiptId:string;continuationPersisted:true}) {
    const authority=await identity.authorize(subject,id),{binding:b,assignment:a}=authority;
    if(!z.uuid().safeParse(requestId).success||Buffer.byteLength(JSON.stringify(input))>256*1024)throw conflict("Use a UUID requestId and bounded arguments.");
    if(provider==="openai_dot"&&["request_user_input","consume_input"].includes(action))throw forbidden("Dot runtime questions remain disabled.");
    if(action==="request_user_input")parsePaperclipQuestionSet(input.questionSet);
    if(action==="renew"&&(!Number.isSafeInteger(input.expiresAtUnixMs)||Number(input.expiresAtUnixMs)<=Date.now()||Number(input.expiresAtUnixMs)>Date.now()+2*60*60_000||Number(input.expiresAtUnixMs)>a.createdAt.getTime()+24*60*60_000))throw conflict("Renewal must stay within the two-hour rolling and 24-hour total lease bounds.");
    const command:ExternalProviderOperation={requestId,bindingId:b.id,bindingGeneration:b.generation,runId:a.runId,normalizedSessionId:a.normalizedSessionId,turnId:a.turnId,assignmentRevision:a.revision,action,input,digest:externalOperationDigest(action,input)};
    const reserved=await reserveNativeOperation(authority,command,proof);
    if(store.replay.some(status=>status===reserved.status))void forward(reserved).catch(()=>{});
    const deadline=Date.now()+1500;
    while(Date.now()<deadline) {
      const r=await receipt(db,reserved.id);
      if(r?.outcome){await identity.authorize(subject,id,true);await consumeHistory(r);return r.outcome;}
      if(r?.status==="unknown"){await identity.authorize(subject,id,true);return {status:"unknown",assignmentId:id,requestId,canReplay:false};}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return {status:"pending",assignmentId:id,requestId,message:provider==="openai_dot"?"Use paperclip_dot_operation_status or retry with the same requestId. Do not create a new request ID.":"Read the durable receipt or retry with the same request ID and identical arguments."};
  }
  function port(execution:Execution):ExternalProviderPort & Required<Pick<ExternalProviderPort,"inputAvailable">> {
    const runId=execution.binding.runId,ref=execution.provider.binding;
    function eventBinding(payload:Record<string,unknown>) {
      const b=bindingSchema.parse(payload.binding);
      if(b.runId!==runId||b.bindingId!==ref.bindingId||b.bindingGeneration!==ref.bindingGeneration||b.companyId!==execution.binding.companyId||b.agentId!==execution.binding.agentId)throw conflict("Runner event binding mismatch.");
      return b;
    }
    async function eventAssignment(tx:ExternalAdmissionTransaction,b:ReturnType<typeof eventBinding>) {
      return (await tx.execute<Assignment>(sql`select ${assignmentColumns} from ${assignmentTable} where run_id=${b.runId}::uuid and company_id=${b.companyId}::uuid and agent_id=${b.agentId}::uuid and binding_id=${b.bindingId}::uuid and binding_generation=${b.bindingGeneration} and normalized_session_id=${b.normalizedSessionId} and turn_id=${b.turnId} and revision=${b.assignmentRevision} for update`))[0];
    }
    async function reserveRevocationEvent(tx:ExternalAdmissionTransaction,a:Assignment,sourceEventId:string,references:Record<string,unknown>) {
      const [created]=await tx.execute(sql`insert into ${mailboxTable} (company_id,binding_id,binding_generation,assignment_id,kind,source_event_id,"references") values (${a.companyId}::uuid,${a.bindingId}::uuid,${a.bindingGeneration},${a.id}::uuid,'authority_revoked',${sourceEventId},${JSON.stringify(references)}::jsonb) on conflict do nothing returning id`);
      if(created)return true;
      const [old]=await tx.execute<{companyId:string;assignmentId:string|null;kind:string}>(sql`select company_id as "companyId",assignment_id as "assignmentId",kind from ${mailboxTable} where binding_id=${a.bindingId}::uuid and binding_generation=${a.bindingGeneration} and source_event_id=${sourceEventId}`);
      if(!old||old.companyId!==a.companyId||old.assignmentId!==a.id||old.kind!=="authority_revoked")throw conflict("Runner event identity conflicts with its durable receipt.");
      return false;
    }
    return {
      attach:async(send,revoke,checkpoint)=>{
        const [existing]=await db.execute<Assignment>(sql`select ${assignmentColumns} from ${assignmentTable} where run_id=${runId}::uuid`);
        if(existing&&checkpoint!==true)throw conflict(provider==="openai_dot"?"Dot bridge checkpoint missing; reconcile external work before continuing.":"Muse target-owned checkpoint missing; reconcile the original execution.");
        const [owner]=await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,runId));
        if(!owner?.leaseExpiresAt||owner.leaseExpiresAt<=new Date()||ports.has(runId))throw conflict("Native run controller unavailable or already attached.");
        const token=Symbol(runId);ports.set(runId,{token,generation:owner.controllerGeneration,send,revoke});
        try {
          await db.transaction(tx=>withExecutionAdmission(tx,execution.binding.companyId,execution.binding.agentId,runId,async()=>{
            await tx.execute(sql`select id from ${bindingTable} where id=${ref.bindingId}::uuid for update`);
            await tx.execute(sql`update ${assignmentTable} set controller_generation=${owner.controllerGeneration} where run_id=${runId}::uuid and binding_generation=${ref.bindingGeneration} and controller_generation<=${owner.controllerGeneration}`);
            // Dot has target-owned replay receipts. Muse's unconfirmed sends
            // become independent unknown barriers on controller replacement.
            if(provider==="muse"&&existing) {
              const interrupted=await tx.execute(sql`update ${operationTable} set status='unknown',updated_at=now() where assignment_id=${existing.id}::uuid and status in ('dispatched','pending') returning id`);
              if(interrupted.length)await tx.update(externalAgentHolds).set({nativeEffectsUnknown:true,releasedAt:null,updatedAt:new Date()}).where(and(eq(externalAgentHolds.provider,provider),eq(externalAgentHolds.assignmentId,existing.id)));
            }
          }));
        } catch(error) {if(ports.get(runId)?.token===token)ports.delete(runId);throw error;}
        let timer:NodeJS.Timeout|undefined;
        const drain=async()=>{
          try {
            if(ports.get(runId)?.token!==token)return;
            const rows=await db.execute<Receipt>(sql`select o.id,o.company_id as "companyId",o.assignment_id as "assignmentId",o.request_id as "requestId",o.digest,o.command,o.status,o.outcome,${provider==="muse"?sql`o.continuation_receipt_id`:sql`NULL::uuid`} as "continuationReceiptId" from ${operationTable} o join ${assignmentTable} a on a.id=o.assignment_id where a.run_id=${runId}::uuid and o.status in (${sql.join(store.replay.map(status=>sql`${status}`),sql`,`)}) order by o.created_at limit 32`);
            for(const row of rows){if(ports.get(runId)?.token!==token)break;await forward(row).catch(()=>{});}
          } finally {if(ports.get(runId)?.token===token){timer=setTimeout(()=>void drain().catch(()=>{}),2000);timer.unref();}}
        };
        void drain().catch(()=>{});
        return async()=>{if(timer)clearTimeout(timer);if(ports.get(runId)?.token===token)ports.delete(runId);};
      },
      dispatch:async event=>{
        const p=event.payload,b=eventBinding(p);
        await db.transaction(tx=>withExecutionAdmission(tx,b.companyId,b.agentId,b.runId,async()=>{
          const [binding]=await tx.execute<Binding>(sql`select ${bindingColumns} from ${bindingTable} where id=${b.bindingId}::uuid and company_id=${b.companyId}::uuid and agent_id=${b.agentId}::uuid for update`);
          if(!binding)throw forbidden("Runner dispatch binding unavailable.");
          if(p.kind==="authority_revoked") {
            const a=await eventAssignment(tx,b);if(!a)return;
            if(provider==="muse") {
              const [hold]=await tx.select().from(externalAgentHolds).where(and(eq(externalAgentHolds.provider,provider),eq(externalAgentHolds.assignmentId,a.id))).for("update");
              const [last]=await tx.execute<{requestId:string}>(sql`select request_id as "requestId" from ${operationTable} where assignment_id=${a.id}::uuid order by created_at desc limit 1`);
              // A server fence may already have established this assignment's
              // stop boundary. A later Runner fact cannot erase its evidence.
              const boundary=hold?.stopBoundary??{bindingId:b.bindingId,generation:b.bindingGeneration,assignmentId:a.id,runId,turnId:a.turnId,assignmentRevision:a.revision,stopNonce:randomUUID(),operationBoundary:last?.requestId??null};
              const references={boundary,reason:"runner_authority_revoked",externalStopConfirmed:false};
              // Reserve the event identity before any state transition. A lost
              // ACK replay leaves the original receipt and hold unchanged.
              if(!await reserveRevocationEvent(tx,a,event.sourceEventId,references))return;
              await tx.execute(sql`update ${assignmentTable} set status='fenced' where id=${a.id}::uuid`);
              const [unresolved]=await tx.execute(sql`select 1 from ${operationTable} where assignment_id=${a.id}::uuid and status in ('dispatched','pending','unknown') limit 1`);
              if(a.claimedAt) {
                if(hold?.stopBoundary) {
                  const nativeEffectsUnknown=hold.nativeEffectsUnknown||!!unresolved;
                  if(nativeEffectsUnknown&&(!hold.nativeEffectsUnknown||hold.releasedAt!==null))await tx.update(externalAgentHolds).set({nativeEffectsUnknown:true,releasedAt:null,updatedAt:new Date()}).where(eq(externalAgentHolds.id,hold.id));
                } else {
                  await tx.insert(externalAgentHolds).values({companyId:a.companyId,agentId:a.agentId,provider,assignmentId:a.id,bindingId:a.bindingId,bindingGeneration:a.bindingGeneration,runId,workerUnknown:true,nativeEffectsUnknown:!!unresolved,stopBoundary:boundary}).onConflictDoUpdate({target:[externalAgentHolds.provider,externalAgentHolds.assignmentId],set:{stopBoundary:boundary,workerUnknown:true,nativeEffectsUnknown:sql`${externalAgentHolds.nativeEffectsUnknown} or ${!!unresolved}`,releasedAt:null,updatedAt:new Date()}});
                }
              }
              return;
            }
            const references={assignmentId:a.id,runId,externalStopConfirmed:false};
            if(await reserveRevocationEvent(tx,a,event.sourceEventId,references))await tx.execute(sql`update ${assignmentTable} set status='fenced' where id=${a.id}::uuid`);
            return;
          }
          if(binding.generation!==b.bindingGeneration)throw forbidden("Runner dispatch generation fenced.");
          await assertCurrentAuthority(tx,binding);
          const [owner]=await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,runId));
          if(!owner?.leaseExpiresAt||owner.leaseExpiresAt<=new Date())throw forbidden("Runner dispatch controller unavailable.");
          await authorizeController(tx,{runId,companyId:b.companyId,agentId:b.agentId,bindingId:b.bindingId,normalizedSessionId:b.normalizedSessionId} as Assignment,owner.controllerGeneration);
          const [old]=await tx.execute<Assignment>(sql`select ${assignmentColumns} from ${assignmentTable} where run_id=${runId}::uuid and turn_id=${b.turnId}`);
          const projection={...p,binding:b};
          if(old&&externalOperationDigest("tool",old.projection)!==externalOperationDigest("tool",projection))throw conflict("Assignment event changed its immutable projection.");
          const [a]=old?[old]:await tx.execute<Assignment>(sql`insert into ${assignmentTable} (company_id,binding_id,binding_generation,run_id,agent_id,normalized_session_id,turn_id,revision,controller_generation,catalog_digest,status,projection,accept_by,expires_at) values (${b.companyId}::uuid,${b.bindingId}::uuid,${b.bindingGeneration},${runId}::uuid,${b.agentId}::uuid,${b.normalizedSessionId},${b.turnId},${b.assignmentRevision},${owner.controllerGeneration},${externalOperationDigest("tool",{tools:p.tools})},'offered',${JSON.stringify(projection)}::jsonb,${new Date(Number(p.acceptByUnixMs)).toISOString()}::timestamptz,${new Date(Number(p.expiresAtUnixMs)).toISOString()}::timestamptz) returning ${assignmentColumns}`);
          if(!a)throw conflict("Assignment creation failed.");
          await tx.execute(sql`insert into ${mailboxTable} (company_id,binding_id,binding_generation,assignment_id,kind,source_event_id,"references") values (${a.companyId}::uuid,${a.bindingId}::uuid,${a.bindingGeneration},${a.id}::uuid,'assignment',${event.sourceEventId},${JSON.stringify({assignmentId:a.id,runId,revision:a.revision})}::jsonb) on conflict do nothing`);
        }));
      },
      settle:async event=>{
        const p=event.payload,b=eventBinding(p),requestId=z.uuid().parse(p.requestId),outcome=z.record(z.string(),z.unknown()).parse(p.outcome);
        await db.transaction(tx=>withExternalAdmissionGuard(tx,b.companyId,b.agentId,async()=>{
          await tx.execute(sql`select id from ${bindingTable} where id=${b.bindingId}::uuid for update`);
          const a=await eventAssignment(tx,b);
          const [op]=a?await tx.execute<Receipt>(sql`select ${receiptColumns} from ${operationTable} where assignment_id=${a.id}::uuid and request_id=${requestId}::uuid for update`):[];
          if(!a||!op)throw conflict("Runner operation has no reserved receipt.");
          if(op.outcome&&externalOperationDigest("tool",op.outcome)!==externalOperationDigest("tool",outcome))throw conflict("Runner operation result conflicts with its durable receipt.");
          await tx.execute(sql`update ${operationTable} set status=${provider==="muse"&&outcome.status==="rejected"?"rejected":store.completed},outcome=${JSON.stringify(outcome)}::jsonb,source_event_id=${event.sourceEventId},updated_at=now() where id=${op.id}::uuid`);
          const action=op.command.action;
          await tx.execute(sql`update ${assignmentTable} set last_activity_at=now() where id=${a.id}::uuid`);
          if(action==="renew"&&outcome.status==="renewed")await tx.execute(sql`update ${assignmentTable} set expires_at=${new Date(Number(outcome.expiresAtUnixMs)).toISOString()}::timestamptz where id=${a.id}::uuid`);
          if(a.status!=="fenced"&&outcome.status!=="rejected"&&action==="accept")await tx.execute(sql`update ${assignmentTable} set status='accepted',${sql.raw(store.acceptedAt)}=now() where id=${a.id}::uuid`);
          if(a.status!=="fenced"&&action==="finish"&&(provider==="openai_dot"||outcome.status!=="rejected"))await tx.execute(sql`update ${assignmentTable} set status='settled',${sql.raw(provider==="muse"?"accepted_result_at":"settled_at")}=now() where id=${a.id}::uuid`);
          if(provider==="muse") {
            if(action==="consume_input"&&outcome.status==="consumed") {
              const command=commandSchema.parse(op.command);
              if(outcome.requestId!==command.input.requestId||outcome.inputDigest!==command.input.inputDigest)throw conflict("Native input receipt does not match this exact request and digest.");
              await tx.execute(sql`update muse_input_deliveries set consumed_at=now(),continuation_receipt_id=${z.uuid().parse(op.continuationReceiptId)}::uuid where assignment_id=${a.id}::uuid and request_id=${String(command.input.requestId)} and turn_id=${a.turnId} and input_digest=${String(command.input.inputDigest)}`);
            }
            const [unknown]=await tx.execute(sql`select 1 from ${operationTable} where assignment_id=${a.id}::uuid and status in ('unknown','dispatched','pending') limit 1`);
            await tx.execute(sql`update external_agent_holds set native_effects_unknown=${!!unknown},released_at=case when not worker_unknown and ${!unknown} then now() else null end,updated_at=now() where provider='muse' and assignment_id=${a.id}::uuid`);
          }
          if(action==="tool")await tx.execute(sql`insert into ${mailboxTable} (company_id,binding_id,binding_generation,assignment_id,kind,source_event_id,"references") values (${a.companyId}::uuid,${a.bindingId}::uuid,${a.bindingGeneration},${a.id}::uuid,'operation_result',${event.sourceEventId},${JSON.stringify({assignmentId:a.id,requestId})}::jsonb) on conflict do nothing`);
        }));
      },
      inputAvailable:async event=>{
        if(provider!=="muse")throw forbidden("Dot runtime questions remain disabled.");
        const p=event.payload,b=eventBinding(p),requestId=z.string().min(1).max(200).parse(p.requestId),turnId=z.literal(b.turnId).parse(p.turnId),inputDigest=z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(p.inputDigest),response=z.record(z.string(),z.unknown()).parse(p.response);
        if(inputDigest!==digestPaperclipSemanticContent({requestId,turnId,response}))throw conflict("Input digest does not match its canonical response.");
        await db.transaction(tx=>withExternalAdmissionGuard(tx,b.companyId,b.agentId,async()=>{
          const binding=await currentBinding(tx,b.bindingId,b.bindingGeneration);await assertCurrentAuthority(tx,binding);
          const a=await eventAssignment(tx,b);if(!a||a.status==="fenced")throw forbidden("Input target authority unavailable.");
          const [old]=await tx.execute<{inputDigest:string;turnId:string}>(sql`select input_digest as "inputDigest",turn_id as "turnId" from muse_input_deliveries where assignment_id=${a.id}::uuid and request_id=${requestId}`);
          if(old&&(old.inputDigest!==inputDigest||old.turnId!==turnId))throw conflict("Input delivery changed its immutable digest.");
          await tx.execute(sql`insert into muse_input_deliveries (company_id,assignment_id,request_id,turn_id,input_digest,response,source_event_id) values (${a.companyId}::uuid,${a.id}::uuid,${requestId},${turnId},${inputDigest},${JSON.stringify(response)}::jsonb,${event.sourceEventId}) on conflict do nothing`);
          await tx.execute(sql`insert into ${mailboxTable} (company_id,binding_id,binding_generation,assignment_id,kind,source_event_id,"references") values (${a.companyId}::uuid,${a.bindingId}::uuid,${a.bindingGeneration},${a.id}::uuid,'input_available',${event.sourceEventId},${JSON.stringify({assignmentId:a.id,requestId,turnId,inputDigest})}::jsonb) on conflict do nothing`);
        }));
      },
    };
  }
  async function operationStatus(subject:S,assignmentId:string,requestId:string) {
    await identity.authorize(subject,assignmentId,true);
    const [row]=await db.execute<Receipt>(sql`select ${receiptColumns} from ${operationTable} where assignment_id=${assignmentId}::uuid and request_id=${requestId}::uuid`);
    if(!row)throw conflict("Operation does not exist.");await consumeHistory(row);return row.outcome??{status:row.status,requestId};
  }
  return {operation,operationStatus,port,revokeRun:async(runId:string)=>{await ports.get(runId)?.revoke?.().catch(()=>{});}};
}
