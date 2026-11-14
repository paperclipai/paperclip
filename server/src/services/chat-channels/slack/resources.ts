import { chatEndpointResources, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { EndpointRow } from "../runtime-types.js";
import type { ChatProviderLifecycleEffect } from "../../chat-provider-lifecycle.js";
import { logger } from "../../../middleware/logger.js";

export function slackResourceLabelIsFallback(
  providerResourceId: string,
  label: string,
): boolean {
  const candidate = label.trim();
  return (
    candidate === providerResourceId ||
    candidate === `slack:${providerResourceId}`
  );
}

export async function scheduleSlackLifecycleResourceHydration(db: Db, endpoint: EndpointRow, effect: ChatProviderLifecycleEffect, options: {
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  hydrateSlackResourceLabel: (endpointId: string, resourceId: string) => Promise<unknown>;
  redactError: (error: unknown) => string;
}): Promise<void> {
      if (
        effect.kind === "resource" &&
        effect.availability === "available" &&
        slackResourceLabelIsFallback(effect.providerResourceId, effect.label)
      ) {
        const stillAvailable = await db
          .select({ id: chatEndpointResources.id })
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.endpointId, endpoint.id),
              eq(chatEndpointResources.type, "channel"),
              eq(
                chatEndpointResources.providerResourceId,
                effect.providerResourceId,
              ),
              eq(chatEndpointResources.availability, "available"),
            ),
          )
          .limit(1)
          .then((rows) => rows.length > 0);
        if (stillAvailable) {
          options.scheduleMessageProcessing(async () => {
            await options.hydrateSlackResourceLabel(
              endpoint.id,
              effect.providerResourceId,
            ).catch((error) => {
              logger.warn(
                {
                  endpointId: endpoint.id,
                  providerResourceId: effect.providerResourceId,
                  error: options.redactError(error),
                },
                "could not hydrate a newly available Slack channel label",
              );
            });
          });
        }
      }
}
