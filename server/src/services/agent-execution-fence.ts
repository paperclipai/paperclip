import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type FenceDb = Db | DbTransaction;

const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const UNFINALIZED_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const NEVER_EXECUTING_RUN_STATUSES = ["queued", "scheduled_retry"] as const;

function errorChain(error: unknown) {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : null;
  }
  return chain;
}

export function isAgentExecutionFenceError(error: unknown) {
  return errorChain(error).some((entry) => {
    if (!(entry instanceof Error)) return false;
    const code = "code" in entry ? String((entry as Error & { code?: unknown }).code ?? "") : "";
    return code === "55000" && /execution fence/i.test(entry.message);
  });
}

function restorationStatus(status: string) {
  return status === "running" ? "idle" : status;
}

async function readFenceCensus(
  source: FenceDb,
  agentId: string,
) {
  const [activeRuns, parkedRuns, pendingFinalizers, pendingWakeups] = await Promise.all([
    source
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]))),
    source
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "scheduled_retry"))),
    source
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          isNotNull(heartbeatRuns.startedAt),
          isNull(heartbeatRuns.executionFinalizedAt),
          notInArray(heartbeatRuns.status, [...NEVER_EXECUTING_RUN_STATUSES]),
        ),
      ),
    source
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
        ),
      ),
  ]);

  const queuedRunIds = activeRuns.filter((run) => run.status === "queued").map((run) => run.id).sort();
  const runningRunIds = activeRuns.filter((run) => run.status === "running").map((run) => run.id).sort();
  const parkedRunIds = parkedRuns.map((run) => run.id).sort();
  const pendingRunIds = pendingFinalizers.map((run) => run.id).sort();
  const queuedWakeupIds = pendingWakeups.map((wakeup) => wakeup.id).sort();

  return {
    drained:
      queuedRunIds.length === 0 &&
      runningRunIds.length === 0 &&
      parkedRunIds.length === 0 &&
      pendingRunIds.length === 0 &&
      queuedWakeupIds.length === 0,
    queuedRunIds,
    runningRunIds,
    parkedRunIds,
    pendingRunIds,
    queuedWakeupIds,
  };
}

