import { eq } from "drizzle-orm";
import { mcpOauthClientMirrorState as state,type Db } from "@paperclipai/db";
import type { IdleMcpInspectionBudget } from "./idle-wake-proof.js";
import { mcpClientMirrorGeneration,mcpClientMirrorReceiptSchema,type McpClientMirrorReceipt } from "./client-mirror-contract.js";
import type { IdleDeadlineSnapshot } from "../idle-deadline-types.js";

export async function readIdleMcpClientMirror(tx:Pick<Db,"select">,context:{budget:IdleMcpInspectionBudget;enabled:boolean;origin?:string;instanceId?:string;managedStackId?:string;authorizationOrigin?:string;unsupportedProfiles?:boolean}):Promise<IdleDeadlineSnapshot&{receipt?:McpClientMirrorReceipt}>{
  if(!context.managedStackId)return{blocked:context.enabled,state:context.enabled?"unconfigured-front-door":"absent",deadlines:[]};
  await context.budget.beforeRead();
  const[row]=await tx.select().from(state).where(eq(state.id,"public"));context.budget.check();
  const receipt=mcpClientMirrorReceiptSchema.safeParse(row?.receipt);
  if(!context.origin||!context.instanceId){
    const debt=Boolean(row?.remoteResponsibility||row?.receipt!==null&&row?.receipt!==undefined&&(!receipt.success||receipt.data.enabled));
    return{blocked:context.enabled||debt,state:debt?["unavailable-published-front-door",row?.revision??null]:context.enabled?"unconfigured-front-door":"absent",deadlines:[]};
  }
  if(!context.enabled){
    if(!row||!row.remoteResponsibility&&(row.receipt===null||receipt.success&&!receipt.data.enabled&&receipt.data.instanceId===context.instanceId&&receipt.data.origin===context.origin&&receipt.data.revision<=row.revision&&receipt.data.generation===mcpClientMirrorGeneration(receipt.data)))return{blocked:false,state:"absent",deadlines:[]};
    return{blocked:true,state:["pending-front-door-disable",row.revision],deadlines:[]};
  }
  if(!row||!row.enabled||!row.remoteResponsibility||!Number.isSafeInteger(row.revision)||row.revision<0||!receipt.success||!receipt.data.enabled||receipt.data.revision!==row.revision||receipt.data.instanceId!==context.instanceId||receipt.data.origin!==context.origin||(receipt.data.authorizationOrigin??receipt.data.origin)!==(context.authorizationOrigin??context.origin)||receipt.data.generation!==mcpClientMirrorGeneration(receipt.data))return{blocked:true,state:["pending-client-mirror",row?.revision??null],deadlines:[]};
  const ready=receipt.data.frontDoor==="tenant-personal-v1"&&receipt.data.deviceStatus!==undefined&&row.deviceCutoverAt instanceof Date&&Number.isFinite(row.deviceCutoverAt.getTime())&&typeof row.deviceCutoverStackId==="string"&&row.deviceCutoverStackId.length>0&&(receipt.data.authorizationOrigin??receipt.data.origin)===receipt.data.origin&&!context.unsupportedProfiles;
  return{blocked:!ready,state:[ready?"tenant-facade-v1":"incomplete-front-door",receipt.data,row.deviceCutoverStackId,row.deviceCutoverAt?.toISOString()??null],receipt:receipt.data,deadlines:[]};
}
