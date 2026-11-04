import { and, eq, sql } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations, toolConnections, type Db } from "@paperclipai/db";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv } from "../../paperclip-cloud-connector.js";
import type { CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";
import type { createChatCredentials } from "../credentials.js";
import type { InternalSetupState } from "../runtime-types.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { notifyChatEndpointConfiguration } from "../configuration-work-notifications.js";

export function createSlackCloudEnrollment(db: Db, options: {
  resolveCredentials: ReturnType<typeof createChatCredentials>["resolveCredentials"];
  runtimeGeneration(setup: InternalSetupState): number;
}) {
  return async (endpointId: string, actorUserId: string | null | undefined, lease: CredentialMutationLeaseGuard) => {
    if (!actorUserId) return;
    const config = paperclipCloudConnectorConfigFromEnv();
    if (!config) return;
    const [current] = await db.select({ endpoint: chatEndpoints, connection: toolConnections }).from(chatEndpoints)
      .innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId)))
      .where(eq(chatEndpoints.id, endpointId)).limit(1);
    if (!current || current.endpoint.provider !== "slack") return;
    const connector = createPaperclipCloudConnector({ config });
    if (!await connector.slackEventsAvailable()) return;
    const endpoint = current.endpoint, setup = endpoint.setup as InternalSetupState;
    const generation = options.runtimeGeneration(setup);
    await lease.assertOwned();
    const previous = setup.slackCloudEvents;
    if (!["active", "verifying", "attention"].includes(endpoint.status) || current.connection.status !== "active" || !current.connection.enabled) {
      if (previous) await connector.slackEventEnrollment({ subject: actorUserId, companyId: endpoint.companyId,
        enrollment: { active: false, companyId: endpoint.companyId, endpointId, publicId: endpoint.publicId, bindingId: previous.bindingId } });
      return;
    }
    const [registration] = await db.select({ appId: chatSlackRegistrations.appId }).from(chatSlackRegistrations)
      .where(and(eq(chatSlackRegistrations.endpointId, endpointId), eq(chatSlackRegistrations.companyId, endpoint.companyId))).limit(1);

    const appId = registration?.appId ?? previous?.appId;
    if (!appId || !endpoint.providerAccountId || generation < 1) return;
    const credentials = await options.resolveCredentials(endpoint, db, ["signingSecret"]);
    const receipt = await connector.slackEventEnrollment({ subject: actorUserId, companyId: endpoint.companyId,
      enrollment: { active: true, companyId: endpoint.companyId, endpointId, publicId: endpoint.publicId,
        connectionId: endpoint.connectionId, runtimeGeneration: generation, teamId: endpoint.providerAccountId,
        appId, signingSecret: credentials.signingSecret } });
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Slack event enrollment was not confirmed");
    const value = receipt as Record<string, unknown>;
    if (value.version !== 1 || value.companyId !== endpoint.companyId || value.endpointId !== endpoint.id
      || value.connectionId !== endpoint.connectionId || value.publicId !== endpoint.publicId || value.runtimeGeneration !== generation
      || value.teamId !== endpoint.providerAccountId || value.appId !== appId
      || typeof value.bindingId !== "string" || !/^slack-event:[a-f0-9]{64}$/.test(value.bindingId))
      throw new Error("Slack event enrollment identity changed");
    const enrolled = { version: 1 as const, bindingId: value.bindingId, runtimeGeneration: generation,
      teamId: endpoint.providerAccountId, appId };
    await db.transaction(async tx => {
      await lease.assertOwned(tx);
      await notifyChatEndpointConfiguration(tx, endpoint);
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
      const updated = await tx.update(chatEndpoints).set({ setup: sql`jsonb_set(${chatEndpoints.setup}, '{slackCloudEvents}', ${JSON.stringify(enrolled)}::jsonb)`, updatedAt: new Date() })
        .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, endpoint.companyId),
          sql`coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer,0)=${generation}`)).returning({ id: chatEndpoints.id });
      if (updated.length !== 1) throw new Error("Slack configuration changed before event enrollment committed");
      await lease.assertOwned(tx);
    });
  };
}
