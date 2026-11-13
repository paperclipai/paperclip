import {eq} from "drizzle-orm";
import {mcpOauthDeviceRequests as devices,type Db} from "@paperclipai/db";
import {deriveLocalEncryptedInstanceSecret} from "../../secrets/local-encrypted-provider.js";
import {mcpDeviceStatusEntrySchema,mcpDeviceStatusFingerprint,mcpDeviceStatusGeneration,mcpDeviceStatusKeyId} from "./device-status-contract.js";
import type {McpClientMirrorReceipt} from "./client-mirror-contract.js";
import type {IdleMcpInspectionBudget} from "./idle-wake-proof.js";
import type {IdleDeadlineSnapshot} from "../idle-deadline-types.js";

export async function readIdleMcpDeviceStatus(tx:Pick<Db,"select">,input:{enabled:boolean;receipt?:McpClientMirrorReceipt;budget:IdleMcpInspectionBudget;key?:()=>string}):Promise<IdleDeadlineSnapshot>{
  if(!input.enabled)return{blocked:false,state:"absent",deadlines:[]};
  const receipt=input.receipt;if(!receipt?.deviceStatus)return{blocked:true,state:"missing-device-status-proof",deadlines:[]};
  input.budget.check();
  let key:string;
  try{key=input.key?input.key():deriveLocalEncryptedInstanceSecret(`mcp-device-status:v1:${receipt.instanceId}`,process.env,{readOnly:true});}
  catch{return{blocked:true,state:"device-status-key-unavailable",deadlines:[]};}
  if(mcpDeviceStatusKeyId(key)!==receipt.deviceStatus.keyId)return{blocked:true,state:"device-status-key-replaced",deadlines:[]};
  await input.budget.beforeRead();
  const rows=await tx.select({requestId:devices.id,deviceCodeHash:devices.deviceCodeHash,clientId:devices.clientId,resource:devices.resource,ingressOwner:devices.ingressOwner,status:devices.status,expiresAt:devices.expiresAt}).from(devices).where(eq(devices.resource,receipt.origin+"/mcp/paperclip")).orderBy(devices.id).limit(1001);
  input.budget.check();
  if(rows.length>1000)return{blocked:true,state:"device-status-overflow",deadlines:[]};
  const entries=rows.map(row=>{input.budget.check();return mcpDeviceStatusEntrySchema.parse({requestId:row.requestId,clientId:row.clientId,resource:row.resource,ingressOwner:row.ingressOwner,status:row.status,expiresAt:row.expiresAt.getTime(),fingerprint:mcpDeviceStatusFingerprint(key,row.deviceCodeHash,row.clientId,row.resource)});});
  const generation=mcpDeviceStatusGeneration({instanceId:receipt.instanceId,origin:receipt.origin,revision:receipt.revision,keyId:receipt.deviceStatus.keyId},entries);
  return{blocked:generation!==receipt.deviceStatus.generation||entries.length!==receipt.deviceStatus.count,state:[receipt.deviceStatus,generation],deadlines:[]};
}
