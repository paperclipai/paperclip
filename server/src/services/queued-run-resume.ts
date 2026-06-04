import { logger } from "../middleware/logger.js";

export interface QueuedRunResumeResult {
  checked: number;
  started: number;
  timedOut: number;
  failed: number;
  timedOutAgentIds: string[];
  failedAgentIds: string[];
}

export async function resumeQueuedAgentsWithTimeout<TStarted extends readonly unknown[]>(
  agentIds: string[],
  startQueuedRunsForAgent: (agentId: string) => Promise<TStarted>,
  opts?: { timeoutMs?: number },
): Promise<QueuedRunResumeResult> {
  const timeoutMs = Math.max(1, Math.floor(opts?.timeoutMs ?? 30_000));
  const uniqueAgentIds = [...new Set(agentIds)];
  const results = await Promise.all(
    uniqueAgentIds.map(async (agentId) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const started = startQueuedRunsForAgent(agentId)
        .then((runs) => ({ kind: "completed" as const, agentId, started: runs.length }))
        .catch((err: unknown) => ({ kind: "failed" as const, agentId, started: 0, err }));

      const timed = new Promise<{ kind: "timed_out"; agentId: string; started: 0 }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timed_out", agentId, started: 0 }), timeoutMs);
      });

      const result = await Promise.race([started, timed]);
      if (timeout) clearTimeout(timeout);
      if (result.kind === "timed_out") {
        logger.warn({ agentId, timeoutMs }, "queued-run resume timed out for agent; continuing other agents");
      } else if (result.kind === "failed") {
        logger.warn({ err: result.err, agentId }, "queued-run resume failed for agent; continuing other agents");
      }
      return result;
    }),
  );

  return {
    checked: uniqueAgentIds.length,
    started: results.reduce((sum, result) => sum + result.started, 0),
    timedOut: results.filter((result) => result.kind === "timed_out").length,
    failed: results.filter((result) => result.kind === "failed").length,
    timedOutAgentIds: results.filter((result) => result.kind === "timed_out").map((result) => result.agentId),
    failedAgentIds: results.filter((result) => result.kind === "failed").map((result) => result.agentId),
  };
}
