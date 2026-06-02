import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";

export const HEARTBEAT_COOLDOWN_DEFERRED_STATUS = "deferred_cooldown";
export const COOLDOWN_ELIGIBLE_AT_PAYLOAD_KEY = "cooldownEligibleAt";
export const COOLDOWN_DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";

export const COOLDOWN_THROTTLED_INVOCATION_SOURCES = ["assignment", "automation"] as const;
export type CooldownThrottledInvocationSource = (typeof COOLDOWN_THROTTLED_INVOCATION_SOURCES)[number];

export const PENDING_AGENT_WAKEUP_STATUSES = [
  "queued",
  "deferred_issue_execution",
  HEARTBEAT_COOLDOWN_DEFERRED_STATUS,
] as const;

export interface HeartbeatCooldownPolicy {
  cooldownSec: number;
}

export interface AgentRuntimeThrottle {
  active: boolean;
  eligibleAt: string | null;
  cooldownSec: number;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function parseHeartbeatCooldownPolicy(runtimeConfig: unknown): HeartbeatCooldownPolicy {
  const heartbeat = parseObject(parseObject(runtimeConfig).heartbeat);
  return {
    cooldownSec: Math.max(0, Math.floor(asNumber(heartbeat.cooldownSec, 0))),
  };
}

export function shouldBypassHeartbeatCooldown(input: {
  source: string;
  requestedByActorType?: string | null;
}): boolean {
  if (input.source === "timer") return true;
  if (input.source === "on_demand" && input.requestedByActorType === "user") return true;
  return false;
}

export function isHeartbeatCooldownThrottledSource(
  source: string,
): source is CooldownThrottledInvocationSource {
  return (COOLDOWN_THROTTLED_INVOCATION_SOURCES as readonly string[]).includes(source);
}

export async function getLastThrottledHeartbeatFinishedAt(
  db: Db,
  agentId: string,
): Promise<Date | null> {
  const row = await db
    .select({ finishedAt: heartbeatRuns.finishedAt })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.invocationSource, [...COOLDOWN_THROTTLED_INVOCATION_SOURCES]),
        sql`${heartbeatRuns.finishedAt} is not null`,
      ),
    )
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return row?.finishedAt ?? null;
}

export function computeHeartbeatCooldownEligibleAt(
  lastFinishedAt: Date | null,
  cooldownSec: number,
  now = new Date(),
): Date | null {
  if (cooldownSec <= 0 || !lastFinishedAt) return null;
  const eligibleMs = lastFinishedAt.getTime() + cooldownSec * 1000;
  if (now.getTime() >= eligibleMs) return null;
  return new Date(eligibleMs);
}

function readEligibleAtFromPayload(payload: unknown): Date | null {
  const parsed = parseObject(payload);
  const raw = parsed[COOLDOWN_ELIGIBLE_AT_PAYLOAD_KEY];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function getActiveCooldownDeferral(db: Db, agentId: string) {
  return db
    .select()
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, HEARTBEAT_COOLDOWN_DEFERRED_STATUS),
      ),
    )
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function resolveIssuePriorityForCooldown(
  db: Db,
  companyId: string,
  issueId: string | null,
): Promise<string | null> {
  if (!issueId) return null;
  const row = await db
    .select({ priority: issues.priority })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return row?.priority ?? null;
}

export async function evaluateHeartbeatCooldownGate(
  db: Db,
  input: {
    agentId: string;
    companyId: string;
    source: string;
    cooldownSec: number;
    issueId: string | null;
    requestedByActorType?: string | null;
    now?: Date;
  },
): Promise<{ blocked: boolean; eligibleAt: Date | null; bypassed: boolean }> {
  const now = input.now ?? new Date();
  if (input.cooldownSec <= 0 || shouldBypassHeartbeatCooldown(input)) {
    return { blocked: false, eligibleAt: null, bypassed: true };
  }
  if (!isHeartbeatCooldownThrottledSource(input.source)) {
    return { blocked: false, eligibleAt: null, bypassed: false };
  }

  const priority = await resolveIssuePriorityForCooldown(db, input.companyId, input.issueId);
  if (priority === "critical") {
    return { blocked: false, eligibleAt: null, bypassed: true };
  }

  const activeDeferral = await getActiveCooldownDeferral(db, input.agentId);
  const deferralEligibleAt = activeDeferral
    ? readEligibleAtFromPayload(activeDeferral.payload)
    : null;
  if (deferralEligibleAt && now.getTime() < deferralEligibleAt.getTime()) {
    return { blocked: true, eligibleAt: deferralEligibleAt, bypassed: false };
  }

  const lastFinishedAt = await getLastThrottledHeartbeatFinishedAt(db, input.agentId);
  const eligibleAt = computeHeartbeatCooldownEligibleAt(lastFinishedAt, input.cooldownSec, now);
  if (!eligibleAt) {
    return { blocked: false, eligibleAt: null, bypassed: false };
  }

  return { blocked: true, eligibleAt, bypassed: false };
}

export async function computeAgentRuntimeThrottle(
  db: Db,
  agent: { id: string; runtimeConfig: unknown },
  now = new Date(),
): Promise<AgentRuntimeThrottle> {
  const { cooldownSec } = parseHeartbeatCooldownPolicy(agent.runtimeConfig);
  if (cooldownSec <= 0) {
    return { active: false, eligibleAt: null, cooldownSec: 0 };
  }

  const activeDeferral = await getActiveCooldownDeferral(db, agent.id);
  const deferralEligibleAt = activeDeferral
    ? readEligibleAtFromPayload(activeDeferral.payload)
    : null;
  if (deferralEligibleAt && now.getTime() < deferralEligibleAt.getTime()) {
    return {
      active: true,
      eligibleAt: deferralEligibleAt.toISOString(),
      cooldownSec,
    };
  }

  const lastFinishedAt = await getLastThrottledHeartbeatFinishedAt(db, agent.id);
  const eligibleAt = computeHeartbeatCooldownEligibleAt(lastFinishedAt, cooldownSec, now);
  if (!eligibleAt) {
    return { active: false, eligibleAt: null, cooldownSec };
  }

  return {
    active: true,
    eligibleAt: eligibleAt.toISOString(),
    cooldownSec,
  };
}

export async function promoteDueCooldownDeferred(
  db: Db,
  promote: (request: typeof agentWakeupRequests.$inferSelect) => Promise<boolean>,
  now = new Date(),
) {
  const dueRequests = await db
    .select()
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.status, HEARTBEAT_COOLDOWN_DEFERRED_STATUS),
        lte(
          sql`(${agentWakeupRequests.payload} ->> 'cooldownEligibleAt')::timestamptz`,
          now,
        ),
      ),
    )
    .orderBy(agentWakeupRequests.requestedAt)
    .limit(50);

  const promotedRequestIds: string[] = [];
  for (const request of dueRequests) {
    const promoted = await promote(request);
    if (promoted) promotedRequestIds.push(request.id);
  }

  return {
    promoted: promotedRequestIds.length,
    requestIds: promotedRequestIds,
  };
}

export async function assertAgentInvokableForCooldownPromotion(
  db: Db,
  agentId: string,
) {
  const agent = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);

  if (!agent) return { ok: false as const, reason: "Agent not found" };
  if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
    return { ok: false as const, reason: "Agent is not invokable" };
  }
  return { ok: true as const, agent };
}
