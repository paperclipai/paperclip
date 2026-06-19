import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { parseObject, asBoolean, asNumber } from "../adapters/utils.js";

/**
 * Dispatcher-Lite (ROC P0) — assigns un-owned `todo` issues to healthy idle agents
 * so the existing PUSH assignment-wakeup picks them up. Closes the "384 unassigned
 * todo with no scanner" gap WITHOUT touching RUN-RATE-CUT, the queue, or any status
 * semantics. Assignment only (status stays `todo`); deliberately ignores `blocked`
 * and already-assigned (incl. orphaned in_progress) work.
 *
 * Safety: server-side single-writer (no agent race); opt-in per agent via
 * runtimeConfig.dispatch.enabled; health-gated (idle + heartbeat-enabled + not in
 * recent-failure cooldown + under concurrency + under WIP cap) so it never feeds the
 * stranded->re-block loop. Flag-gated + per-tick capped + fully reversible.
 */

export interface DispatcherLiteConfig {
  enabled: boolean;
  companyIds: string[];
  maxPerTick: number;
  wipCap: number;
  cooldownMin: number;
}

export function dispatcherLiteConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DispatcherLiteConfig {
  return {
    enabled: env.DISPATCHER_LITE_ENABLED === "true",
    companyIds: (env.DISPATCHER_LITE_COMPANIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxPerTick: Math.max(1, Number(env.DISPATCHER_LITE_MAX_PER_TICK) || 5),
    wipCap: Math.max(1, Number(env.DISPATCHER_LITE_WIP_CAP) || 3),
    cooldownMin: Math.max(0, Number(env.DISPATCHER_LITE_COOLDOWN_MIN ?? 15)),
  };
}

export type DispatcherLiteWakeup = (
  agentId: string,
  opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown>;

export interface DispatcherLiteResult {
  considered: number;
  assigned: number;
  skipped: number;
  dryRun: boolean;
  assignments: Array<{ issueId: string; agentId: string }>;
}

export async function dispatchUnassignedTodo(
  db: Db,
  deps: { wakeup: DispatcherLiteWakeup },
  config: DispatcherLiteConfig,
  opts: { apply?: boolean; now?: Date } = {},
): Promise<DispatcherLiteResult> {
  const apply = opts.apply ?? true;
  const now = opts.now ?? new Date();
  const result: DispatcherLiteResult = {
    considered: 0,
    assigned: 0,
    skipped: 0,
    dryRun: !apply,
    assignments: [],
  };
  if (!config.enabled || config.companyIds.length === 0) return result;

  // Oldest un-owned todo first (FIFO). Priority-weighting is Dispatcher-Lite v2.
  const candidates = await db
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(
      and(
        inArray(issues.companyId, config.companyIds),
        eq(issues.status, "todo"),
        isNull(issues.assigneeAgentId),
        isNull(issues.assigneeUserId),
      ),
    )
    .orderBy(asc(issues.createdAt))
    .limit(config.maxPerTick);
  result.considered = candidates.length;
  if (candidates.length === 0) return result;

  const cooldownCutoff = new Date(now.getTime() - config.cooldownMin * 60_000);

  for (const issue of candidates) {
    const agent = await pickEligibleAgent(db, issue.companyId, config, cooldownCutoff);
    if (!agent) {
      result.skipped += 1;
      continue;
    }
    if (!apply) {
      result.assigned += 1;
      result.assignments.push({ issueId: issue.id, agentId: agent.id });
      logger.info({ issueId: issue.id, agentId: agent.id }, "dispatcher-lite WOULD assign (dry-run)");
      continue;
    }
    // Assign (status stays `todo`). WHERE still-unassigned guards against any race.
    const updated = await db
      .update(issues)
      .set({ assigneeAgentId: agent.id, updatedAt: now })
      .where(
        and(
          eq(issues.id, issue.id),
          isNull(issues.assigneeAgentId),
          isNull(issues.assigneeUserId),
          eq(issues.status, "todo"),
        ),
      )
      .returning({ id: issues.id });
    if (updated.length === 0) {
      result.skipped += 1;
      continue;
    }
    await deps.wakeup(agent.id, {
      source: "assignment",
      triggerDetail: "system",
      reason: "dispatcher_lite",
      requestedByActorType: "system",
      requestedByActorId: "dispatcher_lite",
      payload: { issueId: issue.id },
      contextSnapshot: { issueId: issue.id, source: "dispatcher_lite" },
    });
    result.assigned += 1;
    result.assignments.push({ issueId: issue.id, agentId: agent.id });
  }
  return result;
}

async function pickEligibleAgent(
  db: Db,
  companyId: string,
  config: DispatcherLiteConfig,
  cooldownCutoff: Date,
): Promise<{ id: string } | null> {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.status, "idle")));

  const eligible: Array<{ id: string; wip: number }> = [];
  for (const a of rows) {
    const rc = parseObject(a.runtimeConfig);
    const hb = parseObject(rc.heartbeat);
    if (!asBoolean(hb.enabled, false)) continue;

    const dispatch = parseObject(rc.dispatch);
    if (!asBoolean(dispatch.enabled, false)) continue; // opt-in allowlist

    // Recent-failure circuit breaker.
    const [recentFail] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, a.id),
          eq(heartbeatRuns.status, "failed"),
          gt(heartbeatRuns.startedAt, cooldownCutoff),
        ),
      )
      .limit(1);
    if (recentFail) continue;

    // Concurrency cap.
    const [run] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, a.id), eq(heartbeatRuns.status, "running")));
    const maxConcurrent = Math.max(1, asNumber(hb.maxConcurrentRuns, 1));
    if (Number(run?.count ?? 0) >= maxConcurrent) continue;

    // Open-WIP cap.
    const [wipRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.assigneeAgentId, a.id),
          inArray(issues.status, ["todo", "in_progress"]),
        ),
      );
    const wip = Number(wipRow?.count ?? 0);
    if (wip >= config.wipCap) continue;

    eligible.push({ id: a.id, wip });
  }

  eligible.sort((x, y) => x.wip - y.wip); // least-loaded first
  return eligible[0] ?? null;
}
