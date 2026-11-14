import { and, asc, desc, eq, gte, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { ExecutionAgentQueue } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import {
  OLDEST_DISPATCH_SHARE,
  PERSON_WAKE_REASONS,
  RECOVERY_DISPATCH_SHARE,
  dispatchCountersFromStarts,
  dispatchHistoryStart,
  queuedRunDispatchLine,
  type QueuedRunDispatchFacts,
  type QueuedRunDispatchInput,
} from "./queued-run-dispatch-order.js";
import { parseHeartbeatPolicy } from "./timer-policy.js";
import { instanceSettingsService, isTruthyRuntimeEnvValue, resolveWorktreeRunExecutionActivation } from "../instance-settings.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSON_ORIGIN_CHAIN_DEPTH = 8;

/** The run fields dispatch ordering reads. */
export type QueuedRunDispatchRun = Pick<HeartbeatRun, "id" | "createdAt" | "wakeupRequestId" | "retryOfRunId" | "contextSnapshot">;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function issueRunPriorityRank(priority: string | null | undefined) {
  switch (priority) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
    default: return 4;
  }
}

/**
 * SQL: whether the run `runId` was asked for by a person, itself or through
 * its source chain (`previousRunId`, else `retryOfRunId`), the same rule as
 * {@link listPersonOriginSourceRunIds}. For use inside another query.
 */
export function personOriginRunSql(companyId: SQL, runId: SQL) {
  const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
  return sql`exists (
    with recursive origin_chain(run_id, depth) as (
      select ${runId}, 0
      union all
      select parent.id, origin_chain.depth + 1
      from origin_chain
      join heartbeat_runs origin_child on origin_child.id = origin_chain.run_id
      join heartbeat_runs parent on parent.company_id = ${companyId} and parent.id = coalesce(
        case when origin_child.context_snapshot->>'previousRunId' ~* ${uuidPattern}
          then (origin_child.context_snapshot->>'previousRunId')::uuid end,
        origin_child.retry_of_run_id)
      where origin_chain.depth < ${PERSON_ORIGIN_CHAIN_DEPTH}
    )
    select 1 from origin_chain join heartbeat_runs origin_run on origin_run.id = origin_chain.run_id
    where origin_run.context_snapshot->>'wakeReason' in (${sql.join([...PERSON_WAKE_REASONS].map(reason => sql`${reason}`), sql`, `)})
      or origin_run.context_snapshot->>'taskRetryRequestId' is not null
      or exists (select 1 from agent_wakeup_requests origin_wake where origin_wake.company_id = ${companyId}
        and origin_wake.requested_by_actor_type = 'user' and (origin_wake.run_id = origin_run.id or origin_wake.id = origin_run.wakeup_request_id)))`;
}

export async function listPersonOriginSourceRunIds(db: Db, companyId: string, sourceRunIds: string[]) {
  const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
  const result = await db.execute<{ root_id: string }>(sql`
    with recursive chain(root_id, run_id, depth) as (
      select source.id, source.id, 0 from ${heartbeatRuns} source
      where source.company_id = ${companyId} and source.id in (${sql.join(sourceRunIds.map(id => sql`${id}::uuid`), sql`, `)})
      union all
      select chain.root_id, parent.id, chain.depth + 1
      from chain
      join ${heartbeatRuns} child on child.id = chain.run_id
      join ${heartbeatRuns} parent on parent.company_id = ${companyId} and parent.id = coalesce(
        case when child.context_snapshot->>'previousRunId' ~* ${uuidPattern}
          then (child.context_snapshot->>'previousRunId')::uuid end,
        child.retry_of_run_id)
      where chain.depth < ${PERSON_ORIGIN_CHAIN_DEPTH}
    )
    select distinct chain.root_id from chain
    join ${heartbeatRuns} run on run.id = chain.run_id
    where run.context_snapshot->>'wakeReason' in (${sql.join([...PERSON_WAKE_REASONS].map(reason => sql`${reason}`), sql`, `)})
      or run.context_snapshot->>'taskRetryRequestId' is not null
      or exists (select 1 from ${agentWakeupRequests} wake where wake.company_id = ${companyId}
        and wake.requested_by_actor_type = 'user' and (wake.run_id = run.id or wake.id = run.wakeup_request_id))`);
  return [...result].map(row => String(row.root_id));
}

