import { DELIVERY_QUEUES,notifyDeliveryWork } from "../delivery-work-notifications.js";
import { eq,sql } from "drizzle-orm";
import { mcpOauthClientMirrorState as state,type Db } from "@paperclipai/db";
import { getCloudRuntimeIdentity } from "../cloud-runtime-identity.js";
import { mcpClientMirrorGeneration,mcpClientMirrorReceiptSchema,type McpClientMirrorReceipt } from "./client-mirror-contract.js";

export function currentMcpDeviceCutoverStack(resource:string){
  const identity=getCloudRuntimeIdentity();return identity&&resource===identity.canonicalOrigin+"/mcp/paperclip"?identity.stackId:undefined;
}
export async function installMcpDeviceCutover(tx:Db,receipt:McpClientMirrorReceipt){
  if(receipt.generation!==mcpClientMirrorGeneration(receipt)||!receipt.enabled||!receipt.deviceStatus||receipt.frontDoor!=="tenant-personal-v1"||receipt.authorizationOrigin&&receipt.authorizationOrigin!==receipt.origin)return;
  const stackId=currentMcpDeviceCutoverStack(receipt.origin+"/mcp/paperclip");if(!stackId)return;
  const [row]=await tx.select().from(state).where(eq(state.id,"public")).for("update");
  if(!row||row.revision!==receipt.revision||currentMcpDeviceCutoverStack(receipt.origin+"/mcp/paperclip")!==stackId
    ||row.deviceCutoverAt!==null&&row.deviceCutoverStackId===stackId)return;
  await notifyDeliveryWork(tx,DELIVERY_QUEUES.mcpIngressHandoffs);
  await tx.update(state).set({deviceCutoverStackId:stackId,deviceCutoverAt:row.deviceCutoverAt??sql`clock_timestamp()`}).where(eq(state.id,"public"));
}
export async function requiresMcpDeviceBroker(tx:Pick<Db,"select">,resource:string){
  const stackId=currentMcpDeviceCutoverStack(resource);if(!stackId)return false;
  const[row]=await tx.select({stackId:state.deviceCutoverStackId,at:state.deviceCutoverAt,receipt:state.receipt}).from(state).where(eq(state.id,"public"));
  const receipt=mcpClientMirrorReceiptSchema.safeParse(row?.receipt);
  return row?.stackId===stackId&&row.at instanceof Date&&Number.isFinite(row.at.getTime())
    &&currentMcpDeviceCutoverStack(resource)===stackId&&receipt.success&&receipt.data.origin+"/mcp/paperclip"===resource
    &&receipt.data.generation===mcpClientMirrorGeneration(receipt.data);
}

export function managedMcpDeviceScope(){
  const identity=getCloudRuntimeIdentity();return identity?{stackId:identity.stackId,resource:identity.canonicalOrigin+"/mcp/paperclip"}:undefined;
}
