import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, toolConnections, type Db } from "@paperclipai/db";
import type { ChatEndpointSetupState } from "@paperclipai/shared";
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

export function githubRepositoryInventoryItemFromPayload(
  payload: unknown,
): ChatProviderResourceInventoryItem | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const repository = (payload as { repository?: unknown }).repository;
  if (
    !repository ||
    typeof repository !== "object" ||
    Array.isArray(repository)
  )
    return null;
  const value = repository as {
    id?: unknown;
    full_name?: unknown;
    html_url?: unknown;
    name?: unknown;
    owner?: { id?: unknown; login?: unknown };
    private?: unknown;
  };
  const repositoryId =
    typeof value.id === "number" && Number.isSafeInteger(value.id)
      ? String(value.id)
      : typeof value.id === "string" && /^\d+$/.test(value.id)
        ? value.id
        : null;
  const owner =
    typeof value.owner?.login === "string" ? value.owner.login.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const fullName =
    typeof value.full_name === "string" && value.full_name.includes("/")
      ? value.full_name.trim()
      : owner && name
        ? `${owner}/${name}`
        : "";
  if (!repositoryId || !fullName) return null;
  const ownerId =
    typeof value.owner?.id === "number" && Number.isSafeInteger(value.owner.id)
      ? String(value.owner.id)
      : typeof value.owner?.id === "string" && /^\d+$/.test(value.owner.id)
        ? value.owner.id
        : undefined;
  return {
    providerResourceId: fullName.toLowerCase(),
    parentProviderResourceId: ownerId,
    type: "repository",
    label: fullName,
    providerUrl:
      typeof value.html_url === "string" && value.html_url.length > 0
        ? value.html_url
        : `https://github.com/${fullName}`,
    metadata: {
      providerRepositoryId: repositoryId,
      fullName,
      ...(owner ? { owner } : {}),
      private: value.private === true,
      source: "provider_webhook",
    },
  };
}

export function baseTeamsConversationId(value: string): string {
  return value.replace(/;messageid=[^;]+/i, "");
}

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

