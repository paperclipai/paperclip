import { and,eq,sql,type SQL } from "drizzle-orm";
import { museAgentBindings as bindings,agents,companies,type Db } from "@paperclipai/db";
import type { IdleDeadlineSnapshot } from "../../services/idle-deadline-types.js";
import type { McpClientMirrorReceipt } from "../../services/public-mcp/client-mirror-contract.js";
import type { IdleMcpInspectionBudget,IdleMcpWakeProof } from "../../services/public-mcp/idle-wake-proof.js";
import { idleExternalAgentHistoryChecks } from "./idle-history-proof.js";
import { readMuseReceiverProjection } from "./muse-hosted-projection.js";
export interface IdleMuseReceiverProof extends IdleDeadlineSnapshot {
 coveredBindings:Array<{id:string;generation:number;grantId:string|null;retired:boolean}>;
}
/** A current full ACK plus a fresh current-auth projection, never a flag alone. */
export async function readIdleMuseReceiverProof(tx:Pick<Db,"select">,context:{enabled:boolean;contactImportWakeVersion?:1;namespace?:{stackId:string;instanceId:string;origin:string};receipt?:McpClientMirrorReceipt;now:number;budget:IdleMcpInspectionBudget}):Promise<IdleMuseReceiverProof>{
 const blocked=(state:string):IdleMuseReceiverProof=>({blocked:true,state,deadlines:[],coveredBindings:[]});
 if(!context.enabled)return {blocked:false,state:"disabled",deadlines:[],coveredBindings:[]};
 const {namespace,receipt}=context;
 if(context.contactImportWakeVersion!==1||receipt?.museReceivers?.contactImportWakeVersion!==1)return blocked("missing-muse-contact-import-wake");
 if(!namespace||!receipt?.enabled||receipt.instanceId!==namespace.instanceId||receipt.origin!==namespace.origin||!receipt.museReceivers)return blocked("missing-muse-receiver-owner");
 const projection=await readMuseReceiverProjection(tx,namespace,receipt.revision,{enabled:true,contactImportWakeVersion:context.contactImportWakeVersion,beforeRead:context.budget.beforeRead,check:context.budget.check});
 if(!projection.complete)return blocked("pending-muse-receiver-setup");
 if(JSON.stringify(projection.reference)!==JSON.stringify(receipt.museReceivers))return blocked("changed-muse-receiver-owner");
 await context.budget.beforeRead();
 const rows=await tx.select({id:bindings.id,generation:bindings.generation,grantId:bindings.grantId,pairedAt:bindings.pairedAt,agentExists:agents.id,companyExists:companies.id}).from(bindings)
  .leftJoin(agents,and(eq(agents.id,bindings.agentId),eq(agents.companyId,bindings.companyId))).leftJoin(companies,eq(companies.id,bindings.companyId)).limit(1001);context.budget.check();
 if(rows.length!==projection.records.length)return blocked("changed-muse-receiver-count");
 const coveredBindings:IdleMuseReceiverProof["coveredBindings"]=[],deadlines:number[]=[];
 for(const row of rows){
  if(!row.agentExists||!row.companyExists)return blocked("orphaned-muse-receiver");
  const record=projection.records.find(record=>record.bindingId===row.id&&record.generation===row.generation);
  if(!record)return blocked("changed-muse-receiver-generation");
  if(record.item)return blocked("pending-muse-mailbox");
  if(record.state!=="retired"&&record.qualificationExpiresAt!==null){if(record.qualificationExpiresAt<=context.now)return blocked("due-muse-qualification");deadlines.push(record.qualificationExpiresAt);}
  if(row.pairedAt)coveredBindings.push({id:row.id,generation:row.generation,grantId:row.grantId,retired:record.state==="retired"});
 }
 return {blocked:false,state:["hosted-muse-v1",projection.reference,coveredBindings],deadlines,coveredBindings};
}
/** Replace only the exact covered binding rows. Unknown legacy credentials,
 * assignments, effects, mailboxes, input and stop holds retain their old checks. */
export function idleMuseWorkQuery(reason:string,proof:IdleMuseReceiverProof|undefined,ingress:IdleMcpWakeProof|undefined):SQL|undefined{
 if(reason!=="muse_agent_bindings"||!proof||proof.blocked||!ingress)return;
 const covered=proof.coveredBindings.filter(row=>row.retired||row.grantId!==null&&ingress.grantIds.includes(row.grantId));
 if(!covered.length)return;
 const original=idleExternalAgentHistoryChecks.find(check=>check.reason==="muse_agent_bindings");if(!original)return;
 return sql`${sql.raw(original.query)} AND NOT (${sql.join(covered.map(row=>sql`(b.id=${row.id}::uuid AND b.generation=${row.generation})`),sql` OR `)})`;
}
