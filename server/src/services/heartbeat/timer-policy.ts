import { agents, heartbeatRuns, costEvents, issues, type Db } from "@paperclipai/db";
import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS, compareCents } from "@paperclipai/shared";
import { and, eq, gte, lt, notInArray, sql, isNull, inArray } from "drizzle-orm";
import { asBoolean, asNumber, parseObject } from "../../adapters/utils.js";
import { isHeartbeatWakeOnDemandEnabled } from "../heartbeat-policy.js";
import { nonIdleSlackIssueCondition } from "../slack-conversation-state.js";

const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50;
const TIMER_ACTIONABLE_ISSUE_STATUSES = ["todo", "in_progress"] as const;

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(
    asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT),
  );
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(
    HEARTBEAT_MAX_CONCURRENT_RUNS_MIN,
    Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed),
  );
}

export function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, false),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: isHeartbeatWakeOnDemandEnabled(agent),
      // A Dot binding has one external turn. Competing assignments must retain
      // their queue position instead of claiming a second run that cannot bind.
      maxConcurrentRuns: agent.adapterType === "paperclip_runner" &&
        ["openai_dot", "grok_bot", "muse"].includes(String(parseObject(agent.adapterConfig).provider))
        ? 1 : normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
      skipTimerWhenNoActionableWork: asBoolean(
        heartbeat.skipTimerWhenNoActionableWork ??
          heartbeat.requireActionableTimerWork ??
          heartbeat.issueOnlyTimer,
        false,
      ),
      maxDailyRuns: normalizeOptionalNonNegativeInteger(
        heartbeat.maxDailyRuns ??
          heartbeat.dailyRunLimit ??
          heartbeat.dailyRunCap ??
          heartbeat.maxRunsPerDay,
      ),
      maxDailyCostCents: normalizeOptionalNonNegativeInteger(
        heartbeat.maxDailyCostCents ??
          heartbeat.dailyCostCentsLimit ??
          heartbeat.dailySpendCentsLimit ??
          heartbeat.dailyBudgetCents,
      ),
    };
  }

  function normalizeOptionalNonNegativeInteger(value: unknown) {
    if (value === null || value === undefined || value === "") return null;
    const normalized = Math.floor(asNumber(value, 0));
    return normalized >= 0 ? normalized : null;
  }

  function currentUtcDayWindow(now = new Date()) {
    const start = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    const end = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      ),
    );
    return { start, end };
  }


/** Shared by dispatch and owned, read-only sleep inspections. */
export function createHeartbeatTimerPolicy(db: Pick<Db, "select">) {
  async function getHeartbeatDailyCapBlock(
    agent: typeof agents.$inferSelect,
    policy: ReturnType<typeof parseHeartbeatPolicy>,
    options: {
      checkRunCap?: boolean;
      checkCostCap?: boolean;
      excludeRunId?: string | null;
      now?: Date;
    } = {},
    client: Pick<Db, "select"> = db,
  ) {
    const checkRunCap = options.checkRunCap ?? true;
    const checkCostCap = options.checkCostCap ?? true;
    const { start, end } = currentUtcDayWindow(options.now);
    if (checkRunCap && policy.maxDailyRuns !== null) {
      const conditions = [
        eq(heartbeatRuns.companyId, agent.companyId),
        eq(heartbeatRuns.agentId, agent.id),
        gte(heartbeatRuns.startedAt, start),
        lt(heartbeatRuns.startedAt, end),
        notInArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
      ];
      if (options.excludeRunId) {
        conditions.push(sql`${heartbeatRuns.id} <> ${options.excludeRunId}`);
      }
      const [row] = await client
        .select({ total: sql<number>`count(*)::integer` })
        .from(heartbeatRuns)
        .where(and(...conditions));
      const observed = Number(row?.total ?? 0);
      if (observed >= policy.maxDailyRuns) {
        return {
          reason: "heartbeat.daily_run_limit",
          observed,
          limit: policy.maxDailyRuns,
        };
      }
    }

    if (checkCostCap && policy.maxDailyCostCents !== null) {
      const [row] = await client
        .select({
          total: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, agent.companyId),
            eq(costEvents.agentId, agent.id),
            gte(costEvents.occurredAt, start),
            lt(costEvents.occurredAt, end),
          ),
        );
      const observed = Number(row?.total ?? 0);
      if (compareCents(String(row?.total ?? 0), policy.maxDailyCostCents) >= 0) {
        return {
          reason: "heartbeat.daily_cost_limit",
          observed,
          limit: policy.maxDailyCostCents,
        };
      }
    }

    return null;
  }

  async function hasActionableTimerWork(agent: typeof agents.$inferSelect) {
    const row = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, agent.companyId),
          eq(issues.assigneeAgentId, agent.id),
          isNull(issues.assigneeUserId),
          isNull(issues.hiddenAt),
          inArray(issues.status, [...TIMER_ACTIONABLE_ISSUE_STATUSES]),
          isNull(issues.conversationAgentId),
          nonIdleSlackIssueCondition(),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function readTimerHeartbeatSchedule(agent: typeof agents.$inferSelect, now = new Date()) {
    const policy = parseHeartbeatPolicy(agent);
    if (!policy.enabled || policy.intervalSec <= 0 || policy.maxDailyRuns === 0 || policy.maxDailyCostCents === 0)
      return { deadline: null, policy, actionable: null, cap: null };
    const actionable = policy.skipTimerWhenNoActionableWork ? await hasActionableTimerWork(agent) : null;
    if (actionable === false) return { deadline: null, policy, actionable, cap: null };
    const dueAt = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime() + policy.intervalSec * 1000;
    const cap = await getHeartbeatDailyCapBlock(agent, policy, { now });
    return { deadline: cap ? Math.max(dueAt, currentUtcDayWindow(now).end.getTime()) : dueAt,
      policy, actionable, cap };
  }

  async function nextTimerHeartbeatAt(agent: typeof agents.$inferSelect, now = new Date()): Promise<number | null> {
    return (await readTimerHeartbeatSchedule(agent, now)).deadline;
  }
  return { parseHeartbeatPolicy, getHeartbeatDailyCapBlock, hasActionableTimerWork, nextTimerHeartbeatAt, readTimerHeartbeatSchedule };
}
