import { agents, heartbeatRuns, costEvents, issues, type Db } from "@paperclipai/db";
import {
  activeHoursWindowSchema,
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
  compareCents,
  isWithinActiveHours,
  nextActiveHoursStart,
  type ActiveHoursWindow,
} from "@paperclipai/shared";
import { and, eq, gte, lt, notInArray, sql, isNull, inArray, type SQL } from "drizzle-orm";
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

export function heartbeatTimerPolicyIsWellFormed(agent: typeof agents.$inferSelect): boolean {
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!record(agent.runtimeConfig)) return false;
  const heartbeat = agent.runtimeConfig.heartbeat;
  if (heartbeat === undefined) return true;
  if (!record(heartbeat)) return false;
  for (const key of ["enabled", "wakeOnDemand", "wakeOnAssignment", "wakeOnOnDemand", "wakeOnAutomation",
    "skipTimerWhenNoActionableWork", "requireActionableTimerWork", "issueOnlyTimer"]) {
    if (heartbeat[key] !== undefined && typeof heartbeat[key] !== "boolean") return false;
  }
  for (const key of ["intervalSec", "maxConcurrentRuns", "maxDailyRuns", "dailyRunLimit", "dailyRunCap", "maxRunsPerDay",
    "maxDailyCostCents", "dailyCostCentsLimit", "dailySpendCentsLimit", "dailyBudgetCents"]) {
    const v = heartbeat[key];
    if (v !== undefined && v !== null && v !== "" && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return false;
  }
  return true;
}

// null means no window is configured. "invalid" means a window is stored but
// malformed; the timer treats that as closed instead of silently unrestricted.
function parseHeartbeatActiveHours(
  heartbeat: Record<string, unknown>,
): ActiveHoursWindow | "invalid" | null {
  if (heartbeat.activeHours === undefined || heartbeat.activeHours === null) return null;
  const parsed = activeHoursWindowSchema.safeParse(heartbeat.activeHours);
  return parsed.success ? parsed.data : "invalid";
}

export function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);

  return {
    enabled: asBoolean(heartbeat.enabled, false),
    intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
    activeHours: parseHeartbeatActiveHours(heartbeat),
    wakeOnDemand: isHeartbeatWakeOnDemandEnabled(agent),
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



type TimerAgent = typeof agents.$inferSelect;
type TimerPolicy = ReturnType<typeof parseHeartbeatPolicy>;
type DailyCap = { reason: string; observed: number; limit: number } | null;
const timerKey = (companyId: string, agentId: string) => JSON.stringify([companyId, agentId]);
function dailyRunConditions(scope: SQL, now: Date) {
  const { start, end } = currentUtcDayWindow(now);
  return and(scope, gte(heartbeatRuns.startedAt, start), lt(heartbeatRuns.startedAt, end),
    notInArray(heartbeatRuns.status, ["queued", "scheduled_retry"]));
}
function dailyCostConditions(scope: SQL, now: Date) {
  const { start, end } = currentUtcDayWindow(now);
  return and(scope, gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end));
}
function actionableConditions(scope: SQL) {
  return and(scope, isNull(issues.assigneeUserId), isNull(issues.hiddenAt),
    inArray(issues.status, [...TIMER_ACTIONABLE_ISSUE_STATUSES]), isNull(issues.conversationAgentId), nonIdleSlackIssueCondition());
}
export function heartbeatDailyCapFromTotals(policy: TimerPolicy, totals: { runs?: number; cost?: string },
  checks: { checkRunCap?: boolean; checkCostCap?: boolean } = {}): DailyCap {
  if (checks.checkRunCap !== false && policy.maxDailyRuns !== null && (totals.runs ?? 0) >= policy.maxDailyRuns)
    return { reason: "heartbeat.daily_run_limit", observed: totals.runs ?? 0, limit: policy.maxDailyRuns };
  if (checks.checkCostCap !== false && policy.maxDailyCostCents !== null
    && compareCents(totals.cost ?? "0", policy.maxDailyCostCents) >= 0)
    return { reason: "heartbeat.daily_cost_limit", observed: Number(totals.cost ?? "0"), limit: policy.maxDailyCostCents };
  return null;
}
// Outside the active-hours window, wait for the window to open instead of
// reporting a past deadline that the timer would keep skipping.
function applyActiveHoursWindow(activeWindow: ActiveHoursWindow | null, deadline: number, now: Date): number | null {
  if (!activeWindow) return deadline;
  const earliest = new Date(Math.max(deadline, now.getTime()));
  if (isWithinActiveHours(activeWindow, earliest)) return deadline;
  return nextActiveHoursStart(activeWindow, earliest)?.getTime() ?? null;
}
export function projectTimerHeartbeatSchedule(agent: TimerAgent, now: Date,
  input: { actionable: boolean | null; cap: DailyCap }) {
  const policy = parseHeartbeatPolicy(agent);
  if (!policy.enabled || policy.intervalSec <= 0 || policy.activeHours === "invalid"
    || policy.maxDailyRuns === 0 || policy.maxDailyCostCents === 0)
    return { deadline: null, policy, actionable: null, cap: null };
  if (input.actionable === false) return { deadline: null, policy, actionable: false, cap: null };
  const dueAt = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime() + policy.intervalSec * 1000;
  const deadline = input.cap ? Math.max(dueAt, currentUtcDayWindow(now).end.getTime()) : dueAt;
  return { deadline: applyActiveHoursWindow(policy.activeHours, deadline, now),
    policy, actionable: input.actionable, cap: input.cap };
}