export function agentExecutionFenceService(db: Db) {
  async function getLockedAgent(
    tx: DbTransaction,
    agentId: string,
    companyId?: string,
  ) {
    return tx
      .select()
      .from(agents)
      .where(
        companyId
          ? and(eq(agents.id, agentId), eq(agents.companyId, companyId))
          : eq(agents.id, agentId),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
  }

  return {
    acquire: async (input: {
      agentId: string;
      companyId: string;
      actorUserId: string | null;
      reason: string;
    }) => {
      const fenceId = randomUUID();
      const reason = input.reason.trim().slice(0, 500);
      if (!reason) throw conflict("Execution fence reason is required");

      const result = await db.transaction(async (tx) => {
        const agent = await getLockedAgent(tx, input.agentId, input.companyId);
        if (!agent) throw notFound("Agent not found");
        if (agent.executionFenceId) {
          throw conflict("Agent already has an active execution fence", {
            fenceId: agent.executionFenceId,
          });
        }
        if (agent.status === "terminated" || agent.status === "pending_approval") {
          throw conflict(`Cannot fence agent in ${agent.status} status`);
        }

        const acquiredAt = new Date();

        const census = await readFenceCensus(tx, agent.id);
        if (
          census.queuedRunIds.length > 0 ||
          census.parkedRunIds.length > 0 ||
          census.queuedWakeupIds.length > 0
        ) {
          throw conflict("Execution fence requires queued and parked agent work to be empty", census);
        }

        const restoreStatus = restorationStatus(agent.status);
        const updated = await tx
          .update(agents)
          .set({
            status: "paused",
            pauseReason: "system",
            pausedAt: acquiredAt,
            executionFenceId: fenceId,
            executionFencePriorStatus: agent.status,
            executionFencePriorPauseReason: agent.pauseReason,
            executionFencePriorPausedAt: agent.pausedAt,
            executionFenceRestoreStatus: restoreStatus,
            executionFenceReason: reason,
            executionFenceActorUserId: input.actorUserId,
            executionFenceAcquiredAt: acquiredAt,
            updatedAt: acquiredAt,
          })
          .where(and(eq(agents.id, agent.id), isNull(agents.executionFenceId)))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) throw conflict("Execution fence acquisition lost its compare-and-set race");

        const after = await readFenceCensus(tx, agent.id);
        const result = {
          fenceId,
          agentId: agent.id,
          companyId: agent.companyId,
          priorStatus: agent.status,
          restoreStatus,
          acquiredAt,
          reason,
          ...after,
        };
        await logActivity(tx as unknown as Db, {
          companyId: agent.companyId,
          actorType: "user",
          actorId: input.actorUserId ?? "board",
          action: "agent.execution_fence_acquired",
          entityType: "agent",
          entityId: agent.id,
          details: {
            fenceId,
            priorStatus: agent.status,
            restoreStatus,
            reason,
          },
        });
        return result;
      });
      return result;
    },

    get: async (agentId: string, fenceId: string) =>
      db.transaction(async (tx) => {
        const agent = await getLockedAgent(tx, agentId);
        if (!agent) throw notFound("Agent not found");
        if (!agent.executionFenceId || agent.executionFenceId !== fenceId || !agent.executionFenceAcquiredAt) {
          throw conflict("Execution fence is not active for this agent", {
            requestedFenceId: fenceId,
            activeFenceId: agent.executionFenceId,
          });
        }
        return {
          fenceId,
          agentId: agent.id,
          companyId: agent.companyId,
          priorStatus: agent.executionFencePriorStatus,
          priorPauseReason: agent.executionFencePriorPauseReason,
          priorPausedAt: agent.executionFencePriorPausedAt,
          restoreStatus: agent.executionFenceRestoreStatus,
          acquiredAt: agent.executionFenceAcquiredAt,
          reason: agent.executionFenceReason,
          ...(await readFenceCensus(tx, agent.id)),
        };
      }),

    authorizeClaimedRunStart: async (agentId: string, runId: string) =>
      db.transaction(async (tx) => {
        const agent = await getLockedAgent(tx, agentId);
        if (!agent) return null;

        if (agent.executionFenceId) {
          const claimedBeforeFence = await tx
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.id, runId),
                eq(heartbeatRuns.agentId, agentId),
                eq(heartbeatRuns.status, "running"),
                isNotNull(heartbeatRuns.startedAt),
                isNull(heartbeatRuns.executionFinalizedAt),
              ),
            )
            .then((rows) => rows[0] ?? null);
          return claimedBeforeFence ? agent : null;
        }

        return tx
          .update(agents)
          .set({ status: "running", updatedAt: new Date() })
          .where(
            and(
              eq(agents.id, agentId),
              isNull(agents.executionFenceId),
              notInArray(agents.status, ["paused", "terminated", "pending_approval"]),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
      }),

    acknowledgeRunFinalization: async (runId: string) =>
      db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current) throw notFound("Heartbeat run not found");
        if (current.executionFinalizedAt) return current;
        if (UNFINALIZED_RUN_STATUSES.includes(current.status as (typeof UNFINALIZED_RUN_STATUSES)[number])) {
          throw conflict("Cannot acknowledge finalization before the run is terminal", {
            runId,
            status: current.status,
          });
        }

        if (current.wakeupRequestId) {
          const wakeup = await tx
            .select({
              id: agentWakeupRequests.id,
              agentId: agentWakeupRequests.agentId,
              runId: agentWakeupRequests.runId,
              status: agentWakeupRequests.status,
            })
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, current.wakeupRequestId))
            .for("update")
            .then((rows) => rows[0] ?? null);
          const expectedWakeupStatus = current.status === "succeeded" ? "completed" : current.status;
          if (
            !wakeup ||
            wakeup.agentId !== current.agentId ||
            wakeup.runId !== current.id ||
            wakeup.status !== expectedWakeupStatus
          ) {
            throw conflict("Cannot acknowledge finalization before the linked wakeup is finalized", {
              runId,
              wakeupRequestId: current.wakeupRequestId,
              expectedWakeupStatus,
              actualWakeupStatus: wakeup?.status ?? null,
            });
          }
        }

        const now = new Date();
        return tx
          .update(heartbeatRuns)
          .set({ executionFinalizedAt: now, updatedAt: now })
          .where(and(eq(heartbeatRuns.id, runId), isNull(heartbeatRuns.executionFinalizedAt)))
          .returning()
          .then((rows) => {
            const updated = rows[0];
            if (!updated) throw conflict("Run finalization acknowledgement lost its compare-and-set race");
            return updated;
          });
      }),

    release: async (
      agentId: string,
      fenceId: string,
      input: { actorUserId: string | null } = { actorUserId: null },
    ) => {
      const result = await db.transaction(async (tx) => {
        const agent = await getLockedAgent(tx, agentId);
        if (!agent) throw notFound("Agent not found");
        if (!agent.executionFenceId || agent.executionFenceId !== fenceId || !agent.executionFenceAcquiredAt) {
          throw conflict("Execution fence token does not match the active fence", {
            requestedFenceId: fenceId,
            activeFenceId: agent.executionFenceId,
          });
        }

        const census = await readFenceCensus(tx, agent.id);
        if (!census.drained) {
          throw conflict("Execution fence cannot be released before the agent is drained", census);
        }

        const status = agent.executionFenceRestoreStatus ?? "idle";
        const updated = await tx
          .update(agents)
          .set({
            status,
            pauseReason: status === "paused" ? agent.executionFencePriorPauseReason : null,
            pausedAt: status === "paused" ? agent.executionFencePriorPausedAt : null,
            executionFenceId: null,
            executionFencePriorStatus: null,
            executionFencePriorPauseReason: null,
            executionFencePriorPausedAt: null,
            executionFenceRestoreStatus: null,
            executionFenceReason: null,
            executionFenceActorUserId: null,
            executionFenceAcquiredAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(agents.id, agent.id), eq(agents.executionFenceId, fenceId)))
          .returning()
          .then((rows) => {
            const updated = rows[0];
            if (!updated) throw conflict("Execution fence release lost its compare-and-set race");
            return updated;
          });
        await logActivity(tx as unknown as Db, {
          companyId: agent.companyId,
          actorType: "user",
          actorId: input.actorUserId ?? "board",
          action: "agent.execution_fence_released",
          entityType: "agent",
          entityId: agent.id,
          details: {
            fenceId,
            restoredStatus: updated.status,
          },
        });
        return updated;
      });
      return result;
    },
  };
}
