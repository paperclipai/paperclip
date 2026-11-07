import { and, asc, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { mcpOauthRequests, mcpOauthDeviceRequests, type Db } from "@paperclipai/db";
import type { IdleDeadlineSnapshot } from "../idle-deadline-types.js";
import type { IdleMcpInspectionBudget } from "./idle-wake-proof.js";

export function pendingMcpCodePredicate(now: number) {
  return and(sql`${mcpOauthRequests.resource} ~ '/mcp/(paperclip|runner)$'`,isNotNull(mcpOauthRequests.codeHash),isNull(mcpOauthRequests.consumedAt),gt(mcpOauthRequests.expiresAt,new Date(now)));
}
export function pendingMcpDevicePredicate(now: number) {
  return and(sql`${mcpOauthDeviceRequests.resource} ~ '/mcp/(paperclip|runner)$'`,gt(mcpOauthDeviceRequests.expiresAt,new Date(now)),
    or(sql`${mcpOauthDeviceRequests.status} NOT IN ('pending','denied','consumed')`,and(sql`${mcpOauthDeviceRequests.status} = 'pending'`,isNotNull(mcpOauthDeviceRequests.grantId))));
}
export async function readIdleMcpAuthorizationHandoffs(tx: Pick<Db,"select">,input: {now:number;budget:IdleMcpInspectionBudget}): Promise<IdleDeadlineSnapshot> {
  await input.budget.beforeRead();
  const codes = await tx.select({ id:mcpOauthRequests.id,grantId:mcpOauthRequests.grantId,decidedAt:mcpOauthRequests.decidedAt,expiresAt:mcpOauthRequests.expiresAt,
    codeValid:sql<boolean>`${mcpOauthRequests.codeHash} ~ '^[a-f0-9]{64}$'` }).from(mcpOauthRequests)
    .where(pendingMcpCodePredicate(input.now)).orderBy(asc(mcpOauthRequests.expiresAt)).limit(1001);
  input.budget.check();await input.budget.beforeRead();
  const devices = await tx.select({id:mcpOauthDeviceRequests.id,grantId:mcpOauthDeviceRequests.grantId,status:mcpOauthDeviceRequests.status,expiresAt:mcpOauthDeviceRequests.expiresAt}).from(mcpOauthDeviceRequests)
    .where(pendingMcpDevicePredicate(input.now)).orderBy(asc(mcpOauthDeviceRequests.expiresAt)).limit(1001);
  input.budget.check();
  const rows = [...codes.map(row=>({id:row.id,grantId:row.grantId,expiresAt:row.expiresAt,valid:row.codeValid===true&&row.decidedAt!==null})),
    ...devices.map(row=>({id:row.id,grantId:row.grantId,expiresAt:row.expiresAt,valid:row.status==="approved"}))];
  if (!Number.isFinite(input.now)||rows.length>1000) return {blocked:true,state:["incomplete-authorization-handoff"],deadlines:[]};
  const state:unknown[]=[],deadlines:number[]=[];
  for(const row of rows){
    input.budget.check();const at=row.expiresAt.getTime();
    if(!row.valid||!row.grantId||!Number.isFinite(at)||at<=input.now)return {blocked:true,state:["uncertain-authorization-handoff"],deadlines:[]};
    state.push([row.id,row.grantId,row.expiresAt.toISOString()]);deadlines.push(at);
  }
  return {blocked:rows.length>0,state,deadlines};
}
