import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { fetchCursorCloudRun } from "./cursor-cloud-api.js";
import { logger } from "../middleware/logger.js";

const ORPHAN_RUNNING_THRESHOLD_MS = 5 * 60 * 1000;

function readCursorApiKey(adapterConfig: unknown): string | null {
  if (typeof adapterConfig !== "object" || adapterConfig === null) return null;
  const env = (adapterConfig as { env?: Record<string, unknown> }).env;
  if (!env || typeof env !== "object") return null;
  const entry = env.CURSOR_API_KEY;
  if (typeof entry === "string" && entry.trim()) return entry.trim();
  if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
    const rec = entry as { type?: string; value?: string };
    if (rec.type === "plain" && typeof rec.value === "string" && rec.value.trim()) {
      return rec.value.trim();
    }
  }
  return null;
}

export async function observeOrphanCursorCloudRuns(db: Db, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const threshold = new Date(now.getTime() - ORPHAN_RUNNING_THRESHOLD_MS);
  const rows = await db
    .select({
      run: heartbeatRuns,
      agent: agents,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        eq(agents.adapterType, "cursor_cloud"),
        lt(heartbeatRuns.startedAt, threshold),
        isNull(heartbeatRuns.externalRunId),
      ),
    )
    .limit(20);

  let observed = 0;
  for (const { run, agent } of rows) {
    const resultJson = run.resultJson as Record<string, unknown> | null;
    const cursorAgentId =
      (typeof resultJson?.cursorAgentId === "string" ? resultJson.cursorAgentId : null)
      ?? run.sessionIdAfter;
    const cursorRunId =
      typeof resultJson?.cursorRunId === "string" ? resultJson.cursorRunId : run.externalRunId;
    if (!cursorAgentId || !cursorRunId) continue;
    const apiKey = readCursorApiKey(agent.adapterConfig);
    if (!apiKey) continue;
    const snapshot = await fetchCursorCloudRun({
      apiKey,
      agentId: cursorAgentId,
      runId: cursorRunId,
    });
    if (!snapshot) continue;
    observed += 1;
    if (snapshot.status !== "running") {
      logger.info(
        { runId: run.id, cursorRunId, cursorStatus: snapshot.status },
        "cursor run observer detected terminal remote run while heartbeat still running",
      );
    }
    await db
      .update(heartbeatRuns)
      .set({
        externalRunId: cursorRunId,
        updatedAt: now,
      })
      .where(eq(heartbeatRuns.id, run.id));
  }
  return { observed };
}
