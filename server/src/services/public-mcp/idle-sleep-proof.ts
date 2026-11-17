import { MUSE_RESOURCE_PATH } from "@paperclipai/shared";
import { hasConnectionEventWakeReceiver } from "../connection-event-wake.js";
import { readIdleMuseReceiverProof,type IdleMuseReceiverProof } from "../../modules/external-agents/index.js";
import { readIdleMcpDeviceStatus } from "./idle-device-status.js";
import { getCloudRuntimeIdentity } from "../cloud-runtime-identity.js";
import { readIdleMcpDeviceCutover } from "./idle-device-cutover.js";
import { readIdleMcpClientMirror } from "./idle-client-mirror.js";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "../instance-settings.js";
import type { PublicMcpConfig } from "./oauth.js";
import type { PublicMcpEvents } from "./events.js";
import { readIdleMcpWakeProof, type IdleMcpWakeProof, type IdleMcpInspectionBudget } from "./idle-wake-proof.js";
import { readIdleMcpSubscriptionProof, type IdleMcpSubscriptionProof } from "./idle-subscription-proof.js";
import { readIdleMcpEventSchedule, type IdleMcpEventScheduleProof } from "./idle-event-schedule.js";
import { readIdleMcpTransferSchedule } from "./idle-transfer-schedule.js";
import { readIdleMcpAuthorizationHandoffs } from "./idle-authorization-handoffs.js";
import type { IdleDeadlineSnapshot } from "../idle-deadline-types.js";

const owners = new WeakMap<object, { config: PublicMcpConfig | null; personal: PublicMcpEvents | null; dot: PublicMcpEvents | null; clientMirrorInstanceId?:string }>();
export function registerIdleMcpOwners(owner: object, services: { config: PublicMcpConfig | null; personal: PublicMcpEvents | null; dot: PublicMcpEvents | null; clientMirrorInstanceId?:string }) {
  owners.set(owner, services);
  return () => { if (owners.get(owner) === services) owners.delete(owner); };
}
export interface IdleMcpSleepProof {
  ingress: IdleMcpWakeProof;
  muse?:IdleMuseReceiverProof;
  subscriptions: IdleMcpSubscriptionProof;
  retries: IdleMcpEventScheduleProof;
  frontDoor: IdleDeadlineSnapshot;
  legacyDevices:IdleDeadlineSnapshot;
  deviceStatus:IdleDeadlineSnapshot;
  transfers: IdleDeadlineSnapshot;
  handoffs: IdleDeadlineSnapshot;
  schedule: IdleDeadlineSnapshot;
  generation: string;
}
export async function readIdleMcpSleepProof(tx: Pick<Db, "select">, owner: object, context: {
  stackId: string; ownerId: string; capabilityGeneration: string; challenge: string; now: number; budget: IdleMcpInspectionBudget;
}) : Promise<IdleMcpSleepProof> {
  const services = owners.get(owner);
  await context.budget.beforeRead();
  const feature = await instanceSettingsService(tx as Db).getExperimentalReadOnly();
  const frontDoor = await readIdleMcpClientMirror(tx,{budget:context.budget,enabled:feature.enablePublicMcp||feature.enableOpenAiDot||(feature.enableMuse||feature.enableGrokBot)&&feature.enableNativeRunner,origin:services?.config?.origin,instanceId:services?.clientMirrorInstanceId,managedStackId:getCloudRuntimeIdentity()?.stackId,authorizationOrigin:services?.config?.authorizationOrigin,dotEnabled:feature.enableOpenAiDot,personalEnabled:feature.enablePublicMcp,museEnabled:feature.enableMuse&&feature.enableNativeRunner,unsupportedProfiles:feature.enableGrokBot&&feature.enableNativeRunner});
  const ingress = await readIdleMcpWakeProof(tx, { ...context,
    clientMirror:frontDoor.receipt,
    museResource:services?.config?services.config.origin+MUSE_RESOURCE_PATH:"",
    personalResource: services?.config?.resource ?? "", dotResource: services?.config ? services.config.origin + "/mcp/runner" : "",
    discovery: services?.config && (feature.enablePublicMcp || feature.enableOpenAiDot || feature.enableMuse&&feature.enableNativeRunner) ? { origin: services.config.origin, authorizationOrigin: services.config.authorizationOrigin ?? services.config.origin,
      profiles: [...(feature.enablePublicMcp ? ["personal-mcp" as const] : []), ...(feature.enableOpenAiDot ? ["dot-mcp" as const] : []),...(feature.enableMuse&&feature.enableNativeRunner?["muse-agent" as const]:[])] } : undefined,
    personalEnabled: feature.enablePublicMcp, dotEnabled: feature.enableOpenAiDot,museEnabled:feature.enableMuse&&feature.enableNativeRunner });
  const managedIdentity=getCloudRuntimeIdentity();
  const muse=await readIdleMuseReceiverProof(tx,{enabled:feature.enableMuse&&feature.enableNativeRunner,contactImportWakeVersion:hasConnectionEventWakeReceiver(owner,{importsClientMetadata:true})?1:undefined,
    namespace:managedIdentity&&services?.config&&services.clientMirrorInstanceId?{stackId:managedIdentity.stackId,origin:services.config.origin,instanceId:services.clientMirrorInstanceId}:undefined,
    receipt:frontDoor.receipt,now:context.now,budget:context.budget});
  const absent = { revision: "absent", reconciled: false };
  const personal = services?.personal?.reconciliationSnapshot() ?? absent, dot = services?.dot?.reconciliationSnapshot() ?? absent;
  const personalDestination = services?.personal?.createIdleDestinationInspector();
  const dotDestination = services?.dot?.createIdleDestinationInspector();
  const subscriptions = await readIdleMcpSubscriptionProof(tx, { now: context.now, ingress, personal, dot, budget: context.budget,
    inspectDestination: row => (row.bindingId ? dotDestination : personalDestination)?.(row) ?? Promise.resolve(false) });
  const retries = await readIdleMcpEventSchedule(tx, { now: context.now, coveredGrantIds: ingress.grantIds, personal, dot, budget: context.budget });
  const deviceStatus=await readIdleMcpDeviceStatus(tx,{enabled:feature.enablePublicMcp||feature.enableOpenAiDot,receipt:frontDoor.receipt,budget:context.budget});
  const legacyDevices=feature.enablePublicMcp||feature.enableOpenAiDot?await readIdleMcpDeviceCutover(tx,context):{blocked:false,state:"absent",deadlines:[]};
  const transfers = await readIdleMcpTransferSchedule(tx, context);
  const handoffs = await readIdleMcpAuthorizationHandoffs(tx, context);
  const schedule = { blocked: muse.blocked || frontDoor.blocked || deviceStatus.blocked || legacyDevices.blocked || retries.blocked || transfers.blocked || handoffs.blocked, state: [muse.state,frontDoor.state,deviceStatus.state,legacyDevices.state,retries.state,transfers.state,handoffs.state], deadlines: [...muse.deadlines,...legacyDevices.deadlines,...retries.deadlines,...transfers.deadlines,...handoffs.deadlines] };
  context.budget.check();
  return { ingress,muse, subscriptions, retries, frontDoor, deviceStatus,legacyDevices, transfers, handoffs, schedule,
    generation: createHash("sha256").update(JSON.stringify([ingress.generation, subscriptions.generation, schedule])).digest("hex") };
}
