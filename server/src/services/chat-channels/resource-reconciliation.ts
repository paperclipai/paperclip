import { notifyChatEndpointConfiguration } from "./configuration-work-notifications.js";
import { notifyChatConnectionHealth } from "./connection-health-notifications.js";
import type { ConnectionManagementContext } from "../connection-management.js";
import { imessageResourceParticipants } from "./imessage-photon/resources.js";
import { createGitHubResources, reconcileGitHubRepositoryCoordinates } from "./github/resources.js";
import { baseTeamsConversationId } from "./microsoft-teams/resources.js";
import { slackResourceLabelIsFallback } from "./slack/resources.js";
import { telegramResourceLabelIsFallback, prepareTelegramResourceMigration, migrateTelegramResourceConversations } from "./telegram/resources.js";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, toolConnections, type Db } from "@paperclipai/db";
import { assertChatExecutionDefaultsAccess } from "../chat-execution-defaults.js";
import type { ChatExecutionDefaults, ChatEndpointSetupState } from "@paperclipai/shared";
import { badRequest, conflict, notFound, unprocessable } from "../../errors.js";
import { redactSensitiveText } from "../../redaction.js";
import { notifyChatDeliveryWork, notifyChatEndpointWork } from "../chat-work-notifications.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import type { CredentialMutationLeaseGuard, chatCredentialMutationLease } from "../chat-credential-mutation-lease.js";
import type { ChatProviderInventoryResult, ChatProviderResourceInventoryItem } from "../chat-provider-inventory.js";
import type { ChatProviderLifecycleEffect } from "../chat-provider-lifecycle.js";

type EndpointRow = typeof chatEndpoints.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type InternalSetupState = ChatEndpointSetupState & { runtimeGeneration?: number };

type ResourceReconciliationOptions = {
  endpointRecord: (endpointId: string) => Promise<{ endpoint: EndpointRow } | null>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  maxErrorText: number;
};

