import { DELIVERY_QUEUES,notifyDeliveryWork } from "../delivery-work-notifications.js";
import { eq,sql } from "drizzle-orm";
import { mcpOauthClientMirrorState as state,type Db } from "@paperclipai/db";
import { getCloudRuntimeIdentity } from "../cloud-runtime-identity.js";
import type { McpClientMirrorReceipt } from "./client-mirror-contract.js";

export function currentMcpDeviceCutoverStack(resource:string){
  const identity=getCloudRuntimeIdentity();return identity&&resource===identity.canonicalOrigin+"/mcp/paperclip"?identity.stackId:undefined;
}
export async function installMcpDeviceCutover(tx:Db,receipt:McpClientMirrorReceipt){
  if(!receipt.enabled||!receipt.deviceStatus||receipt.frontDoor!=="tenant-personal-v1"||receipt.authorizationOrigin&&receipt.authorizationOrigin!==receipt.origin)return;
  const stackId=currentMcpDeviceCutoverStack(receipt.origin+"/mcp/paperclip");if(!stackId)return;
  const [row]=await tx.select().from(state).where(eq(state.id,"public")).for("update");
  if(!row||row.revision!==receipt.revision||row.deviceCutoverAt!==null)return;
  await notifyDeliveryWork(tx,DELIVERY_QUEUES.mcpIngressHandoffs);
  await tx.update(state).set({deviceCutoverStackId:stackId,deviceCutoverAt:sql`clock_timestamp()`}).where(eq(state.id,"public"));
}
export async function requiresMcpDeviceBroker(tx:Pick<Db,"select">,resource:string){
  const stackId=currentMcpDeviceCutoverStack(resource);if(!stackId)return false;
  const[row]=await tx.select({stackId:state.deviceCutoverStackId,at:state.deviceCutoverAt}).from(state).where(eq(state.id,"public"));
  return Boolean(row?.at);
}

export function managedMcpDeviceScope(){
  const identity=getCloudRuntimeIdentity();return identity?{stackId:identity.stackId,resource:identity.canonicalOrigin+"/mcp/paperclip"}:undefined;
}
