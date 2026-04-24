import { and, asc, count, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./index.js";

/**
 * Default minimum number of `todo` issues each healthy agent lane should have.
 * Configurable via READY_QUEUE_MIN_PER_LANE environment variable.
 */
const DEFAULT_MIN_TODO_PER_LANE = 2;

/**
 * Maximum number of backlog items to promote per agent per governance tick.
 * Prevents unbounded promotion on a single sweep.
 */
const MAX_PROMOTIONS_PER_AGENT_PER_TICK = 5;

/**
 * Maximum number of todo issues to deprioritize (move to backlog) per tick
 * across all unhealthy agent lanes. Caps fan-out in degraded states where
 * many lanes are in `error` with accumulated work.
 */
const MAX_DEPRIORITIZATIONS_PER_TICK = 100;

/**
 * Agent statuses that are considered "healthy" / eligible for queue governance.
 * Agents that are paused, terminated, or pending approval are excluded.
 */
const HEALTHY_AGENT_STATUSES = ["idle", "running"];

/**
 * Agent statuses that indicate an unhealthy lane.
 * Issues assigned to agents in these statuses should be deprioritized (moved to backlog)
 * to prevent misleading queue counts and avoid routing work to a lane that cannot execute.
 */
const UNHEALTHY_AGENT_STATUSES = ["error"];

/**
 * Issue statuses that count toward the "ready queue" for an agent.
 */
const READY_QUEUE_STATUSES = ["todo"];

/**
 * Issue statuses eligible for promotion from backlog.
 */
const PROMOTABLE_STATUSES = ["backlog"];

/**
 * Priority ordering for backlog promotion. Lower index = higher priority.
 */
const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function parseMinTodoPerLane(): number {
  const env = process.env.READY_QUEUE_MIN_PER_LANE;
  if (!env) return DEFAULT_MIN_TODO_PER_LANE;
  const parsed = Math.floor(Number(env));
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MIN_TODO_PER_LANE;
  return parsed;
}

function priorityRank(priority: string | null): number {
  return PRIORITY_ORDER[priority ?? "medium"] ?? PRIORITY_ORDER.medium;
}

export interface GovernanceTickResult {
  /** Number of agents checked. */
  agentsChecked: number;
  /** Number of agents that had below-minimum ready queues. */
  agentsBelowMinimum: number;
  /** Total number of backlog issues promoted to todo. */
  issuesPromoted: number;
  /** Per-agent breakdown. */
  details: Array<{
    agentId: string;
    agentName: string;
    todoCount: number;
    deficit: number;
    promoted: number;
  }>;
  /** Number of unhealthy lanes that had todo issues deprioritized. */
  unhealthyLanesDeprioritized: number;
  /** Total number of todo issues moved to backlog from unhealthy lanes. */
  issuesDeprioritized: number;
  /** Per-agent breakdown of deprioritization. */
  deprioritizationDetails: Array<{
    agentId: string;
    agentName: string;
    agentStatus: string;
    issuesMovedToBacklog: number;
  }>;
}

export function readyQueueGovernanceService(
  db: Db,
  deps: { heartbeat: IssueAssignmentWakeupDeps },
) {
  const minTodoPerLane = parseMinTodoPerLane();

  /**
   * Run a single governance tick: check every healthy agent lane and promote
   * backlog items when the ready queue drops below the minimum threshold.
   */
  async function tick(): Promise<GovernanceTickResult> {
    const result: GovernanceTickResult = {
      agentsChecked: 0,
      agentsBelowMinimum: 0,
      issuesPromoted: 0,
      details: [],
      unhealthyLanesDeprioritized: 0,
      issuesDeprioritized: 0,
      deprioritizationDetails: [],
    };

    // ── Phase 1: Deprioritize unhealthy lanes ──────────────────────────
    // Move todo issues assigned to unhealthy agents to backlog so the board
    // doesn't suggest work is ready when it cannot be picked up.

    const unhealthyAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        companyId: agents.companyId,
        status: agents.status,
        adapterType: agents.adapterType,
      })
      .from(agents)
      .where(
        and(
          isNotNull(agents.adapterType),
          inArray(agents.status, UNHEALTHY_AGENT_STATUSES),
        ),
      );

    if (unhealthyAgents.length > 0) {
      const unhealthyAgentIds = unhealthyAgents.map((a) => a.id);

      // Find todo issues assigned to unhealthy agents, capped per tick to
      // bound work in degraded states. Order by oldest first so long-standing
      // stuck items drain ahead of newer ones.
      const todoOnUnhealthy = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          title: issues.title,
        })
        .from(issues)
        .where(
          and(
            isNotNull(issues.assigneeAgentId),
            inArray(issues.assigneeAgentId, unhealthyAgentIds),
            inArray(issues.status, READY_QUEUE_STATUSES),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(asc(issues.createdAt))
        .limit(MAX_DEPRIORITIZATIONS_PER_TICK);

      if (todoOnUnhealthy.length > 0) {
        const agentLookup = new Map(unhealthyAgents.map((a) => [a.id, a]));
        const movedByAgent = new Map<string, number>();

        // Batch the status transition into a single UPDATE ... WHERE id IN (...)
        // instead of N serial round-trips. The `status = 'todo'` guard preserves
        // the original race-safety: if a row already moved out of todo between
        // select and update, it is not re-mutated.
        const candidateIds = todoOnUnhealthy.map((i) => i.id);
        let updatedRows: Array<{ id: string; assigneeAgentId: string | null }> = [];
        try {
          updatedRows = await db
            .update(issues)
            .set({
              status: "backlog",
              updatedAt: new Date(),
            })
            .where(
              and(
                inArray(issues.id, candidateIds),
                eq(issues.status, "todo"),
              ),
            )
            .returning({ id: issues.id, assigneeAgentId: issues.assigneeAgentId });
        } catch (err) {
          logger.warn(
            { err, candidateCount: candidateIds.length },
            "ready-queue-governance: failed to deprioritize unhealthy-lane issues",
          );
        }

        for (const row of updatedRows) {
          const agentId = row.assigneeAgentId;
          if (!agentId) continue;
          movedByAgent.set(agentId, (movedByAgent.get(agentId) ?? 0) + 1);
        }

        for (const [agentId, moved] of movedByAgent) {
          const agent = agentLookup.get(agentId)!;
          result.unhealthyLanesDeprioritized += 1;
          result.issuesDeprioritized += moved;
          result.deprioritizationDetails.push({
            agentId,
            agentName: agent.name,
            agentStatus: agent.status,
            issuesMovedToBacklog: moved,
          });
          logger.info(
            {
              agentId,
              agentName: agent.name,
              agentStatus: agent.status,
              issuesMovedToBacklog: moved,
            },
            "ready-queue-governance: deprioritized unhealthy-lane todo issues to backlog",
          );
        }

        if (result.issuesDeprioritized > 0) {
          logger.info(
            {
              unhealthyLanes: result.unhealthyLanesDeprioritized,
              issuesDeprioritized: result.issuesDeprioritized,
            },
            "ready-queue-governance: unhealthy-lane deprioritization complete",
          );
        }
      }
    }

    // Find all healthy agents with an adapter (i.e. agents that can execute work).
    const healthyAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        companyId: agents.companyId,
        status: agents.status,
        adapterType: agents.adapterType,
      })
      .from(agents)
      .where(
        and(
          isNotNull(agents.adapterType),
          inArray(agents.status, HEALTHY_AGENT_STATUSES),
        ),
      );

    result.agentsChecked = healthyAgents.length;

    if (healthyAgents.length === 0) {
      return result;
    }

    // Count todo issues per agent.
    const agentIds = healthyAgents.map((a) => a.id);

    const todoCounts = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        count: count(),
      })
      .from(issues)
      .where(
        and(
          isNotNull(issues.assigneeAgentId),
          inArray(issues.assigneeAgentId, agentIds),
          inArray(issues.status, READY_QUEUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .groupBy(issues.assigneeAgentId);

    const todoCountByAgent = new Map<string, number>();
    for (const row of todoCounts) {
      if (row.assigneeAgentId) {
        todoCountByAgent.set(row.assigneeAgentId, row.count);
      }
    }

    // Check each agent and promote if needed.
    for (const agent of healthyAgents) {
      const currentTodo = todoCountByAgent.get(agent.id) ?? 0;

      if (currentTodo >= minTodoPerLane) {
        continue;
      }

      const deficit = minTodoPerLane - currentTodo;
      const promoteLimit = Math.min(deficit, MAX_PROMOTIONS_PER_AGENT_PER_TICK);

      // Find backlog items for this agent, ordered by priority (highest first),
      // then by creation date (oldest first).
      const backlogCandidates = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          title: issues.title,
        })
        .from(issues)
        .where(
          and(
            eq(issues.assigneeAgentId, agent.id),
            inArray(issues.status, PROMOTABLE_STATUSES),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(
          // Promote higher-priority items first, then older items.
          sql`CASE ${issues.priority}
            WHEN 'critical' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            ELSE 2
          END`,
          asc(issues.createdAt),
        )
        .limit(promoteLimit);

      let promoted = 0;

      for (const candidate of backlogCandidates) {
        try {
          const [updated] = await db
            .update(issues)
            .set({
              status: "todo",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(issues.id, candidate.id),
                eq(issues.status, "backlog"),
              ),
            )
            .returning({ id: issues.id, status: issues.status });

          if (!updated) continue;

          promoted += 1;

          // Wake the agent about the newly-promoted issue.
          void queueIssueAssignmentWakeup({
            heartbeat: deps.heartbeat,
            issue: {
              id: candidate.id,
              assigneeAgentId: agent.id,
              status: "todo",
            },
            reason: "ready_queue_governance_promotion",
            mutation: "governance_promote",
            contextSource: "ready_queue_governance",
            requestedByActorType: "system",
            requestedByActorId: "ready_queue_governance",
          });
        } catch (err) {
          logger.warn(
            { err, issueId: candidate.id, agentId: agent.id },
            "ready-queue-governance: failed to promote backlog issue",
          );
        }
      }

      result.agentsBelowMinimum += 1;
      result.issuesPromoted += promoted;
      result.details.push({
        agentId: agent.id,
        agentName: agent.name,
        todoCount: currentTodo,
        deficit,
        promoted,
      });

      if (promoted > 0) {
        logger.info(
          {
            agentId: agent.id,
            agentName: agent.name,
            todoBefore: currentTodo,
            promoted,
            todoAfter: currentTodo + promoted,
            minimum: minTodoPerLane,
          },
          "ready-queue-governance: promoted backlog issues to todo",
        );
      }
    }

    if (result.agentsBelowMinimum > 0) {
      logger.info(
        {
          agentsChecked: result.agentsChecked,
          agentsBelowMinimum: result.agentsBelowMinimum,
          issuesPromoted: result.issuesPromoted,
          minTodoPerLane,
        },
        "ready-queue-governance: tick complete",
      );
    }

    return result;
  }

  return { tick };
}
