/**
 * Track 3: Capability drift detection.
 *
 * After a run completes, scan heartbeat_run_events for tool_use events and bash
 * curl commands, compare against the agent's declared capabilities, and write
 * mismatches to agent_capability_drift.
 */

import { and, eq, gte, desc, isNotNull, count } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns, agents as agentsTable, agentCapabilityDrift } from "@paperclipai/db";
import { parseCapabilities } from "@paperclipai/shared";
import type { Logger } from "pino";

const DRIFT_LOOKBACK_HOURS = 24;

/** Extract tool names and file targets from a run's events. */
function extractToolsUsed(events: Array<{ eventType: string; payload: Record<string, unknown> | null | undefined }>): Array<{ tool: string; target: string }> {
  const results: Array<{ tool: string; target: string }> = [];
  for (const event of events) {
    if (!event.payload) continue;
    const payload = event.payload;

    // Claude-style tool_use events
    if (event.eventType === "tool_use" || payload.type === "tool_use") {
      const toolName = (payload.name as string | undefined) ?? (payload.tool as string | undefined);
      if (toolName) {
        const input = (payload.input as Record<string, unknown> | undefined) ?? {};
        // For file tools, extract path
        const target = (input.file_path as string | undefined) ?? (input.path as string | undefined) ?? "*";
        results.push({ tool: toolName, target });

        // For bash tool, also extract curl endpoints
        if (toolName === "Bash" || toolName === "bash") {
          const command = (input.command as string | undefined) ?? "";
          extractCurlEndpoints(command).forEach((ep) => results.push({ tool: "curl", target: ep }));
        }
      }
    }

    // Text events may contain bash output with curl calls
    if (event.eventType === "assistant_message" || event.eventType === "text") {
      const text = (payload.text as string | undefined) ?? (payload.content as string | undefined) ?? "";
      extractCurlEndpoints(text).forEach((ep) => results.push({ tool: "curl", target: ep }));
    }
  }
  return results;
}

function extractCurlEndpoints(text: string): string[] {
  const results: string[] = [];
  const curlRegex = /curl\s+(?:-[^\s]+\s+)*['"]?(https?:\/\/[^\s'"]+)/g;
  let match;
  while ((match = curlRegex.exec(text)) !== null) {
    if (match[1]) results.push(match[1]);
  }
  return results;
}

/** Map tool names to capability category. */
function toolToCapabilityCategory(tool: string): "reads" | "writes" | null {
  const readTools = ["Read", "Grep", "Glob", "cat", "head", "tail", "WebFetch", "WebSearch"];
  const writeTools = ["Write", "Edit", "NotebookEdit"];
  if (readTools.includes(tool)) return "reads";
  if (writeTools.includes(tool)) return "writes";
  return null;
}

export function createCapabilityDriftService(db: Db, logger: Logger) {
  /**
   * Analyse a single completed run and write drift records for any
   * USED_UNDECLARED tool/target pairs.
   */
  async function analyseRun(runId: string): Promise<{ inserted: number }> {
    const run = await db.query.heartbeatRuns
      .findFirst({ where: eq(heartbeatRuns.id, runId) });
    if (!run) return { inserted: 0 };

    const agent = await db.query.agents
      .findFirst({ where: eq(agentsTable.id, run.agentId) });
    if (!agent?.capabilities) return { inserted: 0 };

    const caps = parseCapabilities(agent.capabilities);
    if (!caps) return { inserted: 0 };

    const events = await db
      .select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));

    const toolsUsed = extractToolsUsed(events);
    const declaredEndpoints = new Set([
      ...(caps.reads.api_endpoints ?? []),
      ...(caps.writes.api_endpoints ?? []),
    ]);
    const declaredFiles = new Set([
      ...(caps.reads.shared_files ?? []),
      ...(caps.writes.shared_files ?? []),
    ]);

    const driftRows: Array<typeof agentCapabilityDrift.$inferInsert> = [];
    for (const { tool, target } of toolsUsed) {
      if (tool === "curl") {
        const matched = [...declaredEndpoints].some((ep) => target.startsWith(ep) || ep.startsWith(target));
        if (!matched) {
          driftRows.push({
            companyId: run.companyId,
            agentId: run.agentId,
            runId: run.id,
            driftType: "USED_UNDECLARED",
            tool: "curl",
            target,
          });
        }
      } else if (tool === "Read" || tool === "Write" || tool === "Edit") {
        const matched = [...declaredFiles].some((f) => target.includes(f) || f.includes(target));
        if (!matched && target !== "*") {
          driftRows.push({
            companyId: run.companyId,
            agentId: run.agentId,
            runId: run.id,
            driftType: "USED_UNDECLARED",
            tool,
            target,
          });
        }
      }
    }

    if (driftRows.length === 0) return { inserted: 0 };
    await db.insert(agentCapabilityDrift).values(driftRows);
    return { inserted: driftRows.length };
  }

  /**
   * Sweep all runs completed in the last 24h that have not yet been analysed.
   * Called from the daily job tick.
   */
  async function sweepRecentRuns(): Promise<{ runs: number; driftRecords: number }> {
    const since = new Date(Date.now() - DRIFT_LOOKBACK_HOURS * 60 * 60 * 1000);
    const recentRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.status, "done"),
          gte(heartbeatRuns.finishedAt, since),
          isNotNull(heartbeatRuns.agentId),
        ),
      )
      .limit(500);

    let totalDrift = 0;
    for (const run of recentRuns) {
      try {
        const { inserted } = await analyseRun(run.id);
        totalDrift += inserted;
      } catch (err) {
        logger.warn({ err, runId: run.id }, "capability drift analysis failed for run");
      }
    }
    return { runs: recentRuns.length, driftRecords: totalDrift };
  }

  return { analyseRun, sweepRecentRuns };
}

export type CapabilityDriftService = ReturnType<typeof createCapabilityDriftService>;
