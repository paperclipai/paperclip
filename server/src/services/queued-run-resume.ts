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
  opts?: { concurrency?: number; timeoutMs?: number },
): Promise<QueuedRunResumeResult> {
  const timeoutMs = Math.max(1, Math.floor(opts?.timeoutMs ?? 30_000));
  const uniqueAgentIds = [...new Set(agentIds)];
  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? 5));
  const workerCount = Math.min(concurrency, uniqueAgentIds.length);
  const results: Array<
    | { kind: "completed"; agentId: string; started: number }
    | { kind: "failed"; agentId: string; started: 0; err: unknown }
    | { kind: "timed_out"; agentId: string; started: 0 }
  > = [];
  let nextIndex = 0;

  async function resumeAgent(agentId: string) {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const started = startQueuedRunsForAgent(agentId)
      .then((runs) => ({ kind: "completed" as const, agentId, started: runs.length }))
      .catch((err: unknown) => ({ kind: "failed" as const, agentId, started: 0 as const, err }));

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
  }

  async function worker() {
    while (nextIndex < uniqueAgentIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const agentId = uniqueAgentIds[index];
      if (!agentId) continue;
      results[index] = await resumeAgent(agentId);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    checked: uniqueAgentIds.length,
    started: results.reduce((sum, result) => sum + result.started, 0),
    timedOut: results.filter((result) => result.kind === "timed_out").length,
    failed: results.filter((result) => result.kind === "failed").length,
    timedOutAgentIds: results.filter((result) => result.kind === "timed_out").map((result) => result.agentId),
    failedAgentIds: results.filter((result) => result.kind === "failed").map((result) => result.agentId),
  };
}