/**
 * The facts and share counters the queued-run dispatcher orders an agent's
 * queued runs by. The dispatch path and the "position in line" a waiting task
 * shows both read this one builder, so the line the board sees is the order
 * the server starts runs in.
 */
export async function queuedRunDispatchFacts<R extends QueuedRunDispatchRun>(
  db: Db,
  input: {
    agent: Pick<Agent, "id" | "companyId">;
    queuedRuns: R[];
    dependencyReadiness: Map<string, { isDependencyReady: boolean }>;
    issueById: Map<string, { status: string; priority: string | null; createdByUserId?: string | null }>;
    shareDeferred?: (runId: string) => boolean;
    now: Date;
  },
): Promise<{ facts: Array<QueuedRunDispatchFacts & { run: R }>; dispatchInput: QueuedRunDispatchInput }> {
  const { agent, queuedRuns, dependencyReadiness, issueById, now } = input;
  const wakeReasonOf = (run: R) => readNonEmptyString(parseObject(run.contextSnapshot).wakeReason);
  const requestIds = [...new Set(queuedRuns.flatMap(run => run.wakeupRequestId ? [run.wakeupRequestId] : []))];
  const userRequests = queuedRuns.length > 1 && requestIds.length
    ? await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, agent.companyId), inArray(agentWakeupRequests.id, requestIds),
      eq(agentWakeupRequests.requestedByActorType, "user")))
    : [];
  const userRequestIds = new Set(userRequests.map(row => row.id));
  const joinedUserRequests = queuedRuns.length > 1
    ? await db.select({ runId: agentWakeupRequests.runId }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, agent.companyId), inArray(agentWakeupRequests.runId, queuedRuns.map(run => run.id)),
      eq(agentWakeupRequests.agentId, agent.id), eq(agentWakeupRequests.requestedByActorType, "user")))
    : [];
  const userRunIds = new Set(joinedUserRequests.flatMap(row => row.runId ? [row.runId] : []));
  const joinedByUser = (run: R) =>
    userRunIds.has(run.id) || Boolean(run.wakeupRequestId && userRequestIds.has(run.wakeupRequestId));
  const sourceRunIdOf = (run: R) =>
    readNonEmptyString(parseObject(run.contextSnapshot).previousRunId) ?? run.retryOfRunId ?? null;
  const sourceRunIds = queuedRuns.length > 1
    ? [...new Set(queuedRuns.flatMap(run => {
      const sourceRunId = joinedByUser(run) ? null : sourceRunIdOf(run);
      return sourceRunId && RUN_ID_PATTERN.test(sourceRunId) ? [sourceRunId] : [];
    }))]
    : [];
  const sourceRows = sourceRunIds.length
    ? await db.select({ id: heartbeatRuns.id, finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, agent.companyId), inArray(heartbeatRuns.id, sourceRunIds)))
    : [];
  const sourceEndedAt = new Map(sourceRows.map(row => [row.id, row.finishedAt]));
  const personSourceRunIds = new Set(sourceRows.length
    ? await listPersonOriginSourceRunIds(db, agent.companyId, sourceRows.map(row => row.id))
    : []);
  const requestedByUser = (run: R) => {
    if (joinedByUser(run)) return true;
    const sourceRunId = sourceRunIdOf(run);
    return Boolean(sourceRunId && personSourceRunIds.has(sourceRunId));
  };
  const facts = queuedRuns.map(run => {
    const issueId = readNonEmptyString(parseObject(run.contextSnapshot).issueId);
    const ready = issueId ? (dependencyReadiness.get(issueId)?.isDependencyReady ?? true) : true;
    const issue = issueId ? issueById.get(issueId) : null;
    const sourceRunId = sourceRunIdOf(run);
    return {
      run,
      id: run.id,
      createdAt: run.createdAt,
      wakeReason: wakeReasonOf(run),
      requestedByUser: requestedByUser(run),
      sourceEndedAt: sourceRunId ? sourceEndedAt.get(sourceRunId) ?? null : null,
      readinessRank: issueId ? (ready ? (issue?.status === "in_progress" ? 0 : 1) : 3) : 2,
      priorityRank: issueRunPriorityRank(issue?.priority),
      shareDeferred: input.shareDeferred?.(run.id) ?? false,
      personTask: Boolean(issue?.createdByUserId),
    };
  });
  const since = dispatchHistoryStart(facts, now);
  const startRows = since ? await db.select({ id: heartbeatRuns.id, wakeReason: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'wakeReason'`,
    startedAt: heartbeatRuns.startedAt, createdAt: heartbeatRuns.createdAt,
    issueId: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'issueId'` })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id),
      isNotNull(heartbeatRuns.startedAt), gte(heartbeatRuns.startedAt, since)))
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(Math.max(RECOVERY_DISPATCH_SHARE, OLDEST_DISPATCH_SHARE)) : [];
  // A person's recovery restart is person work, so it does not use up system recovery's share;
  // only a start people wait on uses up their oldest-run turn.
  const personStarts = new Set(startRows.length
    ? await listPersonOriginSourceRunIds(db, agent.companyId, startRows.map(row => row.id)) : []);
  const startedTaskIds = [...new Set(startRows.flatMap(row => row.issueId && RUN_ID_PATTERN.test(row.issueId) ? [row.issueId] : []))];
  const personTaskIds = new Set(startedTaskIds.length
    ? (await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, agent.companyId),
      inArray(issues.id, startedTaskIds), isNotNull(issues.createdByUserId)))).map(row => row.id)
    : []);
  const recentStarts = startRows.map(row => ({ ...row, personOrigin: personStarts.has(row.id),
    personWaiting: personStarts.has(row.id) || Boolean(row.issueId && personTaskIds.has(row.issueId)) }));
  const { startsSinceRecovery, startsSinceOldest } = dispatchCountersFromStarts(facts, recentStarts, now);
  return { facts, dispatchInput: { now, startsSinceRecovery, startsSinceOldest } };
}

