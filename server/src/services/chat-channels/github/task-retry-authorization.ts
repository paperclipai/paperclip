import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { agentWakeupRequests, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatMessageLinks, issueComments, toolConnections } from "@paperclipai/db";
import { chatWakeAuthorityDenied } from "../inbound/wakeup-authorization-error.js";
import type { DbOrTransaction, EndpointRow, LifecycleRuntimeFence } from "../runtime-types.js";
import { credentialFingerprint } from "../credential-fingerprint.js";
import { readTaskChatRetryIntent } from "../task-retry-authority.js";

export type TaskRetryWakeAuthority = {
  intentId: string;
  sourceRunId: string;
  runtimeFence?: LifecycleRuntimeFence;
  skippedActionIds?: string[];
};

async function skippedTaskRetryInputs(tx: DbOrTransaction, actions: Array<typeof chatActions.$inferSelect>,
  authority: TaskRetryWakeAuthority) {
  const first = actions[0];
  const ids = actions.filter(action => action.status === "failed" && action.payload.requestedByActorType === "user" &&
    authority.skippedActionIds?.includes(action.id)).map(action => action.id);
  if (!first || !ids.length) return new Set<string>();
  const rows = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, first.companyId), inArray(agentWakeupRequests.id, ids),
    eq(agentWakeupRequests.agentId, String(first.payload.agentId)), eq(agentWakeupRequests.status, "skipped"),
    isNull(agentWakeupRequests.runId), inArray(agentWakeupRequests.reason, ["budget.blocked", "agent.not_invokable"]),
    eq(agentWakeupRequests.requestedByActorType, "user"),
    eq(agentWakeupRequests.requestedByActorId, String(first.payload.requestedByActorId)),
  ));
  return new Set(rows.map(row => row.id));
}

export function githubTaskRetryAppMatches(endpoint: EndpointRow, delivery: typeof chatDeliveries.$inferSelect,
  response: { payload: Record<string, unknown> } | undefined) {
  const original = delivery.normalizedEvent.githubAuthority as { botExternalId?: unknown } | undefined;
  return original?.botExternalId !== undefined ? original.botExternalId === endpoint.botExternalId
    : response?.payload.botExternalId === endpoint.botExternalId && response.payload.agentId === endpoint.assignedAgentId;
}

/** Legacy intake did not persist an App ID when admission stopped before
 * acknowledgement. An earlier request ledger proves this endpoint had already
 * claimed the App: response payloads are server-owned and a non-null endpoint
 * claim cannot be replaced by setup, reconnect, or lifecycle repair. This is
 * identity evidence only; the earlier response is never replayed. */
async function githubTaskRetryAppAuthorized(tx: DbOrTransaction, endpoint: EndpointRow,
  delivery: typeof chatDeliveries.$inferSelect, response: { payload: Record<string, unknown> } | undefined) {
  if (githubTaskRetryAppMatches(endpoint, delivery, response)) return true;
  const original = delivery.normalizedEvent.githubAuthority as { botExternalId?: unknown } | undefined;
  // Never substitute historical evidence for an explicit conflicting binding.
  if (original?.botExternalId !== undefined || response || !endpoint.botExternalId || !delivery.conversationId) return false;
  const [prior] = await tx.select({ id: chatActions.id }).from(chatActions)
    .innerJoin(chatDeliveries, and(eq(chatDeliveries.id, chatActions.deliveryId),
      eq(chatDeliveries.companyId, chatActions.companyId), eq(chatDeliveries.endpointId, chatActions.endpointId),
      eq(chatDeliveries.conversationId, chatActions.conversationId), eq(chatDeliveries.principalId, chatActions.principalId)))
    .innerJoin(chatMessageLinks, and(eq(chatMessageLinks.deliveryId, chatDeliveries.id),
      eq(chatMessageLinks.companyId, chatDeliveries.companyId), eq(chatMessageLinks.endpointId, chatDeliveries.endpointId),
      eq(chatMessageLinks.conversationId, chatDeliveries.conversationId), eq(chatMessageLinks.direction, "inbound")))
    .where(and(eq(chatActions.companyId, endpoint.companyId), eq(chatActions.endpointId, endpoint.id),
      eq(chatActions.conversationId, delivery.conversationId), eq(chatActions.kind, "github_response_comment"),
      eq(chatActions.status, "processed"), eq(chatDeliveries.state, "processed"),
      eq(chatActions.providerActionId, sql<string>`'github_response:' || ${chatDeliveries.id}::text`),
      sql`jsonb_typeof(${chatActions.payload}->'botExternalId') = 'string'`,
      sql`${chatActions.payload}->>'botExternalId' = ${endpoint.botExternalId}`,
      sql`jsonb_typeof(${chatActions.payload}->'agentId') = 'string'`,
      sql`${chatActions.payload}->>'agentId' = ${endpoint.assignedAgentId}`,
      lt(chatActions.createdAt, delivery.createdAt), lt(chatDeliveries.createdAt, delivery.createdAt)))
    .limit(1);
  return Boolean(prior);
}

