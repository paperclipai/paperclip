import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { chatActions, chatConversations, chatDeliveries, chatEndpointLeases, chatEndpointResources,
  chatEndpoints, chatMessageLinks, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import type { ChatResponseScope } from "../../chat-response-availability.js";
import { registerScopedDeadlineWork } from "../../scoped-deadline-work.js";
import { githubResponseExecution } from "./response-execution.js";
import { HttpError } from "../../../errors.js";

type Scope = ChatResponseScope & { endpointId?: string; repositoryId?: string; number?: number };
type Entry = { id: string; companyId: string; endpointId: string; deliveryId: string;
  issueId: string; conversationId: string; repositoryId: string | null; number: number | null; dueAt: number };

export function registerGitHubTerminalResponseWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  acknowledge: (deliveryId: string, canContinue: () => boolean) => Promise<unknown>,
  canRun: () => boolean,
) {
  const repositoryId = sql<string | null>`${chatEndpointResources.metadata}->>'providerRepositoryId'`;
  const number = sql<string | null>`substring(${chatConversations.externalThreadId}
    from '^github:[^:]+:(?:issue:)?([1-9][0-9]*)(?::rc:[1-9][0-9]*)?$')`;
  async function page(scope?: Scope, cursor?: string, actionId?: string) {
    return db.select({
      id: chatActions.id, companyId: chatActions.companyId, endpointId: chatActions.endpointId,
      deliveryId: chatActions.deliveryId, conversationId: chatConversations.id, issueId: issues.id,
      agentId: chatEndpoints.assignedAgentId, issueStatus: issues.status,
      deliveryCreatedAt: chatDeliveries.createdAt, repositoryId, number, result: chatActions.result,
      sourceMessageId: sql<string | null>`(select l.comment_id from ${chatMessageLinks} l
        where l.company_id = ${chatActions.companyId} and l.endpoint_id = ${chatActions.endpointId}
          and l.delivery_id = ${chatActions.deliveryId} and l.direction = 'inbound' limit 1)`,
      leaseExpiresAt: sql<string | null>`(select max(l.expires_at) from ${chatEndpointLeases} l
        where l.company_id = ${chatActions.companyId} and l.endpoint_id = ${chatActions.endpointId}
          and l.lease_key = 'github-publication:' || (${repositoryId}) || ':' || ${number})`,
    }).from(chatActions)
      .innerJoin(chatConversations, and(eq(chatConversations.id, chatActions.conversationId), eq(chatConversations.companyId, chatActions.companyId)))
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
      .innerJoin(chatDeliveries, and(eq(chatDeliveries.id, chatActions.deliveryId), eq(chatDeliveries.companyId, chatActions.companyId)))
      .innerJoin(issues, and(eq(issues.id, chatConversations.issueId), eq(issues.companyId, chatActions.companyId)))
      .leftJoin(chatEndpointResources, and(eq(chatEndpointResources.id, chatConversations.resourceId), eq(chatEndpointResources.companyId, chatActions.companyId)))
      .where(and(eq(chatActions.kind, "github_response_comment"), eq(chatActions.status, "processed"),
        isNotNull(chatActions.deliveryId), isNotNull(chatEndpoints.assignedAgentId),
        sql`coalesce(${chatActions.result}->>'final', 'false') <> 'true'`,
        sql`(${issues.status} = 'blocked' or (select r.status from ${heartbeatRuns} r
          where r.company_id = ${chatActions.companyId} and r.agent_id = ${chatEndpoints.assignedAgentId}
            and coalesce(r.native_issue_id::text, r.context_snapshot->>'issueId') = ${chatConversations.issueId}::text
          order by r.created_at desc, r.id desc limit 1) in ('succeeded', 'failed', 'interrupted', 'timed_out', 'cancelled'))`,
        scope ? eq(chatActions.companyId, scope.companyId) : undefined,
        scope?.issueId ? eq(issues.id, scope.issueId) : undefined,
        scope?.conversationId ? eq(chatActions.conversationId, scope.conversationId) : undefined,
        scope?.deliveryId ? eq(chatActions.deliveryId, scope.deliveryId) : undefined,
        scope?.endpointId ? eq(chatActions.endpointId, scope.endpointId) : undefined,
        scope?.repositoryId ? eq(repositoryId, scope.repositoryId) : undefined,
        scope?.number ? eq(number, String(scope.number)) : undefined,
        cursor ? gt(chatActions.id, cursor) : undefined, actionId ? eq(chatActions.id, actionId) : undefined,
      )).orderBy(asc(chatActions.id)).limit(100);
  }
  async function entry(row: Awaited<ReturnType<typeof page>>[number]): Promise<Entry | null> {
    const pending: Entry = { id: row.id, companyId: row.companyId, endpointId: row.endpointId, deliveryId: row.deliveryId!,
      issueId: row.issueId, conversationId: row.conversationId, repositoryId: row.repositoryId,
      number: row.number ? Number(row.number) : null, dueAt: row.leaseExpiresAt ? Date.parse(row.leaseExpiresAt) : 0 };
    try {
      const execution = await githubResponseExecution(db, { ...row, agentId: row.agentId!, deliveryId: row.deliveryId! });
      if (execution.body === undefined || execution.reply === "unsettled" ||
          (execution.paused && row.result?.pausedVersion === execution.version)) return null;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
      // Keep this request eligible for the acknowledgement owner's authority
      // check and cancellation; it must not poison discovery for other requests.
    }
    return pending;
  }

  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.chatGitHubTerminalResponses,
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
        for (const row of rows) {
          if (!canRun() || signal?.aborted) throw signal?.reason ?? new Error("GitHub terminal-response recovery stopped");
          const value = await entry(row); if (value) entries.push(value);
        }
        if (rows.length < 100) return entries;
        cursor = rows[rows.length - 1].id;
      }
      throw signal?.reason ?? new Error("GitHub terminal-response recovery stopped");
    },
    check: async (value: Entry, signal?: AbortSignal) => {
      const [row] = await page(undefined, undefined, value.id);
      const current = row ? await entry(row) : null;
      if (!current || current.dueAt > Date.now() || !canRun() || signal?.aborted) return current;
      await acknowledge(current.deliveryId, () => canRun() && !signal?.aborted);
      const [remaining] = await page(undefined, undefined, value.id);
      return remaining ? entry(remaining) : null;
    },
  }, canRun);
}