export function createChatResourceReconciliation(db: Db, options: ResourceReconciliationOptions) {
  const { endpointRecord, withCredentialMutationLease, runtimeGeneration, maxErrorText: MAX_ERROR_TEXT } = options;

  function githubRepositoryStableId(
    item: ChatProviderResourceInventoryItem,
  ): string | null {
    const value = item.metadata?.providerRepositoryId;
    return typeof value === "string" && /^\d+$/.test(value) ? value : null;
  }

  async function upsertProviderResourceRow(
    tx: DbTransaction,
    endpoint: EndpointRow,
    item: ChatProviderResourceInventoryItem,
  ) {
    const stableGitHubId =
      endpoint.provider === "github" ? githubRepositoryStableId(item) : null;
    if (stableGitHubId) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`chat-github-repository:${endpoint.id}:${stableGitHubId}`}, 0))`,
      );
      const stableResource = await tx
        .select()
        .from(chatEndpointResources)
        .where(
          and(
            eq(chatEndpointResources.companyId, endpoint.companyId),
            eq(chatEndpointResources.endpointId, endpoint.id),
            eq(chatEndpointResources.type, "repository"),
            sql`${chatEndpointResources.metadata}->>'providerRepositoryId' = ${stableGitHubId}`,
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        stableResource &&
        stableResource.providerResourceId !== item.providerResourceId
      ) {
        const coordinateResource = await tx
          .select()
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.companyId, endpoint.companyId),
              eq(chatEndpointResources.endpointId, endpoint.id),
              eq(chatEndpointResources.type, "repository"),
              eq(
                chatEndpointResources.providerResourceId,
                item.providerResourceId,
              ),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (coordinateResource && coordinateResource.id !== stableResource.id) {
          const coordinateConversation = await tx
            .select({ id: chatConversations.id })
            .from(chatConversations)
            .where(
              and(
                eq(chatConversations.endpointId, endpoint.id),
                eq(chatConversations.resourceId, coordinateResource.id),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (coordinateConversation) {
            throw conflict(
              "GitHub repository identity is already bound to two coordinates",
              { code: "chat_github_repository_identity_conflict" },
            );
          }
          await tx
            .delete(chatEndpointResources)
            .where(eq(chatEndpointResources.id, coordinateResource.id));
        }

        const oldRepository = stableResource.providerResourceId;
        const oldThreadPrefix = `github:${oldRepository}`;
        const newThreadPrefix = `github:${item.providerResourceId}`;
        const oldProviderUrl = `https://github.com/${oldRepository}`;
        const newProviderUrl = `https://github.com/${item.providerResourceId}`;
        await tx
          .update(chatEndpointResources)
          .set({
            providerResourceId: item.providerResourceId,
            parentProviderResourceId: item.parentProviderResourceId ?? null,
            label: item.label,
            providerUrl: item.providerUrl ?? null,
            availability: "available",
            enabled:
              stableResource.enabled || coordinateResource?.enabled === true,
            metadata: item.metadata ?? {},
            updatedAt: new Date(),
          })
          .where(eq(chatEndpointResources.id, stableResource.id));
        await tx
          .update(chatConversations)
          .set({
            externalConversationId: sql<string>`case
              when lower(${chatConversations.externalConversationId}) = ${oldRepository} then ${item.providerResourceId}
              when lower(${chatConversations.externalConversationId}) = ${oldThreadPrefix} then ${newThreadPrefix}
              else ${chatConversations.externalConversationId}
            end`,
            externalThreadId: sql<string>`case
              when lower(${chatConversations.externalThreadId}) = ${oldThreadPrefix} then ${newThreadPrefix}
              when lower(${chatConversations.externalThreadId}) like ${`${oldThreadPrefix}:%`}
                then ${newThreadPrefix} || substring(
                  ${chatConversations.externalThreadId}
                  from char_length(${oldThreadPrefix}) + 1
                )
              else ${chatConversations.externalThreadId}
            end`,
            externalLabel: item.label,
            providerUrl: sql<string | null>`case
              when lower(${chatConversations.providerUrl}) like ${`${oldProviderUrl}/%`}
                then ${newProviderUrl} || substring(
                  ${chatConversations.providerUrl}
                  from char_length(${oldProviderUrl}) + 1
                )
              else ${chatConversations.providerUrl}
            end`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatConversations.companyId, endpoint.companyId),
              eq(chatConversations.endpointId, endpoint.id),
              eq(chatConversations.resourceId, stableResource.id),
            ),
          );
        return { id: stableResource.id };
      }
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

  async function reconcileGitHubWebhookRepository(
    endpoint: EndpointRow,
    payload: unknown,
    credentialLease: CredentialMutationLeaseGuard,
  ) {
    const item = githubRepositoryInventoryItemFromPayload(payload);
    if (!item) return;
    await db.transaction(async (tx) => {
      await credentialLease.assertOwned(tx);
      const resource = await upsertProviderResourceRow(tx, endpoint, item);
      if (!resource) return;
      // A correctly signed repository callback is current provider proof. Keep
      // Paperclip's enabled choice, and reopen only conversations previously
      // quarantined for provider availability loss.
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
      await credentialLease.assertOwned(tx);
    });
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
      participants:
        resource.providerResourceId.startsWith("imessage-photon:") &&
        Array.isArray(resource.metadata.participants)
          ? resource.metadata.participants.flatMap((participant) => {
              const address =
                participant && typeof participant === "object"
                  ? (participant as Record<string, unknown>).address
                  : null;
              return typeof address === "string" ? [address] : [];
            })
          : undefined,
    }));
  }

  async function listGitHubRepositories(
    endpointId: string,
    query: { limit: number; offset: number; search: string },
  ) {
    const record = await endpointRecord(endpointId);
    if (!record || record.endpoint.provider !== "github") throw notFound("GitHub bot not found");
    const scope = and(
      eq(chatEndpointResources.companyId, record.endpoint.companyId),
      eq(chatEndpointResources.endpointId, endpointId),
      eq(chatEndpointResources.type, "repository"),
    );
    // Literal, case-insensitive substring search (%, _ and backslashes are
    // ordinary characters). Counts always describe the entire connection.
    const search = query.search
      ? sql`strpos(lower(${chatEndpointResources.label}), lower(${query.search})) > 0`
      : undefined;
    const [rows, [counts]] = await Promise.all([
      db.select().from(chatEndpointResources).where(and(scope, search))
        .orderBy(asc(chatEndpointResources.label), asc(chatEndpointResources.id))
        .offset(query.offset).limit(query.limit + 1),
      db.select({
        totalCount: sql<number>`count(*)::integer`,
        enabledCount: sql<number>`count(*) filter (where ${chatEndpointResources.enabled})::integer`,
        availableCount: sql<number>`count(*) filter (where ${chatEndpointResources.availability} = 'available')::integer`,
      }).from(chatEndpointResources).where(scope),
    ]);
    return {
      items: rows.slice(0, query.limit),
      nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
      totalCount: counts!.totalCount,
      enabledCount: counts!.enabledCount,
      availableCount: counts!.availableCount,
    };
  }

  async function replaceResources(
    endpointId: string,
    updates: Array<{ id: string; enabled: boolean }>,
    actorUserId?: string | null,
    options?: { initialGitHubImport?: boolean },
  ) {
    await updateResourceSelection(endpointId, updates, actorUserId, options);
    return listResources(endpointId);
  }

  async function toggleAllGitHubRepositories(endpointId: string, enabled: boolean, actorUserId?: string | null) {
    await updateResourceSelection(endpointId, [], actorUserId, { allGitHubRepositoriesEnabled: enabled });
    return { success: true as const };
  }

  async function updateResourceSelection(
    endpointId: string,
    updates: Array<{ id: string; enabled: boolean }>,
    actorUserId?: string | null,
    options?: { initialGitHubImport?: boolean; allGitHubRepositoriesEnabled?: boolean },
  ) {
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
          const selectedUpdates = bulk
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
          const finalEnabled = new Map(
            selectedUpdates.map((entry) => [entry.id, entry.enabled]),
          );
          const changes = rows
            .filter((row) => row.enabled !== finalEnabled.get(row.id))
            .map((row) => ({
              resourceId: row.id,
              before: { enabled: row.enabled },
              after: { enabled: finalEnabled.get(row.id)! },
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
              .set({ enabled: entry.enabled, updatedAt: new Date() })
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
                actorType: "user",
                actorId: actorUserId ?? "board",
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
                .where(
                  and(
                    eq(chatConversations.companyId, currentEndpoint.companyId),
                    eq(chatConversations.endpointId, currentEndpoint.id),
                    eq(chatConversations.resourceId, previousResource.id),
                  ),
                );
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
                if (status !== currentEndpoint.status) await notifyChatEndpointWork(tx);
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

  return { reconcileGitHubWebhookRepository, reconcileProviderResourceRows, listResources, listGitHubRepositories, replaceResources, toggleAllGitHubRepositories, hasNewerProcessedProviderLifecycleEffect, applyProviderAvailability };
}