export function githubTaskRetryDestinationMatches(delivery: typeof chatDeliveries.$inferSelect,
  conversation: typeof chatConversations.$inferSelect, resource: typeof chatEndpointResources.$inferSelect | null) {
  const originalResource = delivery.normalizedEvent.resource as { providerResourceId?: unknown } | undefined;
  const originalThread = delivery.normalizedEvent.conversation as { externalThreadId?: unknown } | undefined;
  const automatic = (delivery.normalizedEvent.githubAutomatic ?? delivery.normalizedEvent.githubIssue) as
    { context?: { repositoryId?: unknown } } | undefined;
  return resource && originalResource?.providerResourceId === resource.providerResourceId
    && originalThread?.externalThreadId === conversation.externalThreadId
    && (automatic?.context?.repositoryId === undefined
      || automatic.context.repositoryId === resource.metadata.providerRepositoryId);
}

export async function githubTaskRetryRuntimeFence(tx: DbOrTransaction, endpoint: EndpointRow,
  action: typeof chatActions.$inferSelect, delivery: typeof chatDeliveries.$inferSelect,
  authority: TaskRetryWakeAuthority): Promise<LifecycleRuntimeFence> {
  const deny = chatWakeAuthorityDenied;
  const retry = await readTaskChatRetryIntent(tx as Parameters<typeof readTaskChatRetryIntent>[0], {
    companyId: action.companyId, issueId: String(action.payload.issueId),
    agentId: String(action.payload.agentId), sourceRunId: authority.sourceRunId, intentId: authority.intentId,
  });
  const skipped = await skippedTaskRetryInputs(tx, [action], authority);
  if (!retry) throw deny("retry_intent");
  if (endpoint.provider !== "github" || !endpoint.botExternalId || action.kind !== "inbound_wakeup"
    || (action.status !== "processed" && !skipped.has(action.id)) || delivery.state !== "processed") throw deny("source_receipt");
  const [response] = await tx.select({ payload: chatActions.payload }).from(chatActions).where(and(
    eq(chatActions.companyId, action.companyId), eq(chatActions.endpointId, endpoint.id),
    eq(chatActions.conversationId, action.conversationId!), eq(chatActions.deliveryId, delivery.id),
    eq(chatActions.kind, "github_response_comment"),
  ));
  if (!(await githubTaskRetryAppAuthorized(tx, endpoint, delivery, response))) throw deny("app_binding");
  const [connection] = await tx.select({ refs: toolConnections.credentialSecretRefs,
    enabled: toolConnections.enabled, status: toolConnections.status }).from(toolConnections).where(and(
    eq(toolConnections.companyId, endpoint.companyId), eq(toolConnections.id, endpoint.connectionId),
  ));
  if (!connection?.enabled || connection.status !== "active") throw deny("connection_access");
  const generation = Number((endpoint.setup as { runtimeGeneration?: unknown }).runtimeGeneration ?? 0);
  if (!Number.isSafeInteger(generation) || generation < 0) throw deny("runtime_generation");
  return authority.runtimeFence ?? { generation, credentialFingerprint: credentialFingerprint(connection.refs ?? []) };
}

type GitHubRetryBinding = {
  endpoint: EndpointRow;
  conversation: typeof chatConversations.$inferSelect;
  resource: typeof chatEndpointResources.$inferSelect | null;
  delivery: typeof chatDeliveries.$inferSelect;
  retryRuntimeFence?: LifecycleRuntimeFence;
};