export function createChatResourceReconciliation(db: Db, options: ResourceReconciliationOptions) {
  const { endpointRecord, withCredentialMutationLease, runtimeGeneration, maxErrorText: MAX_ERROR_TEXT } = options;

  async function upsertProviderResourceRow(
    tx: DbTransaction,
    endpoint: EndpointRow,
    item: ChatProviderResourceInventoryItem,
  ) {
    if (endpoint.provider === "github") {
      const renamed = await reconcileGitHubRepositoryCoordinates(tx, endpoint, item);
      if (renamed) return renamed;
    }

    const [resource] = await tx
      .insert(chatEndpointResources)
      .values({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        type: item.type,
        providerResourceId: item.providerResourceId,
        parentProviderResourceId: item.parentProviderResourceId ?? null,
        label: item.label,
        providerUrl: item.providerUrl ?? null,
        availability: "available",
        // Slack inventory contains only channels the bot has joined. Apply the
        // invitation default on insert; conflict updates preserve operator choices.
        enabled:
          endpoint.provider === "slack" &&
          item.type === "channel" &&
          item.metadata?.creator !== endpoint.botExternalId,
        metadata: item.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [
          chatEndpointResources.endpointId,
          chatEndpointResources.type,
          chatEndpointResources.providerResourceId,
        ],
        set: {
          parentProviderResourceId: item.parentProviderResourceId ?? null,
          label: item.label,
          providerUrl: item.providerUrl ?? null,
          availability: "available",
          metadata: item.metadata ?? {},
          updatedAt: new Date(),
        },
      })
      .returning({ id: chatEndpointResources.id });
    return resource ?? null;
  }

  async function reconcileProviderResourceRows(
    endpoint: EndpointRow,
    inventory: ChatProviderInventoryResult,
    credentialLease: CredentialMutationLeaseGuard,
  ) {
    const resourceType =
      endpoint.provider === "github" ? "repository" : "channel";
    const discovered = new Set(
      inventory.resources.map((resource) => resource.providerResourceId),
    );
    const absentAvailability =
      endpoint.provider === "github" ? "removed" : "unavailable";
    await db.transaction(async (tx) => {
      await credentialLease.assertOwned(tx);
      for (const item of inventory.resources) {
        const resource = await upsertProviderResourceRow(tx, endpoint, item);
        if (resource) {
          // Resource recovery reopens only bindings that Paperclip marked
          // unavailable. Completed historical tasks stay completed.
          await tx
            .update(chatConversations)
            .set({ state: "active", updatedAt: new Date() })
            .where(
              and(
                eq(chatConversations.companyId, endpoint.companyId),
                eq(chatConversations.endpointId, endpoint.id),
                eq(chatConversations.resourceId, resource.id),
                eq(chatConversations.state, "unavailable"),
              ),
            );
        }
      }

      const existing = await tx
        .select({
          id: chatEndpointResources.id,
          providerResourceId: chatEndpointResources.providerResourceId,
        })
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.companyId, endpoint.companyId),
            eq(chatEndpointResources.endpointId, endpoint.id),
            eq(chatEndpointResources.type, resourceType),
          ),
        );
      for (const resource of existing) {
        if (discovered.has(resource.providerResourceId)) continue;
        await tx
          .update(chatEndpointResources)
          .set({ availability: absentAvailability, updatedAt: new Date() })
          .where(eq(chatEndpointResources.id, resource.id));
        await tx
          .update(chatConversations)
          .set({ state: "unavailable", updatedAt: new Date() })
          .where(
            and(
              eq(chatConversations.companyId, endpoint.companyId),
              eq(chatConversations.endpointId, endpoint.id),
              eq(chatConversations.resourceId, resource.id),
              inArray(chatConversations.state, ["active", "waiting"]),
            ),
          );
      }
      await credentialLease.assertOwned(tx);
    });
  }

  async function listResources(endpointId: string) {
    const resources = await db
      .select()
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.endpointId, endpointId),
          ne(chatEndpointResources.type, "direct_message"),
        ),
      )
      .orderBy(asc(chatEndpointResources.label));
    return resources.map((resource) => ({
      ...resource,
      participants: imessageResourceParticipants(resource),
    }));
  }

  async function replaceResources(
    endpointId: string,
    updates: Array<{ id: string; enabled?: boolean; executionDefaults?: ChatExecutionDefaults | null }>,
    actorUserId?: string | null,
    options?: { initialGitHubImport?: boolean; managementContext?: ConnectionManagementContext },
  ) {
    await updateResourceSelection(endpointId, updates, actorUserId, options);
    return listResources(endpointId);
  }

  async function updateResourceSelection(
    endpointId: string,
    updates: Array<{ id: string; enabled?: boolean; executionDefaults?: ChatExecutionDefaults | null }>,
    actorUserId?: string | null,
    options?: { initialGitHubImport?: boolean; allGitHubRepositoriesEnabled?: boolean; managementContext?: ConnectionManagementContext },
  ) {
    await options?.managementContext?.reauthorize();
    const initial = await endpointRecord(endpointId);
    if (!initial) throw notFound("Chat endpoint not found");
    const bulk = options?.allGitHubRepositoriesEnabled !== undefined;
    if (bulk && initial.endpoint.provider !== "github") throw badRequest("Only GitHub repositories support toggle all");
    if (updates.length === 0 && initial.endpoint.provider !== "github") return;
    if (initial.endpoint.provider === "imessage-photon" && initial.endpoint.botExternalId?.startsWith("photon-project:") && updates.some((entry) => entry.enabled))
      throw unprocessable("Photon shared channels support direct messages only; groups cannot be enabled");
    await withCredentialMutationLease(
      initial.endpoint,
      async (credentialLease) => {
        const ids = updates.map((entry) => entry.id);
        const publications: ActivityPublication[] = [];
        await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          const [endpoint] = await tx
            .select({
              companyId: chatEndpoints.companyId,
              assignedAgentId: chatEndpoints.assignedAgentId,
              connectionId: chatEndpoints.connectionId,
              provider: chatEndpoints.provider,
              setup: chatEndpoints.setup,
            })
            .from(chatEndpoints)
            .where(
              and(
                eq(chatEndpoints.id, endpointId),
                eq(chatEndpoints.companyId, initial.endpoint.companyId),
              ),
            )
            .for("no key update");
          if (!endpoint) throw notFound("Chat endpoint not found");
          if (options?.initialGitHubImport && endpoint.provider === "github" && (endpoint.setup.github?.repositorySelectionSaved || !endpoint.setup.github?.initialRepositoryImportPending)) return;
          const rows = await tx
            .select({
              id: chatEndpointResources.id,
              availability: chatEndpointResources.availability,
              enabled: chatEndpointResources.enabled,
              executionDefaults: chatEndpointResources.executionDefaults,
            })
            .from(chatEndpointResources)
            .where(
              and(
                eq(chatEndpointResources.companyId, endpoint.companyId),
                eq(chatEndpointResources.endpointId, endpointId),
                bulk
                  ? and(
                      eq(chatEndpointResources.type, "repository"),
                      options!.allGitHubRepositoriesEnabled
                        ? eq(chatEndpointResources.availability, "available")
                        : undefined,
                    )
                  : inArray(chatEndpointResources.id, ids),
              ),
            )
            .orderBy(asc(chatEndpointResources.id))
            .for("no key update");
          if (!bulk && rows.length !== new Set(ids).size)
            throw unprocessable("Every resource must belong to this endpoint");
          const selectedUpdates: typeof updates = bulk
            ? rows.map((row) => ({ id: row.id, enabled: options!.allGitHubRepositoriesEnabled! }))
            : updates;
          const availabilityById = new Map(
            rows.map((row) => [row.id, row.availability]),
          );
          // Validate every submitted grant, including intermediate duplicate
          // entries. Netting below describes the audit, not new authority.
          const unavailable = selectedUpdates.find(
            (entry) =>
              entry.enabled && availabilityById.get(entry.id) !== "available",
          );
          if (unavailable)
            throw conflict(
              "A destination must still be available from the provider before it can be enabled",
              { code: "chat_resource_unavailable", resourceId: unavailable.id },
            );
          const finalEnabled = new Map(rows.map((row) => [row.id, row.enabled]));
          for (const entry of selectedUpdates) {
            if (entry.enabled !== undefined) finalEnabled.set(entry.id, entry.enabled);
          }
          const finalDefaults = new Map(rows.map((row) => [row.id, row.executionDefaults]));
          for (const entry of selectedUpdates) {
            if (entry.executionDefaults === undefined) continue;
            await assertChatExecutionDefaultsAccess(db, {
              companyId: endpoint.companyId,
              assigneeAgentId: endpoint.assignedAgentId,
              actor: options?.managementContext?.actor ?? { type: "board", userId: actorUserId, source: actorUserId ? "session" : "local_implicit" },
              defaults: entry.executionDefaults,
            }, tx);
            finalDefaults.set(entry.id, entry.executionDefaults);
          }
          const changes = rows
            .filter((row) => row.enabled !== finalEnabled.get(row.id) || JSON.stringify(row.executionDefaults) !== JSON.stringify(finalDefaults.get(row.id)))
            .map((row) => ({
              resourceId: row.id,
              before: { enabled: row.enabled, ...(JSON.stringify(row.executionDefaults) !== JSON.stringify(finalDefaults.get(row.id)) ? { executionDefaults: row.executionDefaults } : {}) },
              after: { enabled: finalEnabled.get(row.id)!, ...(JSON.stringify(row.executionDefaults) !== JSON.stringify(finalDefaults.get(row.id)) ? { executionDefaults: finalDefaults.get(row.id) } : {}) },
            }));
          if (bulk) {
            // One atomic database update, independent of pagination/search and
            // serialized with refresh, reconnect, and individual row changes.
            await tx.update(chatEndpointResources)
              .set({ enabled: options!.allGitHubRepositoriesEnabled!, updatedAt: new Date() })
              .where(and(
                eq(chatEndpointResources.companyId, endpoint.companyId),
                eq(chatEndpointResources.endpointId, endpointId),
                eq(chatEndpointResources.type, "repository"),
                options!.allGitHubRepositoriesEnabled
                  ? eq(chatEndpointResources.availability, "available")
                  : undefined,
              ));
          } else for (const entry of selectedUpdates)
            await tx
              .update(chatEndpointResources)
              .set({ enabled: entry.enabled, ...(entry.executionDefaults !== undefined ? { executionDefaults: entry.executionDefaults } : {}), updatedAt: new Date() })
              .where(
                and(
                  eq(chatEndpointResources.companyId, endpoint.companyId),
                  eq(chatEndpointResources.endpointId, endpointId),
                  eq(chatEndpointResources.id, entry.id),
                ),
              );
          if (endpoint.provider === "github")
            await tx.update(chatEndpoints).set({ setup: sql`jsonb_set(${chatEndpoints.setup}, '{github}', coalesce(${chatEndpoints.setup}->'github', '{}'::jsonb) || '{"repositorySelectionSaved":true,"initialRepositoryImportPending":false}'::jsonb)`, updatedAt: new Date() }).where(eq(chatEndpoints.id, endpointId));
          if (changes.length > 0 || (endpoint.provider === "github" && !endpoint.setup.github?.repositorySelectionSaved))
            await logActivity(
              tx as unknown as Db,
              {
                companyId: endpoint.companyId,
                ...(options?.managementContext?.audit ?? { actorType: "user" as const, actorId: actorUserId ?? "board" }),
                action: "chat_endpoint.resources_updated",
                entityType: "tool_connection",
                entityId: endpoint.connectionId,
                details: { endpointId, provider: endpoint.provider, changes },
              },
              publications,
            );
          await credentialLease.assertOwned(tx);
        });
        // A committed reach change is factual even if the outer lease's last
        // check subsequently fails. Never publish an uncommitted activity.
        for (const publication of publications) publishActivity(publication);
      },
    );
  }

  async function hasNewerProcessedProviderLifecycleEffect(
    endpoint: EndpointRow,
    effect: Extract<ChatProviderLifecycleEffect, { kind: "resource" }>,
  ): Promise<boolean> {
    const sequence = effect.providerOrder?.sequence;
    const occurredAt = effect.providerOrder?.occurredAt;
    if (!sequence && !occurredAt) return false;
    const providerResourceId =
      endpoint.provider === "microsoft-teams"
        ? baseTeamsConversationId(effect.providerResourceId)
        : effect.providerResourceId;
    const newerOrder = sequence
      ? sql`(
          ${chatDeliveries.normalizedEvent}#>>'{lifecycle,providerOrder,sequence}' ~ '^[0-9]+([.][0-9]+)?$'
          and (${chatDeliveries.normalizedEvent}#>>'{lifecycle,providerOrder,sequence}')::numeric > cast(${sequence} as numeric)
        )`
      : sql`(
          nullif(${chatDeliveries.normalizedEvent}#>>'{lifecycle,providerOrder,occurredAt}', '')::timestamptz > cast(${occurredAt!} as timestamptz)
        )`;
    const newer = await db
      .select({ id: chatDeliveries.id })
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpoint.id),
          eq(chatDeliveries.state, "processed"),
          inArray(chatDeliveries.eventKind, ["installation", "uninstallation"]),
          sql`${chatDeliveries.normalizedEvent}#>>'{lifecycle,kind}' = 'resource'`,
          sql`${chatDeliveries.normalizedEvent}#>>'{lifecycle,provider}' = ${effect.provider}`,
          sql`${chatDeliveries.normalizedEvent}#>>'{lifecycle,providerResourceId}' = ${providerResourceId}`,
          newerOrder,
        ),
      )
      .limit(1);
    return newer.length > 0;
  }

  async function applyProviderAvailability(input: {
    currentEndpoint: EndpointRow;
    effect: ChatProviderLifecycleEffect;
    credentialLease: CredentialMutationLeaseGuard;
    staleResourceEffect: boolean;
    claimed: Pick<typeof chatDeliveries.$inferSelect, "id">;
    candidate: Pick<typeof chatDeliveries.$inferSelect, "attempts">;
  }): Promise<void> {
    const { currentEndpoint, effect, credentialLease, staleResourceEffect, claimed, candidate } = input;
        await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          const now = new Date();
          if (staleResourceEffect) {
            // Persisted provider-native ordering wins over request arrival or
            // lease acquisition order. The older callback remains auditable,
            // but cannot roll a resource or conversation back.
            await tx
              .update(chatEndpoints)
              .set({ lastEventAt: now, updatedAt: now })
              .where(eq(chatEndpoints.id, currentEndpoint.id));
            await notifyChatDeliveryWork(tx);
            await tx
              .update(chatDeliveries)
              .set({
                state: "processed",
                processedAt: now,
                redactedError: null,
                nextAttemptAt: null,
                updatedAt: now,
              })
              .where(eq(chatDeliveries.id, claimed.id));
            return;
          }
          if (effect.kind === "resource") {
            const providerResourceId =
              currentEndpoint.provider === "microsoft-teams"
                ? baseTeamsConversationId(effect.providerResourceId)
                : effect.providerResourceId;
            const previousProviderResourceId =
              currentEndpoint.provider === "telegram"
                ? effect.previousProviderResourceId
                : undefined;
            const { previousResource, migratedLabel, migratedEnabled } = await prepareTelegramResourceMigration(
              tx, currentEndpoint, effect, providerResourceId, previousProviderResourceId, now,
            );
            const preserveProviderLabel =
              (currentEndpoint.provider === "slack" &&
                slackResourceLabelIsFallback(
                  providerResourceId,
                  migratedLabel,
                )) ||
              (currentEndpoint.provider === "telegram" &&
                telegramResourceLabelIsFallback(
                  providerResourceId,
                  migratedLabel,
                ));
            const [resource] = await tx
              .insert(chatEndpointResources)
              .values({
                companyId: currentEndpoint.companyId,
                endpointId: currentEndpoint.id,
                type: effect.resourceType,
                providerResourceId,
                parentProviderResourceId:
                  effect.parentProviderResourceId ?? null,
                label: migratedLabel,
                providerUrl: effect.providerUrl ?? null,
                availability: effect.availability,
                enabled:
                  migratedEnabled ||
                  (currentEndpoint.provider === "slack" &&
                    effect.resourceType === "channel" &&
                    effect.availability === "available"),
                ...(previousResource ? { executionDefaults: previousResource.executionDefaults } : {}),
                metadata: effect.metadata ?? {},
              })
              .onConflictDoUpdate({
                target: [
                  chatEndpointResources.endpointId,
                  chatEndpointResources.type,
                  chatEndpointResources.providerResourceId,
                ],
                set: {
                  parentProviderResourceId:
                    effect.parentProviderResourceId ?? null,
                  ...(preserveProviderLabel ? {} : { label: migratedLabel }),
                  providerUrl: effect.providerUrl ?? null,
                  availability: effect.availability,
                  ...(previousProviderResourceId
                    ? {
                        enabled: sql<boolean>`${chatEndpointResources.enabled} or ${migratedEnabled}`,
                      }
                    : {}),
                  ...(previousResource ? { executionDefaults: previousResource.executionDefaults } : {}),
                  metadata: effect.metadata ?? {},
                  updatedAt: now,
                },
              })
              .returning({ id: chatEndpointResources.id });
            if (
              resource &&
              previousResource &&
              previousProviderResourceId !== providerResourceId
            ) {
              await migrateTelegramResourceConversations(tx, currentEndpoint, previousResource, resource, previousProviderResourceId, providerResourceId, migratedLabel, now);
            }
            if (resource) {
              await tx
                .update(chatConversations)
                .set({
                  state:
                    effect.availability === "available"
                      ? "active"
                      : "unavailable",
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(chatConversations.companyId, currentEndpoint.companyId),
                    eq(chatConversations.endpointId, currentEndpoint.id),
                    eq(chatConversations.resourceId, resource.id),
                    effect.availability === "available"
                      ? eq(chatConversations.state, "unavailable")
                      : inArray(chatConversations.state, ["active", "waiting"]),
                  ),
                );
            }
            await tx
              .update(chatEndpoints)
              .set({ lastEventAt: now, updatedAt: now })
              .where(eq(chatEndpoints.id, currentEndpoint.id));
          } else {
            const reason = redactSensitiveText(effect.reason).slice(
              0,
              MAX_ERROR_TEXT,
            );
            if (effect.availability === "available") {
              if (
                currentEndpoint.status !== "paused" &&
                currentEndpoint.status !== "archived"
              ) {
                const status =
                  currentEndpoint.setup.step === "complete"
                    ? "active"
                    : currentEndpoint.status === "attention"
                      ? "verifying"
                      : currentEndpoint.status;
                await notifyChatEndpointConfiguration(tx, currentEndpoint);
                if (status !== currentEndpoint.status) await notifyChatEndpointWork(tx, currentEndpoint.connectionId);
                await tx
                  .update(chatEndpoints)
                  .set({
                    status,
                    healthMessage:
                      status === "active"
                        ? "Connected"
                        : "Waiting for a test conversation",
                    lastError: null,
                    lastEventAt: now,
                    updatedAt: now,
                  })
                  .where(eq(chatEndpoints.id, currentEndpoint.id));
                await notifyChatConnectionHealth(tx, currentEndpoint);
                await tx
                  .update(toolConnections)
                  .set({
                    status: "active",
                    enabled: true,
                    healthStatus: "healthy",
                    healthMessage: "Connected",
                    lastError: null,
                    healthCheckedAt: now,
                    updatedAt: now,
                  })
                  .where(eq(toolConnections.id, currentEndpoint.connectionId));
              }
            } else {
              await notifyChatEndpointConfiguration(tx, currentEndpoint);
              await tx
                .update(chatEndpoints)
                .set({
                  status: effect.availability,
                  healthMessage: reason,
                  lastError: reason,
                  lastEventAt: now,
                  setup: {
                    ...currentEndpoint.setup,
                    runtimeGeneration:
                      runtimeGeneration(currentEndpoint.setup) + 1,
                  } as InternalSetupState,
                  updatedAt: now,
                })
                .where(eq(chatEndpoints.id, currentEndpoint.id));
              await notifyChatConnectionHealth(tx, currentEndpoint);
              await tx
                .update(toolConnections)
                .set({
                  status: "disabled",
                  enabled: false,
                  healthStatus:
                    effect.availability === "revoked" ? "failed" : "degraded",
                  healthMessage: reason,
                  lastError: reason,
                  healthCheckedAt: now,
                  updatedAt: now,
                })
                .where(eq(toolConnections.id, currentEndpoint.connectionId));
              await tx
                .update(chatEndpointResources)
                .set({ availability: "unavailable", updatedAt: now })
                .where(
                  and(
                    eq(
                      chatEndpointResources.companyId,
                      currentEndpoint.companyId,
                    ),
                    eq(chatEndpointResources.endpointId, currentEndpoint.id),
                  ),
                );
              await tx
                .update(chatConversations)
                .set({ state: "unavailable", updatedAt: now })
                .where(
                  and(
                    eq(chatConversations.companyId, currentEndpoint.companyId),
                    eq(chatConversations.endpointId, currentEndpoint.id),
                    inArray(chatConversations.state, ["active", "waiting"]),
                  ),
                );
            }
          }
          await notifyChatDeliveryWork(tx);
          await tx
            .update(chatDeliveries)
            .set({
              state: "processed",
              processedAt: now,
              redactedError: null,
              nextAttemptAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(chatDeliveries.id, claimed.id),
                eq(chatDeliveries.state, "processing"),
                eq(chatDeliveries.attempts, candidate.attempts + 1),
              ),
            );
          await credentialLease.assertOwned(tx);
        });
  }

  const { reconcileGitHubWebhookRepository, listGitHubRepositories, toggleAllGitHubRepositories } = createGitHubResources(db, { endpointRecord, upsertProviderResourceRow, updateResourceSelection });

  return { reconcileGitHubWebhookRepository, reconcileProviderResourceRows, listResources, listGitHubRepositories, replaceResources, toggleAllGitHubRepositories, hasNewerProcessedProviderLifecycleEffect, applyProviderAvailability };
}
