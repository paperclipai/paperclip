import { and,asc,eq,exists,gt,isNotNull,ne,notInArray } from "drizzle-orm";
import { mcpOauthClientMirrorState as state,mcpOauthDeviceRequests as devices,type Db } from "@paperclipai/db";
import { managedMcpDeviceScope } from "./device-cutover.js";
import type { IdleMcpInspectionBudget } from "./idle-wake-proof.js";
import type { IdleDeadlineSnapshot } from "../idle-deadline-types.js";

export function pendingLegacyMcpDevicePredicate(tx:Pick<Db,"select">,now:number){
  const scope=managedMcpDeviceScope();if(!scope)return;
  return and(eq(devices.resource,scope.resource),ne(devices.ingressOwner,"cloud"),gt(devices.expiresAt,new Date(now)),
    notInArray(devices.status,["denied","consumed"]),exists(tx.select({id:state.id}).from(state).where(and(eq(state.id,"public"),isNotNull(state.deviceCutoverStackId),isNotNull(state.deviceCutoverAt)))));
}
export async function readIdleMcpDeviceCutover(tx:Pick<Db,"select">,context:{now:number;budget:IdleMcpInspectionBudget}):Promise<IdleDeadlineSnapshot>{
  const predicate=pendingLegacyMcpDevicePredicate(tx,context.now);if(!predicate)return{blocked:false,state:"absent",deadlines:[]};
  await context.budget.beforeRead();
  const rows=await tx.select({id:devices.id,status:devices.status,ingressOwner:devices.ingressOwner,expiresAt:devices.expiresAt}).from(devices).where(predicate).orderBy(asc(devices.expiresAt)).limit(1001);
  context.budget.check();
  if(rows.length>1000||!Number.isFinite(context.now))return{blocked:true,state:"uncertain-legacy-device-drain",deadlines:[]};
  const deadlines:number[]=[],snapshot:unknown[]=[];
  for(const row of rows){context.budget.check();const at=row.expiresAt.getTime();
    if(row.ingressOwner!=="tenant"||!["pending","approved"].includes(row.status)||!Number.isFinite(at)||at<=context.now)return{blocked:true,state:"uncertain-legacy-device-drain",deadlines:[]};
    deadlines.push(at);snapshot.push([row.id,row.status,row.expiresAt.toISOString()]);
  }
  return{blocked:rows.length>0,state:snapshot,deadlines};
}
