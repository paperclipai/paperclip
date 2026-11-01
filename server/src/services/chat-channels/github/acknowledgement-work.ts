import { readGitHubResponseRun } from "./response-run-state.js";
import { githubRunReplyState } from "../../chat-run-publications.js";
import { and, asc, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import { chatActions, chatConversations, chatEndpointLeases, chatEndpointResources,
  chatPublications, fastResponseRequests, chatEndpoints, chatMessageLinks, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import type { ChatResponseScope } from "../../chat-response-availability.js";
import { registerScopedDeadlineWork } from "../../scoped-deadline-work.js";

type Scope = ChatResponseScope & { endpointId?: string; repositoryId?: string; number?: number };
type Entry = { id: string; companyId: string; endpointId: string; deliveryId: string;
  issueId: string | null; conversationId: string | null; repositoryId: string | null; number: number | null; dueAt: number };
type FastResponse = { status: string; expiresAt: string; publicationState: string | null };

export function registerGitHubAcknowledgementWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  acknowledge: (deliveryId: string, canContinue: () => boolean) => Promise<unknown>,
  canRun: () => boolean,
) {
  const repositoryId = sql<string | null>`${chatEndpointResources.metadata}->>'providerRepositoryId'`;
  const number = sql<string | null>`substring(${chatConversations.externalThreadId}
    from '^github:[^:]+:(?:issue:)?([1-9][0-9]*)(?::rc:[1-9][0-9]*)?$')`;
  const selection = {
    id: chatActions.id, companyId: chatActions.companyId, endpointId: chatActions.endpointId,
    deliveryId: chatActions.deliveryId, conversationId: chatActions.conversationId, issueId: chatConversations.issueId,
    agentId: chatEndpoints.assignedAgentId,
    sourceMessageId: sql<string | null>`(select m.comment_id from ${chatMessageLinks} m
      where m.company_id = ${chatActions.companyId} and m.endpoint_id = ${chatActions.endpointId}
        and m.delivery_id = ${chatActions.deliveryId} and m.direction = 'inbound' limit 1)`,
    repositoryId, number, status: chatActions.status, result: chatActions.result,
    leaseExpiresAt: sql<string | null>`(select max(l.expires_at) from ${chatEndpointLeases} l
      where l.company_id = ${chatActions.companyId} and l.endpoint_id = ${chatActions.endpointId}
        and l.lease_key = 'github-publication:' || (${repositoryId}) || ':' || ${number})`,
    fast: sql<FastResponse | null>`(select jsonb_build_object('status', f.status, 'expiresAt', f.expires_at,
        'publicationState', p.state) from ${fastResponseRequests} f left join ${chatPublications} p
          on p.company_id = f.company_id and p.comment_id = f.comment_id
          and p.endpoint_id = f.endpoint_id and p.conversation_id = f.conversation_id
      where f.company_id = ${chatActions.companyId} and f.endpoint_id = ${chatActions.endpointId}
        and f.delivery_id = ${chatActions.deliveryId} limit 1)`,
  };
  async function page(scope?: Scope, cursor?: string, actionId?: string) {
    return db.select(selection).from(chatActions)
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
      .leftJoin(chatConversations, and(eq(chatConversations.id, chatActions.conversationId), eq(chatConversations.companyId, chatActions.companyId)))
      .leftJoin(chatEndpointResources, and(eq(chatEndpointResources.id, chatConversations.resourceId), eq(chatEndpointResources.companyId, chatActions.companyId)))
      .where(and(eq(chatActions.kind, "github_response_comment"), isNotNull(chatActions.deliveryId),
        sql`coalesce(${chatActions.result}->>'final', 'false') <> 'true'`,
        or(eq(chatActions.status, "received"), and(eq(chatActions.status, "failed"), sql`${chatActions.result}->>'retryable' = 'true'`)),
        scope ? eq(chatActions.companyId, scope.companyId) : undefined,
        scope?.issueId ? eq(chatConversations.issueId, scope.issueId) : undefined,
        scope?.conversationId ? eq(chatActions.conversationId, scope.conversationId) : undefined,
        scope?.deliveryId ? eq(chatActions.deliveryId, scope.deliveryId) : undefined,
        scope?.endpointId ? eq(chatActions.endpointId, scope.endpointId) : undefined,
        scope?.repositoryId ? eq(repositoryId, scope.repositoryId) : undefined,
        scope?.number ? eq(number, String(scope.number)) : undefined,
        cursor ? gt(chatActions.id, cursor) : undefined,
        actionId ? eq(chatActions.id, actionId) : undefined,
      )).orderBy(asc(chatActions.id)).limit(100);
  }
  async function entry(row: Awaited<ReturnType<typeof page>>[number]): Promise<Entry | null> {
    const { latestRun, ownsLatestRequest } = await readGitHubResponseRun(db, {
      companyId: row.companyId, endpointId: row.endpointId, agentId: row.agentId,
      issueId: row.issueId, deliveryId: row.deliveryId!, sourceMessageId: row.sourceMessageId,
    });
    // Execution success alone does not decide whether a final response exists.
    // Presentation/publication commits invalidate this parked request.
    if (row.issueId && ownsLatestRequest && latestRun?.nativePresentationPending &&
        await githubRunReplyState(db, { companyId: row.companyId, endpointId: row.endpointId,
          issueId: row.issueId, runId: latestRun.id }) === "none") return null;
    let dueAt = row.status === "failed" ? Date.parse(String(row.result?.retryAt)) : 0;
    if (!Number.isFinite(dueAt)) throw new Error("GitHub acknowledgement has an invalid retry deadline");
    const fast = row.fast;
    if (fast?.publicationState === "streaming") return null;
    if (fast && !["published", "delivery_unknown"].includes(fast.publicationState ?? "") &&
        (["pending", "running"].includes(fast.status) || ["pending", "retry"].includes(fast.publicationState ?? ""))) {
      dueAt = Math.max(dueAt, Date.parse(fast.expiresAt));
    }
    if (row.leaseExpiresAt) dueAt = Math.max(dueAt, Date.parse(row.leaseExpiresAt));
    return { id: row.id, companyId: row.companyId, endpointId: row.endpointId, deliveryId: row.deliveryId!,
      issueId: row.issueId, conversationId: row.conversationId, repositoryId: row.repositoryId, number: row.number ? Number(row.number) : null, dueAt };
  }
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.chatGitHubAcknowledgements,
    decodeScope: (hint: string): Scope | undefined => hint === "*" ? undefined : JSON.parse(hint),
    matches: (value: Entry, scope?: Scope) => !scope || (value.companyId === scope.companyId &&
      (!scope.issueId || value.issueId === scope.issueId) && (!scope.deliveryId || value.deliveryId === scope.deliveryId) &&
      (!scope.conversationId || value.conversationId === scope.conversationId) &&
      (!scope.endpointId || value.endpointId === scope.endpointId) && (!scope.repositoryId || value.repositoryId === scope.repositoryId) &&
      (!scope.number || value.number === scope.number)),
    load: async (scope?: Scope, signal?: AbortSignal) => {
      const entries: Entry[] = [];
      let cursor: string | undefined;
      while (canRun() && !signal?.aborted) {
        const rows = await page(scope, cursor);
        for (const row of rows) { const value = await entry(row); if (value) entries.push(value); }
        if (rows.length < 100) return entries;
        cursor = rows[rows.length - 1].id;
      }
      throw signal?.reason ?? new Error("GitHub acknowledgement recovery stopped");
    },
    check: async (value: Entry, signal?: AbortSignal) => {
      const [row] = await page(undefined, undefined, value.id);
      const current = row ? await entry(row) : null;
      if (!current || current.dueAt > Date.now() || !canRun() || signal?.aborted) return current;
      await acknowledge(current.deliveryId, () => canRun() && !signal?.aborted);
      const [remaining] = await page(undefined, undefined, value.id);
      return remaining ? await entry(remaining) : null;
    },
  }, canRun);
}