/** At most this many agents' lines are computed for one projection read. */
export const MAX_AGENT_QUEUE_LINES_PER_READ = 8;

/**
 * Where each queued, never-started run waits in its agent's line, for agents
 * whose concurrency limit is full. An agent with a free slot is omitted: its
 * runs are not waiting on the limit. One read of the agents and their running
 * counts, then one line per full agent.
 */
export async function agentQueueLinesForRuns(
  db: Db,
  companyId: string,
  queuedRuns: Array<{ id: string; agentId: string }>,
  now = new Date(),
): Promise<Map<string, ExecutionAgentQueue>> {
  const result = new Map<string, ExecutionAgentQueue>();
  const agentIds = [...new Set(queuedRuns.map(run => run.agentId))];
  if (!agentIds.length) return result;
  const [agentRows, runningRows] = await Promise.all([
    db.select().from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))),
    db.select({ agentId: heartbeatRuns.agentId, count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(inArray(heartbeatRuns.agentId, agentIds), eq(heartbeatRuns.status, "running")))
      .groupBy(heartbeatRuns.agentId),
  ]);
  const runningByAgent = new Map(runningRows.map(row => [row.agentId, Number(row.count)]));
  const fullAgents = agentRows.flatMap(agent => {
    const maxConcurrentRuns = parseHeartbeatPolicy(agent).maxConcurrentRuns;
    const runningCount = runningByAgent.get(agent.id) ?? 0;
    return runningCount >= maxConcurrentRuns ? [{ agent, maxConcurrentRuns, runningCount }] : [];
  }).slice(0, MAX_AGENT_QUEUE_LINES_PER_READ);
  if (!fullAgents.length) return result;
  // Lazy: the issue service imports the execution projection that calls this.
  const { issueService } = await import("../issues.js");
  const issuesSvc = issueService(db);
  const wanted = new Set(queuedRuns.map(run => run.id));
  await Promise.all(fullAgents.map(async ({ agent, maxConcurrentRuns, runningCount }) => {
    const line = await cachedAgentQueuedRunLine(db, issuesSvc, agent, now);
    line.forEach((runId, index) => {
      if (!wanted.has(runId)) return;
      result.set(runId, {
        agentId: agent.id,
        agentName: agent.name,
        maxConcurrentRuns,
        runningCount,
        position: index + 1,
        queuedCount: line.length,
      });
    });
  }));
  return result;
}

