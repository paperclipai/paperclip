import { createChatSdkStatePersistence } from "../sdk-state.js";
import { notifyChatEndpointWork } from "../../chat-work-notifications.js";
import { writePhotonCheckpoint } from "../../photon/receiver.js";
import { PhotonState } from "../../photon/state.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { chatConversations, chatEndpoints, heartbeatRuns, toolConnections } from "@paperclipai/db";
import type { ChatSdkRuntimeCallbacks } from "../../chat-sdk-runtime.js";
import type { Db } from "@paperclipai/db";
import type { RuntimeContext, EndpointRow, EndpointRecord } from "../runtime-types.js";
import type { createChatReceiverOwnership } from "../runtime/ownership.js";
import type { createChatMessageLifecycle } from "../inbound/lifecycle.js";
type PhotonRuntimeOptions = {
  endpointId: string; connectionId: string; companyId: string; assignedAgentId: string; context: RuntimeContext; lineId: string;
  runtimeCallbackRecord: (endpointId: string, context: RuntimeContext, statuses: EndpointRow["status"][]) => Promise<EndpointRecord | null>;
  runtimeCallbackEndpoint: Parameters<typeof createChatMessageLifecycle>[1]["runtimeCallbackEndpoint"];
  renewDiscordGatewayOwnershipForMessageAdmission: ReturnType<typeof createChatReceiverOwnership>["renewDiscordGatewayOwnershipForMessageAdmission"];
};
export function createPhotonRuntimeCallbacks(db: Db, options: PhotonRuntimeOptions): Pick<ChatSdkRuntimeCallbacks, "onPhotonAssertOwned" | "onPhotonCheckpoint"> {
  const { endpointId, connectionId, companyId, assignedAgentId, context, lineId, runtimeCallbackRecord, runtimeCallbackEndpoint, renewDiscordGatewayOwnershipForMessageAdmission } = options;
  return {
    onPhotonAssertOwned: async (activeThreadId) => {
      if (!(await runtimeCallbackRecord(endpointId, context, ["verifying", "active", "attention"]))) throw new Error("Photon receiver ownership changed");
      if (activeThreadId) {
        const working = await db.select({ id: heartbeatRuns.id }).from(chatConversations).innerJoin(heartbeatRuns, and(
          eq(heartbeatRuns.companyId, chatConversations.companyId), eq(heartbeatRuns.agentId, assignedAgentId),
          eq(sql<string>`${heartbeatRuns.contextSnapshot}->>'issueId'`, sql<string>`${chatConversations.issueId}::text`), inArray(heartbeatRuns.status, ["queued", "running"]),
        )).where(and(eq(chatConversations.companyId, companyId), eq(chatConversations.endpointId, endpointId), eq(chatConversations.externalThreadId, activeThreadId), inArray(chatConversations.state, ["active", "waiting"]))).limit(1);
        if (!working.length) throw new Error("Photon conversation has no active agent work");
      }
      await db.transaction(async (tx) => {
        const current = await runtimeCallbackEndpoint(tx, endpointId, context, ["attention"]);
        if (!current) return;
        const connection = await tx.select().from(toolConnections).where(eq(toolConnections.id, current.connectionId)).then((rows) => rows[0]);
        if (!connection?.enabled) throw new Error("Photon endpoint requires operator recovery");
        await notifyChatEndpointWork(tx, connectionId);
        await tx.update(chatEndpoints).set({ status: current.setup.step === "complete" ? "active" : "verifying", healthMessage: "Photon receiver connected", lastError: null, updatedAt: new Date() }).where(eq(chatEndpoints.id, endpointId));
      });
    },
    onPhotonCheckpoint: (sequence) => db.transaction(async (tx) => {
      if (!(await runtimeCallbackEndpoint(tx, endpointId, context, ["verifying", "active"]))) throw new Error("Photon receiver is no longer current");
      if ((await renewDiscordGatewayOwnershipForMessageAdmission(tx, endpointId, context)).kind !== "owned") throw new Error("Photon receiver lease was replaced");
      await writePhotonCheckpoint(new PhotonState({ companyId: companyId, endpointId: endpointId }, createChatSdkStatePersistence(tx as unknown as Db)), lineId, sequence);
    })
  };
}