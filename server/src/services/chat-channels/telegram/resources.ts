import { and, eq, sql } from "drizzle-orm";
import { chatConversations, chatEndpointResources, chatEndpoints, type Db } from "@paperclipai/db";
import { notifyChatRunMilestones } from "../../chat-run-milestone-notifications.js";
import type { ChatProviderLifecycleEffect } from "../../chat-provider-lifecycle.js";
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type EndpointRow = typeof chatEndpoints.$inferSelect;

export function telegramResourceLabelIsFallback(
  providerResourceId: string,
  label: string,
): boolean {
  const candidate = label.trim();
  return (
    candidate === providerResourceId ||
    candidate === `telegram:${providerResourceId}`
  );
}

export async function prepareTelegramResourceMigration(
  tx: DbTransaction, currentEndpoint: EndpointRow,
  effect: Extract<ChatProviderLifecycleEffect, { kind: "resource" }>,
  providerResourceId: string, previousProviderResourceId: string | undefined, now: Date,
) {
  const previousResource = previousProviderResourceId
    ? await tx
      .select()
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.endpointId, currentEndpoint.id),
          eq(chatEndpointResources.type, "chat"),
          eq(
            chatEndpointResources.providerResourceId,
            previousProviderResourceId,
          ),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null)
    : null;
  const migratedLabel =
    previousResource &&
      telegramResourceLabelIsFallback(providerResourceId, effect.label)
      ? previousResource.label
      : effect.label;
  const migratedEnabled = previousResource?.enabled === true;
  if (
    previousResource &&
    previousProviderResourceId !== providerResourceId
  ) {
    await tx
      .update(chatEndpointResources)
      .set({
        availability: "unavailable",
        enabled: false,
        metadata: {
          ...previousResource.metadata,
          source: "chat_migration",
          migratedTo: providerResourceId,
        },
        updatedAt: now,
      })
      .where(eq(chatEndpointResources.id, previousResource.id));
  }
  return { previousResource, migratedLabel, migratedEnabled };
}

export async function migrateTelegramResourceConversations(
  tx: DbTransaction, currentEndpoint: EndpointRow,
  previousResource: typeof chatEndpointResources.$inferSelect,
  resource: { id: string }, previousProviderResourceId: string | undefined,
  providerResourceId: string, migratedLabel: string, now: Date,
) {
  const affected = and(
    eq(chatConversations.companyId, currentEndpoint.companyId),
    eq(chatConversations.endpointId, currentEndpoint.id),
    eq(chatConversations.resourceId, previousResource.id),
  );
  const migrated = await tx.select({ issueId: chatConversations.issueId })
    .from(chatConversations).where(affected).for("update");
  // Migration restores the binding before generic resource availability runs.
  // Register the wake here, within the same owning transaction as that change.
  for (const issueId of new Set(migrated.map(row => row.issueId))) {
    await notifyChatRunMilestones(tx, { companyId: currentEndpoint.companyId, issueId });
  }
  const previousThreadPrefix = `telegram:${previousProviderResourceId}`;
  const migratedThreadPrefix = `telegram:${providerResourceId}`;
  await tx
    .update(chatConversations)
    .set({
      resourceId: resource.id,
      // Telegram SDK threads use the namespaced channel id. Keep
      // the migrated row in that canonical shape so the first
      // reply from the replacement supergroup finds this same
      // task instead of creating a second conversation.
      externalConversationId: migratedThreadPrefix,
      externalThreadId: sql<string>`case
                    when ${chatConversations.externalThreadId} = ${previousThreadPrefix} then ${migratedThreadPrefix}
                    when ${chatConversations.externalThreadId} like ${`${previousThreadPrefix}:%`}
                      then ${migratedThreadPrefix} || substring(
                        ${chatConversations.externalThreadId}
                        from char_length(${previousThreadPrefix}) + 1
                      )
                    else ${chatConversations.externalThreadId}
                  end`,
      externalLabel: migratedLabel,
      state: "active",
      updatedAt: now,
    })
    .where(affected);
}
