import { and, asc, eq, sql } from "drizzle-orm";
import { chatConversations, chatEndpointResources, chatEndpoints, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../../../errors.js";
import type { CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";
import type { ChatProviderResourceInventoryItem } from "../../chat-provider-inventory.js";
type EndpointRow = typeof chatEndpoints.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

function githubRepositoryStableId(
  item: ChatProviderResourceInventoryItem,
): string | null {
  const value = item.metadata?.providerRepositoryId;
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

export async function reconcileGitHubRepositoryCoordinates(tx: DbTransaction, endpoint: EndpointRow, item: ChatProviderResourceInventoryItem) {
  const stableGitHubId =
    githubRepositoryStableId(item);
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

  return null;
}

type GitHubResourceOptions = {
  endpointRecord: (endpointId: string) => Promise<{ endpoint: EndpointRow } | null>;
  upsertProviderResourceRow: (tx: DbTransaction, endpoint: EndpointRow, item: ChatProviderResourceInventoryItem) => Promise<{ id: string } | null>;
  restoreResourceConversations: (tx: DbTransaction, endpoint: EndpointRow, resourceId: string) => Promise<void>;
  updateResourceSelection: (endpointId: string, updates: Array<{ id: string; enabled: boolean }>, actorUserId?: string | null, options?: { allGitHubRepositoriesEnabled?: boolean }) => Promise<void>;
};

export function createGitHubResources(db: Db, options: GitHubResourceOptions) {
  const { endpointRecord, upsertProviderResourceRow, restoreResourceConversations, updateResourceSelection } = options;
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
      await restoreResourceConversations(tx, endpoint, resource.id);
      await credentialLease.assertOwned(tx);
    });
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

  async function toggleAllGitHubRepositories(endpointId: string, enabled: boolean, actorUserId?: string | null) {
    await updateResourceSelection(endpointId, [], actorUserId, { allGitHubRepositoriesEnabled: enabled });
    return { success: true as const };
  }
  return { reconcileGitHubWebhookRepository, listGitHubRepositories, toggleAllGitHubRepositories };
}
