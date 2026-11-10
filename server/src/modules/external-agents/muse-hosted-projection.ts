import { and,asc,eq,inArray,isNull,sql,or,isNotNull } from "drizzle-orm";
import { museAgentBindings as bindings,museMailboxItems as mailbox,museRunnerAssignments as assignments,externalAgentHolds as holds,type Db } from "@paperclipai/db";
import { inspectMuseConnectionCredential,assertMuseReceiverAuthority,assertMuseCurrentAuthority,museStopControlBoundaryIds,hasMuseStopControlAccess } from "../../services/muse-identity.js";
import { canConfigureAgentConnection } from "../agent-lifecycle/index.js";
import { HttpError } from "../../errors.js";
import { getCloudRuntimeIdentity } from "../../services/cloud-runtime-identity.js";
import { prepareMcpClientMutation,type McpClientMutationDatabase } from "../../services/public-mcp/client-mirror-mutations.js";
import { museReceiverGeneration,type MuseHostedNamespace,type MuseReceiverRecord } from "./muse-hosted-contract.js";
/** Same outer producer transaction, before its mailbox/authority write. No stale eligibility filter. */
export async function prepareMuseReceiverMutation(tx:McpClientMutationDatabase) {
 if(getCloudRuntimeIdentity())await prepareMcpClientMutation(tx);
}
/** Hints target only a bound affected identity. Old eligibility is never used to suppress a restoration. */
export async function prepareMuseReceiverAuthorityMutation(tx:McpClientMutationDatabase,scope:{companyId?:string;agentId?:string;operatorId?:string}={}) {
 if(!getCloudRuntimeIdentity())return;
 const [binding]=await tx.select({id:bindings.id}).from(bindings).where(and(
  scope.companyId?eq(bindings.companyId,scope.companyId):undefined,scope.agentId?eq(bindings.agentId,scope.agentId):undefined,scope.operatorId?eq(bindings.operatorId,scope.operatorId):undefined,
  or(isNotNull(bindings.pairedAt),isNotNull(bindings.receiverContactAt)),or(isNull(bindings.revokedAt),isNull(bindings.detectorRemovedAt)))).limit(1);
 if(binding)await prepareMcpClientMutation(tx);
}
/** No contact is recorded and no worker subject fabricated by this projection. */
export async function readMuseReceiverProjection(db:Pick<Db,"select">,namespace:MuseHostedNamespace,revision:number,options:{enabled:boolean;contactImportWakeVersion?:1;beforeRead?:()=>Promise<void>;check?:()=>void}) {
 await options.beforeRead?.();
 const rows=await db.select().from(bindings).orderBy(asc(bindings.id)).limit(1001);
 if(rows.length>1000)throw new Error("Muse receiver projection exceeds its bounded declaration");
 // An incomplete setup is parked on its existing contact/verification producer;
 // it must neither receive a full custody ACK nor keep a 5s mirror retry alive.
 if(rows.some(b=>b.pairedAt&&!b.revokedAt&&(b.status!=="ready"||!b.receiverContactAt||!b.verifiedReplyAt
   ||b.qualificationExpiresAt&&b.qualificationExpiresAt<=new Date())))return {complete:false as const,records:[],reference:undefined};
 const records:MuseReceiverRecord[]=[];
 for(const b of rows) {
  options.check?.();
  const base={bindingId:b.id,companyId:b.companyId,agentId:b.agentId,operatorId:b.operatorId,generation:b.generation,qualificationExpiresAt:b.qualificationExpiresAt?.getTime()??null};
  if(!b.pairedAt||b.revokedAt){records.push({...base,state:"retired",item:null});continue;}


  const record=await (async()=>{
   const tx=db;
   await options.beforeRead?.();
   const [current]=await tx.select().from(bindings).where(and(eq(bindings.id,b.id),eq(bindings.generation,b.generation),isNull(bindings.revokedAt)));
   if(!current)throw new Error("Muse receiver source changed during publication");
   let agent;
   try {
    const credential=await inspectMuseConnectionCredential(tx,current,namespace.origin+"/api/muse/v1");
    if(credential.state==="pending"){await assertMuseCurrentAuthority(tx,current,true,true);return {...base,state:"idle" as const,item:null};}
    agent=await assertMuseReceiverAuthority(tx,current,namespace.origin+"/api/muse/v1");
   }catch(error){if(error instanceof HttpError&&[401,403,404,410].includes(error.status))return {...base,state:"retired" as const,item:null};throw error;}
   const disabled=!options.enabled;
   if(disabled&&!await hasMuseStopControlAccess(tx,current))return {...base,state:"idle" as const,item:null};
   const stopOnly=disabled||(agent.status==="paused"&&!canConfigureAgentConnection(agent));
   const boundaries=tx.select({boundary:holds.stopBoundary}).from(holds).where(inArray(holds.id,museStopControlBoundaryIds(tx,current)));
   const [selected]=await tx.select({item:mailbox}).from(mailbox).leftJoin(assignments,eq(assignments.id,mailbox.assignmentId)).where(and(eq(mailbox.bindingId,current.id),eq(mailbox.bindingGeneration,current.generation),
    stopOnly?and(eq(mailbox.kind,"authority_revoked"),sql`${mailbox.id} > ${current.workerCursor}`,inArray(sql`${mailbox.references}->'boundary'`,boundaries)):
    sql`((${mailbox.kind}='assignment' and ${assignments.claimedAt} is null and ${assignments.status}='offered') or (${mailbox.kind}='readiness_challenge' and ${!!current.challengeHash&&!!current.challengeExpiresAt&&current.challengeExpiresAt>new Date()} and ${mailbox.id}>${current.workerCursor} and encode(sha256(convert_to(${mailbox.references}->>'nonce','UTF8')),'hex')=${current.challengeHash}) or (${mailbox.kind} not in ('assignment','readiness_challenge') and ${mailbox.id}>${current.workerCursor}))`)).orderBy(asc(mailbox.id)).limit(1);
   return {...base,state:selected?"available" as const:"idle" as const,item:selected?{sourceEventId:selected.item.sourceEventId,attempt:selected.item.signalAttempt,notifiedAt:selected.item.signalNotifiedAt?.getTime()??null,
    expiresAt:selected.item.kind==="readiness_challenge"?current.challengeExpiresAt!.getTime():null}:null};
  })();
  options.check?.();
  records.push(record);
 }
 return {complete:true as const,records,reference:{profile:"hosted-muse-v1" as const,generation:museReceiverGeneration(namespace,revision,records),count:records.length,...(options.contactImportWakeVersion===1?{contactImportWakeVersion:1 as const}:{})}};
}
