import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { trackAgentTaskRun } from "@paperclipai/shared/telemetry";
import { parseObject } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readUsageToken(
  source: Record<string, unknown>,
  ...keys: string[]
): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
  }
  return 0;
}

function resolveDurationSeconds(
  run: HeartbeatRun,
  now: Date,
): number | undefined {
  if (!run.startedAt) return undefined;
  const startedAtMs = new Date(run.startedAt).getTime();
  const endMs = run.finishedAt ? new Date(run.finishedAt).getTime() : now.getTime();
  return Math.max(0, Math.round((endMs - startedAtMs) / 1000));
}

/**
 * Emits one `agent.task_run` telemetry event for a run that a caller already
 * wrote to a terminal status. The native runtime and the legacy run engine
 * both call this function beside each terminal status write. Call this
 * function after the run commits.
 *
 * This function never throws. A telemetry failure must never fail a run.
 * Telemetry enrichment does an awaited database lookup, so treat this call
 * as best-effort background work: do not let a caller's own required
 * lifecycle work (publishing a live event, cancelling a wake, clearing an
 * issue lock, returning a response) wait behind it. Fire this call with
 * `void emitAgentTaskRun(...)` and never await it, even alongside other
 * required work with `Promise.all` — an awaited `Promise.all` still blocks
 * the caller's return on the slower of the two promises, so it does not
 * remove the delay.
 */
export async function emitAgentTaskRun(db: Db, run: HeartbeatRun): Promise<void> {
  try {
    const client = getTelemetryClient();
    if (!client) return;

    const agent = await db
      .select({
        role: agents.role,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.id, run.agentId))
      .then((rows) => rows[0] ?? null);

    const usage = parseObject(run.usageJson);
    const model =
      readNonEmptyString(usage.model) ??
      readNonEmptyString(parseObject(agent?.adapterConfig).model) ??
      undefined;

    const taskId =
      readNonEmptyString(parseObject(run.contextSnapshot).issueId) ??
      undefined;

    trackAgentTaskRun(client, {
      agentId: run.agentId,
      state: run.status,
      ...(agent
        ? { adapterType: agent.adapterType, agentRole: agent.role }
        : {}),
      ...(model ? { model } : {}),
      ...(() => {
        const durationSeconds = resolveDurationSeconds(run, new Date());
        return durationSeconds === undefined ? {} : { durationSeconds };
      })(),
      ...(run.usageJson != null
        ? {
            inputTokens: readUsageToken(
              usage,
              "inputTokens",
              "input_tokens",
              "rawInputTokens",
              "raw_input_tokens",
            ),
            outputTokens: readUsageToken(
              usage,
              "outputTokens",
              "output_tokens",
              "rawOutputTokens",
              "raw_output_tokens",
            ),
            cachedTokens: readUsageToken(
              usage,
              "cachedInputTokens",
              "cached_input_tokens",
              "cacheReadInputTokens",
              "cache_read_input_tokens",
            ),
          }
        : {}),
      ...(taskId ? { taskId } : {}),
    });
  } catch (err) {
    logger.warn(
      { err, runId: run.id },
      "failed to emit agent.task_run telemetry",
    );
  }
}