export function createHeartbeatTimerPolicy(db: Pick<Db, "select">) {
  async function getHeartbeatDailyCapBlock(agent: TimerAgent, policy: TimerPolicy,
    options: { checkRunCap?: boolean; checkCostCap?: boolean; excludeRunId?: string | null; now?: Date } = {},
    client: Pick<Db, "select"> = db): Promise<DailyCap> {
    const now = options.now ?? new Date();
    if (options.checkRunCap !== false && policy.maxDailyRuns !== null) {
      const [row] = await client.select({ total: sql<number>`count(*)::integer` }).from(heartbeatRuns)
        .where(dailyRunConditions(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id),
          options.excludeRunId ? sql`${heartbeatRuns.id} <> ${options.excludeRunId}` : undefined)!, now));
      const cap = heartbeatDailyCapFromTotals(policy, { runs: Number(row?.total ?? 0) }, { checkCostCap: false });
      if (cap) return cap;
    }
    if (options.checkCostCap !== false && policy.maxDailyCostCents !== null) {
      const [row] = await client.select({ total: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text` }).from(costEvents)
        .where(dailyCostConditions(and(eq(costEvents.companyId, agent.companyId), eq(costEvents.agentId, agent.id))!, now));
      return heartbeatDailyCapFromTotals(policy, { cost: String(row?.total ?? 0) }, { checkRunCap: false });
    }
    return null;
  }
  async function hasActionableTimerWork(agent: TimerAgent) {
    const rows = await db.select({ id: issues.id }).from(issues)
      .where(actionableConditions(and(eq(issues.companyId, agent.companyId), eq(issues.assigneeAgentId, agent.id))!)).limit(1);
    return rows.length > 0;
  }
  async function readTimerHeartbeatSchedule(agent: TimerAgent, now = new Date()) {
    const policy = parseHeartbeatPolicy(agent);
    if (!policy.enabled || policy.intervalSec <= 0 || policy.activeHours === "invalid"
      || policy.maxDailyRuns === 0 || policy.maxDailyCostCents === 0)
      return projectTimerHeartbeatSchedule(agent, now, { actionable: null, cap: null });
    const actionable = policy.skipTimerWhenNoActionableWork ? await hasActionableTimerWork(agent) : null;
    const cap = actionable === false ? null : await getHeartbeatDailyCapBlock(agent, policy, { now });
    return projectTimerHeartbeatSchedule(agent, now, { actionable, cap });
  }
  async function readTimerHeartbeatSchedules(candidates: TimerAgent[], now: Date, checkBudget: () => void = () => {}) {
    if (candidates.length > 10_000) return;
    const allowed = new Set(candidates.map(agent => timerKey(agent.companyId, agent.id)));
    if (allowed.size !== candidates.length) return;
    const eligible = candidates.filter(agent => {
      const p = parseHeartbeatPolicy(agent);
      return p.enabled && p.intervalSec > 0 && p.activeHours !== "invalid" && p.maxDailyRuns !== 0 && p.maxDailyCostCents !== 0;
    });
    const runIds = eligible.filter(a => parseHeartbeatPolicy(a).maxDailyRuns !== null).map(a => a.id);
    const costIds = eligible.filter(a => parseHeartbeatPolicy(a).maxDailyCostCents !== null).map(a => a.id);
    const actionableIds = eligible.filter(a => parseHeartbeatPolicy(a).skipTimerWhenNoActionableWork).map(a => a.id);
    const runs = new Map<string, number>(), costs = new Map<string, string>(), actionable = new Set<string>();
    const state: unknown[] = [];
    if (runIds.length) {
      checkBudget();
      const rows = await db.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
        total: sql<number>`count(*)::integer` }).from(heartbeatRuns)
        .where(dailyRunConditions(inArray(heartbeatRuns.agentId, runIds), now))
        .groupBy(heartbeatRuns.companyId, heartbeatRuns.agentId).orderBy(heartbeatRuns.companyId, heartbeatRuns.agentId).limit(10_001);
      if (rows.length > 10_000) return;
      for (const row of rows) {
        checkBudget();
        const key = timerKey(row.companyId, row.agentId);
        if (!allowed.has(key) || runs.has(key) || typeof row.total !== "number" || !Number.isSafeInteger(row.total) || row.total < 0) return;
        runs.set(key, row.total);
      }
      state.push(rows);
    }
    if (costIds.length) {
      checkBudget();
      const rows = await db.select({ companyId: costEvents.companyId, agentId: costEvents.agentId,
        total: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text` }).from(costEvents)
        .where(dailyCostConditions(inArray(costEvents.agentId, costIds), now))
        .groupBy(costEvents.companyId, costEvents.agentId).orderBy(costEvents.companyId, costEvents.agentId).limit(10_001);
      if (rows.length > 10_000) return;
      for (const row of rows) {
        checkBudget();
        if (!row.agentId) return;
        const key = timerKey(row.companyId, row.agentId);
        if (!allowed.has(key) || costs.has(key) || typeof row.total !== "string" || !/^-?\d+(?:\.\d+)?$/.test(row.total)) return;
        costs.set(key, row.total);
      }
      state.push(rows);
    }
    if (actionableIds.length) {
      checkBudget();
      const rows = await db.select({ companyId: issues.companyId, agentId: issues.assigneeAgentId }).from(issues)
        .where(actionableConditions(inArray(issues.assigneeAgentId, actionableIds)))
        .groupBy(issues.companyId, issues.assigneeAgentId).orderBy(issues.companyId, issues.assigneeAgentId).limit(10_001);
      if (rows.length > 10_000) return;
      for (const row of rows) {
        checkBudget();
        if (!row.agentId) return;
        const key = timerKey(row.companyId, row.agentId);
        if (!allowed.has(key) || actionable.has(key)) return;
        actionable.add(key);
      }
      state.push(rows);
    }
    const schedules = new Map<string, ReturnType<typeof projectTimerHeartbeatSchedule>>();
    for (const agent of candidates) {
      checkBudget();
      const policy = parseHeartbeatPolicy(agent), key = timerKey(agent.companyId, agent.id);
      schedules.set(agent.id, projectTimerHeartbeatSchedule(agent, now, {
        actionable: policy.skipTimerWhenNoActionableWork ? actionable.has(key) : null,
        cap: heartbeatDailyCapFromTotals(policy, { runs: runs.get(key), cost: costs.get(key) }),
      }));
    }
    return { schedules, state };
  }
  async function nextTimerHeartbeatAt(agent: TimerAgent, now = new Date()): Promise<number | null> {
    return (await readTimerHeartbeatSchedule(agent, now)).deadline;
  }
  return { parseHeartbeatPolicy, getHeartbeatDailyCapBlock, hasActionableTimerWork, nextTimerHeartbeatAt,
    readTimerHeartbeatSchedule, readTimerHeartbeatSchedules };
}
