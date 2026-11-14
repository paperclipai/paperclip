import { instanceSettingsService } from "../instance-settings.js";
import { managedMcpDeviceScope } from "./device-cutover.js";
import { pendingLegacyMcpDevicePredicate } from "./idle-device-cutover.js";
import { pendingMcpCodePredicate, pendingMcpDevicePredicate } from "./idle-authorization-handoffs.js";
import { asc, gt } from "drizzle-orm";
import { mcpFileTickets, mcpOauthRequests, mcpOauthDeviceRequests, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";

export function startMcpIngressHandoffExpiry(db: Db, coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>,"register">) {
  let requested = true, nextDeadline: number | null = null, revision = 0;
  return coordinator.register(DELIVERY_QUEUES.mcpIngressHandoffs, {
    retryMs: 5000, pausePassiveMaintenance: true,
    onSettled: () => { revision++; requested = true; },
    async run(signal) {
      if (!requested && (nextDeadline === null || nextDeadline > Date.now())) return;
      requested = true;
      const inspectedRevision = revision;
      signal.throwIfAborted();
      const [next] = await db.select({ expiresAt: mcpFileTickets.expiresAt }).from(mcpFileTickets)
        .where(gt(mcpFileTickets.expiresAt,new Date())).orderBy(asc(mcpFileTickets.expiresAt)).limit(1);
      signal.throwIfAborted();
      const [code] = await db.select({expiresAt:mcpOauthRequests.expiresAt}).from(mcpOauthRequests).where(pendingMcpCodePredicate(Date.now())).orderBy(asc(mcpOauthRequests.expiresAt)).limit(1);
      signal.throwIfAborted();
      const [device] = await db.select({expiresAt:mcpOauthDeviceRequests.expiresAt}).from(mcpOauthDeviceRequests).where(pendingMcpDevicePredicate(Date.now())).orderBy(asc(mcpOauthDeviceRequests.expiresAt)).limit(1);
      signal.throwIfAborted();
      const legacyEnabled=managedMcpDeviceScope()?(await instanceSettingsService(db).getExperimentalReadOnly()).enablePublicMcp:false;
      const legacyPredicate=legacyEnabled?pendingLegacyMcpDevicePredicate(db,Date.now()):undefined;
      const [legacy]=legacyPredicate?await db.select({expiresAt:mcpOauthDeviceRequests.expiresAt}).from(mcpOauthDeviceRequests).where(legacyPredicate).orderBy(asc(mcpOauthDeviceRequests.expiresAt)).limit(1):[];
      signal.throwIfAborted();
      const candidates = [next,code,device,legacy].filter(row=>row!==undefined).map(row=>row.expiresAt.getTime());
      const at = candidates.length ? Math.min(...candidates) : undefined;
      if (at !== undefined && !Number.isFinite(at)) throw new Error("MCP ingress handoff expiry is uncertain");
      nextDeadline = at ?? null; requested = inspectedRevision !== revision;
    },
    hasPending: async () => false,
    nextRunAt: () => requested ? Date.now() + 5000 : nextDeadline,
  });
}
