import { createChatInboundAuthority } from "./authorization.js";

import type { EndpointRow } from "../runtime-types.js";

import {
  and,
  eq,
  ne,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatEndpointResources,
  chatEndpoints,
} from "@paperclipai/db";

import {
  notFound,
} from "../../../errors.js";

import type {
  Thread,
} from "chat";

import type { ChatSurfaceKind } from "./surfaces.js";

type MessageResourceAdmissionInput = {
  endpoint: EndpointRow;
  thread: Thread;
  addressed: boolean;
  suppressSetupDestinationActivation: boolean;
  surfaceKind: ChatSurfaceKind;
};
export function createMessageResourceAdmission(db: Db, options: { ensureResource: ReturnType<typeof createChatInboundAuthority>["ensureResource"] }) {
  const { ensureResource } = options;
  async function admitMessageResource(input: MessageResourceAdmissionInput) {
    const { endpoint, thread, addressed, suppressSetupDestinationActivation, surfaceKind } = input;
    const mayEnableSetupDestination =
        // Slack channels start enabled. Never use first-test activation to
        // override an existing channel the operator explicitly disabled.
        endpoint.provider !== "slack" &&
        endpoint.provider !== "imessage-photon" &&
        !thread.isDM &&
        endpoint.status === "verifying" &&
        addressed &&
        !suppressSetupDestinationActivation &&
        !(
          endpoint.provider === "microsoft-teams" &&
          surfaceKind === "linear_group"
        );
      const resourceAdmission = mayEnableSetupDestination
        ? await db.transaction(async (tx) => {
            const currentEndpoint = await tx
              .select({ status: chatEndpoints.status })
              .from(chatEndpoints)
              .where(eq(chatEndpoints.id, endpoint.id))
              .for("update")
              .then((rows) => rows[0] ?? null);
            if (!currentEndpoint) throw notFound("Chat endpoint not found");
            const enabledResourceCount = await tx
              .select({ count: sql<number>`count(*)::int` })
              .from(chatEndpointResources)
              .where(
                and(
                  eq(chatEndpointResources.endpointId, endpoint.id),
                  eq(chatEndpointResources.enabled, true),
                  eq(chatEndpointResources.availability, "available"),
                  ne(chatEndpointResources.type, "direct_message"),
                  ne(chatEndpointResources.type, "group_chat"),
                ),
              )
              .then((rows) => rows[0]?.count ?? 0);
            const enableSetupDestination =
              currentEndpoint.status === "verifying" &&
              enabledResourceCount === 0;
            let resource = await ensureResource(
              endpoint,
              thread,
              enableSetupDestination,
              tx,
            );
            if (enableSetupDestination && !resource.enabled) {
              resource = await tx
                .update(chatEndpointResources)
                .set({ enabled: true, updatedAt: new Date() })
                .where(eq(chatEndpointResources.id, resource.id))
                .returning()
                .then((rows) => rows[0] ?? resource);
            }
            return { enabledResourceCount, resource };
          })
        : {
            enabledResourceCount: await db
              .select({ count: sql<number>`count(*)::int` })
              .from(chatEndpointResources)
              .where(
                and(
                  eq(chatEndpointResources.endpointId, endpoint.id),
                  eq(chatEndpointResources.enabled, true),
                  eq(chatEndpointResources.availability, "available"),
                  ne(chatEndpointResources.type, "direct_message"),
                  ne(chatEndpointResources.type, "group_chat"),
                ),
              )
              .then((rows) => rows[0]?.count ?? 0),
            resource: await ensureResource(endpoint, thread, false),
          };
    return resourceAdmission;
  }
  return { admitMessageResource };
}
