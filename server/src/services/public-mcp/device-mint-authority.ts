import { dotDeviceMintSchema,dotDeviceMintDigest } from "./dot-device-mint.js";
import { paperclipCloudConnectorConfigFromEnv } from "../paperclip-cloud-connector.js";
import { unauthorized } from "../../errors.js";
import type { Request } from "express";
import { CLOUD_CONTROL_HEADER,verifyCloudControlAssertion,getCloudRuntimeIdentity } from "../cloud-runtime-identity.js";

export interface McpDeviceMintContext {readonly resource:string;readonly stackId:string;readonly expiresAt:number;readonly instanceId?:string}
const verified=new WeakSet<object>();
export function verifyMcpDeviceMintContext(req:Pick<Request,"get">,resource:string,body?:unknown):McpDeviceMintContext|undefined{
  const compactJws=req.get(CLOUD_CONTROL_HEADER)?.trim();if(!compactJws)return;
  const dot=new URL(resource).pathname === "/mcp/runner";
  if(!dot&&new URL(resource).pathname!=="/mcp/paperclip")throw unauthorized("MCP device mint context has another resource");
  let instanceId:string|undefined;
  if(dot) {
    try {
      if(compactJws.length>8192)throw new Error();
      const parsed=dotDeviceMintSchema.parse(body),connector=paperclipCloudConnectorConfigFromEnv();
      if(!connector||parsed.expected_instance_id!==connector.instanceId||parsed.resource!==resource)throw new Error();
      const parts=compactJws.split(".");if(parts.length!==3)throw new Error();
      const untrusted:unknown=JSON.parse(Buffer.from(parts[1]!,"base64url").toString("utf8"));
      if(!untrusted||typeof untrusted!=="object"||Array.isArray(untrusted)||!("requestId" in untrusted)||typeof untrusted.requestId!=="string"
        || !/^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.[a-f0-9]{64}$/.test(untrusted.requestId)||untrusted.requestId.slice(37)!==dotDeviceMintDigest(parsed)
        || !("iat" in untrusted)||!("exp" in untrusted)||typeof untrusted.iat!=="number"||typeof untrusted.exp!=="number"
        || !Number.isSafeInteger(untrusted.iat)||!Number.isSafeInteger(untrusted.exp)||untrusted.exp<=untrusted.iat||untrusted.exp-untrusted.iat>60)throw new Error();
      instanceId=connector.instanceId;
    }catch{throw unauthorized("Invalid Dot device mint binding");}
  }
  let claims:ReturnType<typeof verifyCloudControlAssertion>;
  try{claims=verifyCloudControlAssertion({compactJws,expectedAction:"mcp-device:mint"});}catch{throw unauthorized("Invalid MCP device mint assertion");}
  const context=Object.freeze({resource,stackId:claims.sub,expiresAt:claims.exp*1000,...(instanceId?{instanceId}:{})});verified.add(context);return context;
}
export function consumeMcpDeviceMintContext(context:McpDeviceMintContext|undefined,resource:string){
  if(!context)return;
  if(context.resource!==resource||!verified.delete(context))throw unauthorized("MCP device mint context is unavailable");
  return context;
}

export function assertCurrentMcpDeviceMint(context:McpDeviceMintContext,resource:string){
  const identity=getCloudRuntimeIdentity();
  if(!identity||context.stackId!==identity.stackId||(resource!==identity.canonicalOrigin+"/mcp/paperclip"&&resource!==identity.canonicalOrigin+"/mcp/runner")||context.expiresAt<=Date.now()||context.instanceId&&context.instanceId!==paperclipCloudConnectorConfigFromEnv()?.instanceId)throw unauthorized("MCP device mint identity changed");
}
