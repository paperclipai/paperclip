import {z} from "zod";
import type {Db} from "@paperclipai/db";
import {getCloudRuntimeIdentity} from "../cloud-runtime-identity.js";
import {paperclipCloudConnectorConfigFromEnv} from "../paperclip-cloud-connector.js";
import {instanceSettingsService} from "../instance-settings.js";
import {readIdleMcpClientMirror} from "./idle-client-mirror.js";
import {McpEventError} from "./event-webhooks.js";
import type {PublicMcpConfig} from "./oauth.js";

export const cloudEventAuthoritySchema=z.object({token:z.string().min(1).max(24000),expiresAt:z.number().finite(),transport:z.literal("tenant-personal-v1").optional()}).strict();
export type CloudEventAuthority=z.infer<typeof cloudEventAuthoritySchema>;
export function currentTenantEventOrigin(config:PublicMcpConfig){
  const identity=getCloudRuntimeIdentity();
  if(!identity||config.origin!==identity.canonicalOrigin||config.resource!==identity.canonicalOrigin+"/mcp/paperclip"||config.authorizationOrigin&&config.authorizationOrigin!==identity.canonicalOrigin)throw new McpEventError(-32602,"The hosted subscription authority changed.");
  return identity;
}
export async function cloudEventValidationOrigin(db:Db,config:PublicMcpConfig,centralOrigin:string|undefined,authority:CloudEventAuthority){
  const parsed=cloudEventAuthoritySchema.safeParse(authority);
  if(!parsed.success)throw new McpEventError(-32602,"Invalid hosted subscription authority.");
  if(parsed.data.transport===undefined)return centralOrigin;
  const identity=currentTenantEventOrigin(config),connector=paperclipCloudConnectorConfigFromEnv();
  if(!centralOrigin||!connector)throw new McpEventError(-32602,"The hosted subscription authority is unavailable.");
  const feature=await instanceSettingsService(db).getExperimentalReadOnly();
  const proof=await readIdleMcpClientMirror(db,{enabled:feature.enablePublicMcp,origin:identity.canonicalOrigin,authorizationOrigin:config.authorizationOrigin,instanceId:connector.instanceId,managedStackId:identity.stackId,budget:{beforeRead:async()=>{},check:()=>{}}});
  if(proof.blocked)throw new McpEventError(-32602,"The hosted subscription authority is being reconciled.");
  return identity.canonicalOrigin;
}
