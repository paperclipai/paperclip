import { unauthorized } from "../../errors.js";
import type { Request } from "express";
import { CLOUD_CONTROL_HEADER,verifyCloudControlAssertion,getCloudRuntimeIdentity } from "../cloud-runtime-identity.js";

export interface McpDeviceMintContext {readonly resource:string;readonly stackId:string;readonly expiresAt:number}
const verified=new WeakSet<object>();
export function verifyMcpDeviceMintContext(req:Pick<Request,"get">,resource:string):McpDeviceMintContext|undefined{
  const compactJws=req.get(CLOUD_CONTROL_HEADER)?.trim();if(!compactJws)return;
  if(new URL(resource).pathname!=="/mcp/paperclip")throw unauthorized("MCP device mint context has another resource");
  let claims:ReturnType<typeof verifyCloudControlAssertion>;
  try{claims=verifyCloudControlAssertion({compactJws,expectedAction:"mcp-device:mint"});}catch{throw unauthorized("Invalid MCP device mint assertion");}
  const context=Object.freeze({resource,stackId:claims.sub,expiresAt:claims.exp*1000});verified.add(context);return context;
}
export function consumeMcpDeviceMintContext(context:McpDeviceMintContext|undefined,resource:string){
  if(!context)return;
  if(context.resource!==resource||!verified.delete(context))throw unauthorized("MCP device mint context is unavailable");
  return context;
}

export function assertCurrentMcpDeviceMint(context:McpDeviceMintContext,resource:string){
  const identity=getCloudRuntimeIdentity();
  if(!identity||context.stackId!==identity.stackId||resource!==identity.canonicalOrigin+"/mcp/paperclip"||context.expiresAt<=Date.now())throw unauthorized("MCP device mint identity changed");
}