/** The agent's queued runs, in the order dispatch starts them (the same set and order as startNextQueuedRunForAgent). */
export async function agentQueuedRunLine(
  db: Db,
  issuesSvc: { listDependencyReadiness: (companyId: string, issueIds: string[]) => Promise<Map<string, { isDependencyReady: boolean }>> },
  agent: Agent,
  now = new Date(),
  options: { cutoff?: Date | null } = {},
): Promise<string[]> {
  const cutoff = options.cutoff !== undefined ? options.cutoff : await worktreeExecutionCutoff(db);
  const queuedRuns = await db.select({
    id: heartbeatRuns.id,
    createdAt: heartbeatRuns.createdAt,
    wakeupRequestId: heartbeatRuns.wakeupRequestId,
    retryOfRunId: heartbeatRuns.retryOfRunId,
    // Only the keys ordering reads; full snapshots are large.
    contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
      'issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
      'wakeReason', ${heartbeatRuns.contextSnapshot}->'wakeReason',
      'previousRunId', ${heartbeatRuns.contextSnapshot}->'previousRunId')`,
  }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id),
      eq(heartbeatRuns.status, "queued"), cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined))
    .orderBy(asc(heartbeatRuns.createdAt));
  if (!queuedRuns.length) return [];
  const issueIds = [...new Set(queuedRuns.flatMap(run => {
    const issueId = readNonEmptyString(parseObject(run.contextSnapshot).issueId);
    return issueId ? [issueId] : [];
  }))];
  const [dependencyReadiness, issueRows] = issueIds.length
    ? await Promise.all([
      issuesSvc.listDependencyReadiness(agent.companyId, issueIds),
      db.select({ id: issues.id, status: issues.status, priority: issues.priority, createdByUserId: issues.createdByUserId }).from(issues)
        .where(and(eq(issues.companyId, agent.companyId), inArray(issues.id, issueIds))),
    ])
    : [new Map<string, { isDependencyReady: boolean }>(), []];
  const { facts, dispatchInput } = await queuedRunDispatchFacts(db, {
    agent,
    queuedRuns,
    dependencyReadiness,
    issueById: new Map(issueRows.map(row => [row.id, row])),
    now,
  });
  return queuedRunDispatchLine(facts, dispatchInput).map(entry => entry.id);
}

/**
 * Dispatch skips queued runs created before an enabled preview worktree's
 * cutoff, so the line skips them too. Outside a worktree this reads nothing.
 */
export async function worktreeExecutionCutoff(db: Db, env: NodeJS.ProcessEnv = process.env): Promise<Date | null> {
  if (!isTruthyRuntimeEnvValue(env.PAPERCLIP_IN_WORKTREE)) return null;
  const activation = resolveWorktreeRunExecutionActivation(
    await instanceSettingsService(db).getExperimental(),
    env.PAPERCLIP_INSTANCE_ID?.trim() || null,
  );
  const cutoff = activation.armed ? new Date(activation.cutoff) : null;
  return cutoff && !Number.isNaN(cutoff.getTime()) ? cutoff : null;
}

/**
 * Board reads repeat while the line changes only when a run starts, finishes or
 * joins. A short per-agent memo, shared by concurrent reads, keeps a deep queue
 * from being re-read on every task and run read.
 */
export const AGENT_QUEUE_LINE_TTL_MS = 5_000;
const lineCache = new Map<string, { at: number; line: Promise<string[]> }>();

function cachedAgentQueuedRunLine(
  db: Db,
  issuesSvc: Parameters<typeof agentQueuedRunLine>[1],
  agent: Agent,
  now: Date,
): Promise<string[]> {
  const key = `${agent.companyId}:${agent.id}`;
  const at = Date.now();
  const cached = lineCache.get(key);
  if (cached && at - cached.at < AGENT_QUEUE_LINE_TTL_MS) return cached.line;
  for (const [entryKey, entry] of lineCache) {
    if (at - entry.at >= AGENT_QUEUE_LINE_TTL_MS) lineCache.delete(entryKey);
  }
  const line = agentQueuedRunLine(db, issuesSvc, agent, now);
  lineCache.set(key, { at, line });
  line.catch(() => { if (lineCache.get(key)?.line === line) lineCache.delete(key); });
  return line;
}

/** Test hook: forget memoized lines. */
export function clearAgentQueueLineCache() {
  lineCache.clear();
}
