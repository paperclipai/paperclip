import { HttpError } from "../../errors.js";
import { paperclipCloudConnectorConfigFromEnv } from "../paperclip-cloud-connector.js";
import { DELIVERY_QUEUES,notifyDeliveryWork } from "../delivery-work-notifications.js";
import { eq,sql } from "drizzle-orm";
import { mcpOauthClientMirrorState as state,type Db } from "@paperclipai/db";
import { getCloudRuntimeIdentity } from "../cloud-runtime-identity.js";
import { mcpClientMirrorGeneration,mcpClientMirrorReceiptSchema,type McpClientMirrorReceipt } from "./client-mirror-contract.js";

export function currentMcpDeviceCutoverStack(resource:string){
  const identity=getCloudRuntimeIdentity();return identity&&resource===identity.canonicalOrigin+"/mcp/paperclip"?identity.stackId:undefined;
}
export async function installMcpDeviceCutover(tx:Db,receipt:McpClientMirrorReceipt){
  await installDotDeviceCutover(tx, receipt);
  if(receipt.generation!==mcpClientMirrorGeneration(receipt)||!receipt.enabled||!receipt.deviceStatus||receipt.frontDoor!=="tenant-personal-v1"||receipt.authorizationOrigin&&receipt.authorizationOrigin!==receipt.origin)return;
  const stackId=currentMcpDeviceCutoverStack(receipt.origin+"/mcp/paperclip");if(!stackId)return;
  const [row]=await tx.select().from(state).where(eq(state.id,"public")).for("update");
  if(!row||row.revision!==receipt.revision||currentMcpDeviceCutoverStack(receipt.origin+"/mcp/paperclip")!==stackId
    ||row.deviceCutoverAt!==null&&row.deviceCutoverStackId===stackId)return;
  await notifyDeliveryWork(tx,DELIVERY_QUEUES.mcpIngressHandoffs);
  await tx.update(state).set({deviceCutoverStackId:stackId,deviceCutoverAt:row.deviceCutoverAt??sql`clock_timestamp()`}).where(eq(state.id,"public"));
}
export async function requiresMcpDeviceBroker(tx:Pick<Db,"select">,resource:string){
  const dot = currentDotDeviceNamespace(resource);
  if (dot) {
    const [row] = await tx.select({ latch: state.dotDeviceCutover }).from(state).where(eq(state.id, "public"));
    const current = currentDotDeviceNamespace(resource), latch = row?.latch;
    return Boolean(current && latch?.version === 1 && latch.profile === "hosted-dot-v1"
      && latch.stackId === current.stackId && latch.instanceId === current.instanceId && latch.origin === current.origin
      && current.stackId === dot.stackId && current.instanceId === dot.instanceId && current.origin === dot.origin);
  }
  const stackId=currentMcpDeviceCutoverStack(resource);if(!stackId)return false;
  const[row]=await tx.select({stackId:state.deviceCutoverStackId,at:state.deviceCutoverAt,receipt:state.receipt}).from(state).where(eq(state.id,"public"));
  if(row?.stackId!==stackId||!(row.at instanceof Date)||!Number.isFinite(row.at.getTime())||currentMcpDeviceCutoverStack(resource)!==stackId)return false;
  if(row.receipt===null)return true;
  const receipt=mcpClientMirrorReceiptSchema.safeParse(row.receipt);
  return receipt.success&&receipt.data.origin+"/mcp/paperclip"===resource
    &&receipt.data.generation===mcpClientMirrorGeneration(receipt.data);
}

export function managedMcpDeviceScope(){
  const identity=getCloudRuntimeIdentity();return identity?{stackId:identity.stackId,resource:identity.canonicalOrigin+"/mcp/paperclip"}:undefined;
}

function currentDotDeviceNamespace(resource: string) {
  const identity = getCloudRuntimeIdentity();
  if (!identity || resource !== identity.canonicalOrigin + "/mcp/runner") return;
  const connector = paperclipCloudConnectorConfigFromEnv();
  if (!connector) return;
  return { stackId: identity.stackId, instanceId: connector.instanceId, origin: identity.canonicalOrigin };
}
async function installDotDeviceCutover(tx: Db, receipt: McpClientMirrorReceipt) {
  if (receipt.dotProfile !== "hosted-dot-v1" || !receipt.enabled || !receipt.deviceStatus
    || receipt.frontDoor !== "tenant-personal-v1" || receipt.generation !== mcpClientMirrorGeneration(receipt)
    || receipt.authorizationOrigin && receipt.authorizationOrigin !== receipt.origin) return;
  const namespace = currentDotDeviceNamespace(receipt.origin + "/mcp/runner");
  if (!namespace || namespace.instanceId !== receipt.instanceId) return;
  const [row] = await tx.select().from(state).where(eq(state.id, "public")).for("update");
  const current = currentDotDeviceNamespace(receipt.origin + "/mcp/runner");
  if (!row || row.revision !== receipt.revision || !current || current.stackId !== namespace.stackId
    || current.instanceId !== namespace.instanceId || current.origin !== namespace.origin) return;
  const latch = row.dotDeviceCutover;
  if (latch?.version === 1 && latch.profile === "hosted-dot-v1" && latch.stackId === current.stackId
    && latch.instanceId === current.instanceId && latch.origin === current.origin) return;
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.mcpIngressHandoffs);
  await tx.update(state).set({ dotDeviceCutover: { version: 1, profile: "hosted-dot-v1", ...current } }).where(eq(state.id, "public"));
}

// Called by the normal device mint transaction while its existing admission
// advisory lock is held, before this transaction invalidates the mirror revision.
export async function assertDotDeviceProfileAck(tx: Pick<Db, "select">, resource: string, instanceId?: string) {
  const namespace = currentDotDeviceNamespace(resource);
  if (!namespace || !instanceId || namespace.instanceId !== instanceId) throw new HttpError(503, "The hosted Dot connection is being reconciled.");
  const [row] = await tx.select().from(state).where(eq(state.id, "public"));
  const parsed = mcpClientMirrorReceiptSchema.safeParse(row?.receipt), latch = row?.dotDeviceCutover;
  const current = currentDotDeviceNamespace(resource);
  if (!current || current.stackId !== namespace.stackId || current.instanceId !== namespace.instanceId || current.origin !== namespace.origin
    || !row?.enabled || !row.remoteResponsibility || !parsed.success || !parsed.data.enabled
    || parsed.data.dotProfile !== "hosted-dot-v1" || parsed.data.frontDoor !== "tenant-personal-v1" || !parsed.data.deviceStatus
    || parsed.data.revision !== row.revision || parsed.data.instanceId !== namespace.instanceId || parsed.data.origin !== namespace.origin
    || (parsed.data.authorizationOrigin ?? parsed.data.origin) !== namespace.origin
    || parsed.data.generation !== mcpClientMirrorGeneration(parsed.data)
    || latch?.version !== 1 || latch.profile !== "hosted-dot-v1" || latch.stackId !== namespace.stackId
    || latch.instanceId !== namespace.instanceId || latch.origin !== namespace.origin) {
    throw new HttpError(503, "The hosted Dot connection is being reconciled.");
  }
}
