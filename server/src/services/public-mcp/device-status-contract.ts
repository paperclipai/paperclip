import {createHash,createHmac} from "node:crypto";
import {z} from "zod";

const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const mcpDeviceStatusEntrySchema=z.object({requestId:z.uuid(),fingerprint:digest,clientId:z.string().min(1).max(2048),resource:z.string().url().max(2048),ingressOwner:z.enum(["tenant","cloud"]),status:z.enum(["pending","approved","denied","consumed"]),expiresAt:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict();
export const mcpDeviceStatusReferenceSchema=z.object({keyId:digest,generation:digest,count:z.number().int().min(0).max(1000)}).strict();
export type McpDeviceStatusEntry=z.infer<typeof mcpDeviceStatusEntrySchema>;
export type McpDeviceStatusReference=z.infer<typeof mcpDeviceStatusReferenceSchema>;
export function mcpDeviceStatusKeyId(key:string){
  if(Buffer.from(key,"base64url").length!==32)throw new Error("Invalid MCP device status key");
  return createHash("sha256").update("mcp-device-status-key-v1:"+key).digest("hex");
}
export function mcpDeviceStatusFingerprint(key:string,hash:string,clientId:string,resource:string){
  if(!/^[a-f0-9]{64}$/.test(hash))throw new Error("Invalid MCP device status credential hash");mcpDeviceStatusKeyId(key);
  return createHmac("sha256",Buffer.from(key,"base64url")).update(JSON.stringify(["mcp-device-status-v1",hash,clientId,resource])).digest("hex");
}
export function mcpDeviceStatusGeneration(input:{instanceId:string;origin:string;revision:number;keyId:string},entries:McpDeviceStatusEntry[]){
  if(entries.length>1000)throw new Error("MCP device status set exceeds canonical1000 admission bound");
  const parsed=entries.map(entry=>mcpDeviceStatusEntrySchema.parse(entry)).sort((a,b)=>Buffer.compare(Buffer.from(a.requestId),Buffer.from(b.requestId)));
  if(new Set(parsed.map(entry=>entry.requestId)).size!==parsed.length||new Set(parsed.map(entry=>entry.fingerprint)).size!==parsed.length||parsed.some(entry=>entry.resource!==input.origin+"/mcp/paperclip"))throw new Error("MCP device status identity changed");
  return createHash("sha256").update(JSON.stringify(["mcp-device-status-snapshot-v1",input,parsed])).digest("hex");
}
export function mcpDeviceStatusError(entry:McpDeviceStatusEntry|undefined,input:{clientId:string;resource:string;now:number;publicLegacy:boolean}):"invalid_grant"|"expired_token"|"access_denied"|"authorization_pending"|"tenant_required"{
  if(!entry||entry.clientId!==input.clientId||entry.resource!==input.resource||input.publicLegacy&&entry.ingressOwner!=="tenant")return"invalid_grant";
  if(entry.status==="consumed")return"invalid_grant";
  if(entry.expiresAt<=input.now)return"expired_token";
  if(entry.status==="denied")return"access_denied";
  return entry.status==="approved"||input.publicLegacy?"tenant_required":"authorization_pending";
}
