/**
 * Track 7: Capability coverage observability (silent-non-running detection).
 *
 * Daily sweep that checks each agent's declared triggers against actual run
 * history. Findings are written to agent_coverage_gaps.
 */

import { and, eq, gte, isNull, or, ne, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents as agentsTable, agentCoverageGaps, heartbeatRuns, issues as issuesTable } from "@paperclipai/db";
import { parseCapabilities } from "@paperclipai/shared";
import type { Logger } from "pino";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function createCapabilityCoverageService(db: Db, logger: Logger) {
  async function getLastRunAt(agentId: string): Promise<Date | null> {
    const row = await db
      .select({ finishedAt: heartbeatRuns.finishedAt })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "done")))
      .orderBy(desc(heartbeatRuns.finishedAt))
      .limit(1)
      .then((r) => r[0] ?? null);
    return row?.finishedAt ?? null;
  }

  async function upsertGap(
    companyId: string,
    agentId: string,
    gapType: string,
    detail: string,
  ): Promise<void> {
    const existing = await db.query.agentCoverageGaps?.findFirst?.({
      where: and(
        eq(agentCoverageGaps.agentId, agentId),
        eq(agentCoverageGaps.gapType, gapType),
        isNull(agentCoverageGaps.resolvedAt),
      ),
    });
    if (existing) {
      await db
        .update(agentCoverageGaps)
        .set({ lastFlaggedAt: new Date(), detail })
        .where(eq(agentCoverageGaps.id, existing.id));
    } else {
      await db.insert(agentCoverageGaps).values({ companyId, agentId, gapType, detail });
    }
  }

  async function resolveGap(agentId: string, gapType: string): Promise<void> {
    await db
      .update(agentCoverageGaps)
      .set({ resolvedAt: new Date() })
      .where(
        and(
          eq(agentCoverageGaps.agentId, agentId),
          eq(agentCoverageGaps.gapType, gapType),
          isNull(agentCoverageGaps.resolvedAt),
        ),
      );
  }

  /**
   * Sweep all agents with declared triggers and flag coverage gaps.
   */
  async function sweepAgents(): Promise<{ checked: number; gaps: number }> {
    const allAgents = await db
      .select({
        id: agentsTable.id,
        companyId: agentsTable.companyId,
        name: agentsTable.name,
        capabilities: agentsTable.capabilities,
        status: agentsTable.status,
      })
      .from(agentsTable)
      .where(ne(agentsTable.status, "deleted" as string));

    let gaps = 0;
    const now = new Date();

    for (const agent of allAgents) {
      if (!agent.capabilities) continue;
      const caps = parseCapabilities(agent.capabilities);
      if (!caps?.triggers) continue;

      const triggers = caps.triggers;
      const lastRunAt = await getLastRunAt(agent.id);
      const silentMs = lastRunAt ? now.getTime() - lastRunAt.getTime() : Infinity;

      // SILENT_HEARTBEAT: has declared interval but hasn't run in 3× the interval
      if (triggers.heartbeat_interval_seconds) {
        const maxSilenceMs = triggers.heartbeat_interval_seconds * 3 * 1000;
        if (silentMs > maxSilenceMs) {
          await upsertGap(
            agent.companyId,
            agent.id,
            "SILENT_HEARTBEAT",
            `Agent '${agent.name}' has not run in ${Math.round(silentMs / 60000)}m (expected every ${triggers.heartbeat_interval_seconds}s, max silence = 3× interval)`,
          );
          gaps++;
        } else {
          await resolveGap(agent.id, "SILENT_HEARTBEAT");
        }
      }

      // SILENT_ASSIGNED: wake_on_assignment=true but todo issues assigned and no run since assignment
      if (triggers.wake_on_assignment) {
        const todoIssues = await db
          .select({ updatedAt: issuesTable.updatedAt })
          .from(issuesTable)
          .where(
            and(
              eq(issuesTable.assigneeAgentId, agent.id),
              eq(issuesTable.status, "todo"),
            ),
          )
          .limit(1);
        if (todoIssues.length > 0) {
          const oldestAssigned = todoIssues[0]!.updatedAt ?? now;
          const idleMs = now.getTime() - oldestAssigned.getTime();
          const gracePeriodMs = (triggers.heartbeat_interval_seconds ?? 3600) * 3 * 1000;
          if (idleMs > gracePeriodMs) {
            await upsertGap(
              agent.companyId,
              agent.id,
              "SILENT_ASSIGNED",
              `Agent '${agent.name}' has assigned todo issues but no run since ${new Date(oldestAssigned).toISOString()}`,
            );
            gaps++;
          } else {
            await resolveGap(agent.id, "SILENT_ASSIGNED");
          }
        } else {
          await resolveGap(agent.id, "SILENT_ASSIGNED");
        }
      }

      // Flag any agent silent for >7d while declared active
      if (silentMs > SEVEN_DAYS_MS && agent.status === "idle") {
        const hasTrigger =
          triggers.heartbeat_interval_seconds ||
          triggers.wake_on_assignment ||
          (triggers.sqs_message_types?.length ?? 0) > 0;
        if (hasTrigger) {
          await upsertGap(
            agent.companyId,
            agent.id,
            "SILENT_7D",
            `Agent '${agent.name}' has not run in >7 days while declared active`,
          );
          gaps++;
        }
      } else {
        await resolveGap(agent.id, "SILENT_7D");
      }
    }

    return { checked: allAgents.length, gaps };
  }

  return { sweepAgents };
}

export type CapabilityCoverageService = ReturnType<typeof createCapabilityCoverageService>;
