import { Router } from "express";
import { z } from "zod";
import { and, gte, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { previewAgentRuntimeRestore, restoreAgentRuntimeFromS3 } from "../services/index.js";
import { assertBoard } from "./authz.js";

const metricsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).default(7),
});

const restoreBodySchema = z.object({
  strategy: z.enum(["missing_only", "overwrite_all", "selected"]).default("missing_only"),
  selectedKeys: z.array(z.string()).optional(),
});

async function getNoiseMetrics(db: Db, windowDays: number) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // All finished runs in the window
  const rows = await db
    .select({
      invocationSource: heartbeatRuns.invocationSource,
      status: heartbeatRuns.status,
      stderrExcerpt: heartbeatRuns.stderrExcerpt,
      sessionIdBefore: heartbeatRuns.sessionIdBefore,
      // Pull input token count from usageJson (Claude: input_tokens, OpenAI: prompt_tokens)
      inputTokens: sql<number>`
        COALESCE(
          (${heartbeatRuns.usageJson}->>'input_tokens')::int,
          (${heartbeatRuns.usageJson}->>'prompt_tokens')::int,
          0
        )
      `.as("input_tokens"),
    })
    .from(heartbeatRuns)
    .where(
      and(
        gte(heartbeatRuns.createdAt, since),
        isNotNull(heartbeatRuns.finishedAt),
      ),
    );

  const total = rows.length;
  if (total === 0) {
    return {
      windowDays,
      totalFinishedRuns: 0,
      timerWakes: { total: 0, skippedPct: null },
      stderrNoise: { runsWithBenignOnlyStderr: 0, runsWithBenignOnlyStderrPct: null },
      sessionResume: { bySource: {} },
      inputTokens: { medianTimerWake: null, medianIssuWake: null },
    };
  }

  // 1. Timer wakes with no issue context — proxy: status="skipped" or invocationSource="timer"
  const timerRows = rows.filter((r) => r.invocationSource === "timer");
  const skippedRows = rows.filter((r) => r.status === "skipped");

  // 2. Runs with benign-only stderr (stderrExcerpt present but only noise patterns)
  // We use the stored excerpt as a heuristic — if excerpt is non-empty we tag it;
  // the full classification is in the run event payload (Phase 5).
  // Here we approximate: any run with a non-empty stderrExcerpt that ended "succeeded"
  // is a candidate for benign-only. This is intentionally conservative.
  const succeededWithStderr = rows.filter(
    (r) => r.status === "succeeded" && r.stderrExcerpt && r.stderrExcerpt.trim().length > 0,
  );

  // 3. Session resume rate by wake source
  const bySource: Record<string, { total: number; withSession: number; resumeRatePct: number }> = {};
  for (const r of rows) {
    const src = r.invocationSource ?? "unknown";
    if (!bySource[src]) bySource[src] = { total: 0, withSession: 0, resumeRatePct: 0 };
    bySource[src].total++;
    if (r.sessionIdBefore) bySource[src].withSession++;
  }
  for (const src of Object.keys(bySource)) {
    const s = bySource[src]!;
    s.resumeRatePct = s.total > 0 ? Math.round((s.withSession / s.total) * 100) : 0;
  }

  // 4. Median input tokens by wake source
  function median(nums: number[]): number | null {
    if (nums.length === 0) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? (sorted[mid] ?? null) : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
  }
  const timerTokens = timerRows.map((r) => Number(r.inputTokens ?? 0));
  const issueTokens = rows.filter((r) => r.invocationSource === "issue_assigned").map((r) => Number(r.inputTokens ?? 0));

  return {
    windowDays,
    totalFinishedRuns: total,
    timerWakes: {
      total: timerRows.length,
      skipped: skippedRows.length,
      skippedPct: timerRows.length > 0 ? Math.round((skippedRows.length / timerRows.length) * 100) : null,
    },
    stderrNoise: {
      runsWithBenignOnlyStderr: succeededWithStderr.length,
      runsWithBenignOnlyStderrPct: total > 0 ? Math.round((succeededWithStderr.length / total) * 100) : null,
    },
    sessionResume: { bySource },
    inputTokens: {
      medianTimerWake: median(timerTokens),
      medianIssueWake: median(issueTokens),
    },
  };
}

export function agentRuntimeRoutes(db?: Db) {
  const router = Router();

  /**
   * GET /api/agent-runtime/metrics?windowDays=7
   *
   * Observability metrics for Phase 6: validates that noise-reduction phases worked.
   * Returns aggregated stats for finished runs in the last N days:
   *  - timerWakes: how many were skipped (pre-flight guard effectiveness)
   *  - stderrNoise: successful runs that still had stderr output
   *  - sessionResume: resume rate by invocation source
   *  - inputTokens: median token usage by wake source
   */
  router.get("/agent-runtime/metrics", async (req, res, next) => {
    try {
      assertBoard(req);
      if (!db) {
        res.status(503).json({ error: "database not available" });
        return;
      }
      const { windowDays } = metricsQuerySchema.parse(req.query);
      const metrics = await getNoiseMetrics(db, windowDays);
      res.json(metrics);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/agent-runtime/restore/preview
   *
   * Returns a diff of what a restore from S3 would do:
   * - missing: files in S3 not present locally (will be restored)
   * - conflicts: files in both S3 and local with different content (user must choose)
   * - synced: files identical in both places
   */
  router.get("/agent-runtime/restore/preview", async (req, res, next) => {
    try {
      assertBoard(req);
      const preview = await previewAgentRuntimeRestore();
      res.json(preview);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/agent-runtime/restore
   *
   * Trigger a restore from S3. Body:
   *   strategy: "missing_only" | "overwrite_all" | "selected"
   *   selectedKeys?: string[]  — objectKeys to overwrite (strategy="selected" only)
   *
   * missing_only  — safe default: only write files absent locally (idempotent)
   * overwrite_all — restore everything, overwriting local with S3
   * selected      — overwrite only the specified objectKeys
   */
  router.post(
    "/agent-runtime/restore",
    validate(restoreBodySchema),
    async (req, res, next) => {
      try {
        assertBoard(req);
        const { strategy, selectedKeys } = req.body as z.infer<typeof restoreBodySchema>;
        const result = await restoreAgentRuntimeFromS3({ strategy, selectedKeys });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
