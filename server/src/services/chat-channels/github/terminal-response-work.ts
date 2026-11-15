import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { chatActions, chatConversations, chatDeliveries, chatEndpointLeases, chatEndpointResources,
  chatEndpoints, chatMessageLinks, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "../../scoped-deadline-work.js";
import { githubResponseExecution } from "./response-execution.js";
import { readGitHubResponseRuns, type GitHubResponseRunRead } from "./response-run-state.js";
import { githubResponseReconstructionIntervalMs, type GitHubResponseSweepScope as Scope } from "./response-sweep-scope.js";
import { HttpError } from "../../../errors.js";
type Entry = { id: string; companyId: string; endpointId: string; deliveryId: string;
  issueId: string; conversationId: string; repositoryId: string | null; number: number | null; dueAt: number };

/** A load of a whole company (or every company) rather than a targeted hint. */
const broad = (scope?: Scope) => !scope || (!scope.issueId && !scope.deliveryId && !scope.conversationId &&
  !scope.endpointId && !scope.repositoryId && !scope.number);

export function registerGitHubTerminalResponseWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  acknowledge: (deliveryId: string, canContinue: () => boolean) => Promise<unknown>,
  canRun: () => boolean,
) {
  const repositoryId = sql<string | null>`${chatEndpointResources.metadata}->>'providerRepositoryId'`;
  const number = sql<string | null>`substring(${chatConversations.externalThreadId}
    from '^github:[^:]+:(?:issue:)?([1-9][0-9]*)(?::rc:[1-9][0-9]*)?$')`;
  // The assigned agent's latest run bound to the issue, where a run's issue is
  // coalesce(native_issue_id, context_snapshot->>'issueId'). The two
  // precedence branches are disjoint and each uses an issue index, so a
  // candidate does not walk (and detoast) the agent's whole run history.
  const latestIssueRun = db.select({
    status: sql<string>`latest.status`.as("latest_run_status"),
    version: sql<string>`latest.id::text || ':' || latest.status || ':' || extract(epoch from latest.updated_at)::text`
      .as("latest_run_version"),
  }).from(sql`((select r.status, r.created_at, r.id, r.updated_at from ${heartbeatRuns} r
      where r.company_id = ${chatActions.companyId} and r.native_issue_id = ${chatConversations.issueId}
        and r.agent_id = ${chatEndpoints.assignedAgentId}
      order by r.created_at desc, r.id desc limit 1)
    union all
    (select r.status, r.created_at, r.id, r.updated_at from ${heartbeatRuns} r
      where r.company_id = ${chatActions.companyId} and r.native_issue_id is null
        and r.context_snapshot->>'issueId' = ${chatConversations.issueId}::text
        and r.agent_id = ${chatEndpoints.assignedAgentId}
      order by r.created_at desc, r.id desc limit 1)) latest`)
    .orderBy(sql`latest.created_at desc, latest.id desc`).limit(1).as("latest_issue_run");
  // A request whose latest run does not own it (or whose pause is already
  // shown) can progress only once the task's latest run, the task's status or
  // the request's own row changes. Such a request records this key, and a broad
  // rebuild skips it until one of them changes. A targeted load still reads it.
  const actionVersion = sql<string>`extract(epoch from ${chatActions.updatedAt})::text`;
  const waitKey = sql<string>`coalesce(${latestIssueRun.version}, 'none') || '|' || ${issues.status} || '|' || ${actionVersion}`;
  async function page(scope?: Scope, cursor?: string, actionId?: string) {
    return db.select({
      id: chatActions.id, companyId: chatActions.companyId, endpointId: chatActions.endpointId,
      deliveryId: chatActions.deliveryId, conversationId: chatConversations.id, issueId: issues.id,
      agentId: chatEndpoints.assignedAgentId, issueStatus: issues.status,
      deliveryCreatedAt: chatDeliveries.createdAt, repositoryId, number, result: chatActions.result, actionVersion, waitKey,
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
      .leftJoinLateral(latestIssueRun, sql`true`)
      .where(and(eq(chatActions.kind, "github_response_comment"), eq(chatActions.status, "processed"),
        isNotNull(chatActions.deliveryId), isNotNull(chatEndpoints.assignedAgentId),
        sql`coalesce(${chatActions.result}->>'final', 'false') <> 'true'`,
        sql`(${issues.status} = 'blocked' or ${latestIssueRun.status} in ('succeeded', 'failed', 'interrupted', 'timed_out', 'cancelled'))`,
        broad(scope) && !actionId ? sql`${chatActions.result}->>'terminalWaitKey' is distinct from ${waitKey}` : undefined,
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
  type Row = Awaited<ReturnType<typeof page>>[number];
  /** The request's entry when it is owed now, else whether its wait may be
   * recorded. A wait on the owning run's reply or presentation is never
   * recorded: a publication that commits it changes no wait-key input, and a
   * restart can lose the hint that its lease release sends. */
  async function entry(row: Row, read: GitHubResponseRunRead): Promise<Entry | { parkable: boolean }> {
    try {
      const execution = await githubResponseExecution(db, { ...row, agentId: row.agentId!, deliveryId: row.deliveryId! }, read);
      if (execution.body === undefined || execution.reply === "unsettled" ||
          (execution.paused && row.result?.pausedVersion === execution.version))
        return { parkable: !execution.presentationPending && execution.reply === "none" };
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 403) throw error;
      // Keep this request eligible for the acknowledgement owner's authority
      // check and cancellation; it must not poison discovery for other requests.
    }
    return pending(row);
  }
  /** The request's entry, before its run state is read. */
  function pending(row: Row): Entry {
    return { id: row.id, companyId: row.companyId, endpointId: row.endpointId, deliveryId: row.deliveryId!,
      issueId: row.issueId, conversationId: row.conversationId, repositoryId: row.repositoryId,
      number: row.number ? Number(row.number) : null, dueAt: row.leaseExpiresAt ? Date.parse(row.leaseExpiresAt) : 0 };
  }
  /** The entries of a page, by position, from one batched run-state read. */
  async function entries(rows: Row[], signal?: AbortSignal) {
    const reads = await readGitHubResponseRuns(db, rows.map(row => ({ companyId: row.companyId, endpointId: row.endpointId,
      agentId: row.agentId!, issueId: row.issueId, deliveryId: row.deliveryId!, sourceMessageId: row.sourceMessageId })));
    const values: Array<Awaited<ReturnType<typeof entry>>> = [];
    for (const [index, row] of rows.entries()) {
      if (!canRun() || signal?.aborted) throw signal?.reason ?? new Error("GitHub terminal-response recovery stopped");
      values.push(await entry(row, reads[index]!));
    }
    return values;
  }
  /** Record the wait of requests that cannot progress yet. A request whose row
   * changed after the read gets no key and is read again. The write leaves
   * updated_at alone, because the key includes it. */
  async function park(rows: Row[]) {
    const waiting = rows.filter(row => row.result?.terminalWaitKey !== row.waitKey);
    if (!waiting.length) return;
    await db.execute(sql`update ${chatActions}
      set result = coalesce(${chatActions.result}, '{}'::jsonb) || jsonb_build_object('terminalWaitKey', waiting.key)
      from unnest(${sql.param(waiting.map(row => row.id))}::uuid[], ${sql.param(waiting.map(row => row.actionVersion))}::text[],
        ${sql.param(waiting.map(row => row.waitKey))}::text[]) as waiting(id, version, key)
      where ${chatActions.id} = waiting.id and ${actionVersion} = waiting.version
        and ${chatActions.status} = 'processed' and coalesce(${chatActions.result}->>'final', 'false') <> 'true'`);
  }
  async function current(actionId: string) {
    const [row] = await page(undefined, undefined, actionId);
    if (!row) return null;
    const [value] = await entries([row]);
    if (!("parkable" in value!)) return value!;
    if (value.parkable) await park([row]);
    return null;
  }

  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.chatGitHubTerminalResponses,
    reconstructionIntervalMs: githubResponseReconstructionIntervalMs,
    decodeScope: (hint: string): Scope | undefined => hint === "*" ? undefined : JSON.parse(hint),
    matches: (value: Entry, scope?: Scope) => !scope || (value.companyId === scope.companyId &&
      (!scope.issueId || value.issueId === scope.issueId) && (!scope.deliveryId || value.deliveryId === scope.deliveryId) &&
      (!scope.conversationId || value.conversationId === scope.conversationId) &&
      (!scope.endpointId || value.endpointId === scope.endpointId) && (!scope.repositoryId || value.repositoryId === scope.repositoryId) &&
      (!scope.number || value.number === scope.number)),
    load: async (scope?: Scope, signal?: AbortSignal) => {
      const loaded: Entry[] = [];
      let cursor: string | undefined;
      while (canRun() && !signal?.aborted) {
        const rows = await page(scope, cursor);
        const values = await entries(rows, signal);
        const waiting: Row[] = [];
        for (const [index, value] of values.entries()) {
          if (!("parkable" in value)) loaded.push(value); else if (value.parkable) waiting.push(rows[index]!);
        }
        await park(waiting);
        if (rows.length < 100) return loaded;
        cursor = rows[rows.length - 1].id;
      }
      throw signal?.reason ?? new Error("GitHub terminal-response recovery stopped");
    },
    check: async (value: Entry, signal?: AbortSignal) => {
      const due = await current(value.id);
      if (!due || due.dueAt > Date.now() || !canRun() || signal?.aborted) return due;
      await acknowledge(due.deliveryId, () => canRun() && !signal?.aborted);
      // Keep a request that still waits for the next check, which reads its
      // run state again before it acknowledges. One check reads it once.
      const [remaining] = await page(undefined, undefined, value.id);
      return remaining ? pending(remaining) : null;
    },
  }, canRun);
}