export function createGitHubTaskRetryBatchAuthority<T extends GitHubRetryBinding>(authorize: (
  tx: DbOrTransaction, action: typeof chatActions.$inferSelect,
  notice: { nonblocking: true; terminal: boolean; taskRetry: TaskRetryWakeAuthority },
) => Promise<T>) {
  async function authorizeGitHubTaskRetryBatch(tx: DbOrTransaction, actions: Array<typeof chatActions.$inferSelect>,
    notice: { nonblocking: true; terminal: boolean; taskRetry: TaskRetryWakeAuthority }) {
    const deny = chatWakeAuthorityDenied;
    const first = actions[0];
    if (!first) throw deny("batch_scope");
    const skipped = await skippedTaskRetryInputs(tx, actions, notice.taskRetry);
    const commonScope = (action: typeof chatActions.$inferSelect) => JSON.stringify([
      action.companyId, action.endpointId, action.conversationId, action.principalId, action.kind,
      skipped.has(action.id) ? "processed" : action.status,
      ...["version", "issueId", "agentId", "sessionGeneration", "requestedByActorType", "requestedByActorId"]
        .map(key => action.payload[key]),
    ]);
    if (actions.some(action => commonScope(action) !== commonScope(first))) throw deny("batch_scope");
    const deliveries = await tx.select().from(chatDeliveries).where(and(eq(chatDeliveries.companyId, first.companyId),
      inArray(chatDeliveries.id, actions.map(action => action.deliveryId!))));
    const byDelivery = new Map(deliveries.map(delivery => [delivery.id, delivery]));
    const legacy = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, first.companyId),
      eq(chatActions.endpointId, first.endpointId), eq(chatActions.conversationId, first.conversationId!),
      eq(chatActions.kind, "github_response_comment"), inArray(chatActions.deliveryId, deliveries.map(delivery => delivery.id))));
    const legacyByDelivery = new Map(legacy.map(action => [action.deliveryId, action]));
    const links = await tx.select({ deliveryId: chatMessageLinks.deliveryId, commentId: chatMessageLinks.commentId,
      authorUserId: issueComments.authorUserId, deletedAt: issueComments.deletedAt }).from(chatMessageLinks)
      .innerJoin(issueComments, and(eq(issueComments.id, chatMessageLinks.commentId),
        eq(issueComments.companyId, first.companyId), eq(issueComments.issueId, String(first.payload.issueId))))
      .where(and(eq(chatMessageLinks.companyId, first.companyId), eq(chatMessageLinks.endpointId, first.endpointId),
        eq(chatMessageLinks.conversationId, first.conversationId!), eq(chatMessageLinks.direction, "inbound"),
        inArray(chatMessageLinks.deliveryId, deliveries.map(delivery => delivery.id))));
    const expectedUserId = first.payload.requestedByActorType === "user" ? first.payload.requestedByActorId : null;
    const linked = new Set(links.filter(link => (!link.deletedAt || notice.terminal) && link.authorUserId === expectedUserId)
      .map(link => `${link.deliveryId}:${link.commentId}`));
    const groups = new Map<string, T>();
    const authorized = new Map<string, T>();
    for (const action of actions) {
      const delivery = byDelivery.get(action.deliveryId!);
      if (!delivery || !linked.has(`${delivery.id}:${action.payload.commentId}`)) throw deny("batch_source_link");
      // Reuse only the same live grant within this transaction. Automatic review
      // policies with different contexts still receive their own full check.
      const grant = JSON.stringify(delivery.normalizedEvent.githubAutomatic ?? delivery.normalizedEvent.githubIssue ?? null);
      let current = groups.get(grant);
      if (!current) {
        current = await authorize(tx, action, notice);
        if (current.endpoint.provider !== "github") throw deny("app_binding");
        notice.taskRetry.runtimeFence ??= current.retryRuntimeFence;
        groups.set(grant, current);
      }
      if (delivery.state !== "processed" || delivery.endpointId !== current.endpoint.id ||
          delivery.conversationId !== current.conversation.id || delivery.principalId !== action.principalId ||
          !(await githubTaskRetryAppAuthorized(tx, current.endpoint, delivery, legacyByDelivery.get(delivery.id))) ||
          !githubTaskRetryDestinationMatches(delivery, current.conversation, current.resource)) throw deny("destination_binding");
      authorized.set(action.id, { ...current, delivery });
    }
    return authorized;
  }

  return authorizeGitHubTaskRetryBatch;
}
