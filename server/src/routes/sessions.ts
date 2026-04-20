import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

/**
 * Pipeline health aggregates keyed on the persisted Claude session id.
 *
 * Designed as a superset of `/costs/by-agent` so the Facilitator can lean on
 * one endpoint for daily sweeps: per-agent run count + token totals *and* the
 * session-reuse distribution (single-run sessions, mean/max runs per session)
 * that the cost tables don't expose.
 *
 * Sessions are derived from `heartbeat_runs.usage_json->>'persistedSessionId'`
 * (the id Claude persists into the agent's runtime state for resume). Runs
 * with no persisted session (pre-rotation, failed mid-flight, etc.) are
 * bucketed under a synthetic `__no_session__` key so the counts stay honest.
 */
export function sessionRoutes(db: Db) {
  const router = Router();

  function parseWindowDays(query: Record<string, unknown>): number {
    const raw = Array.isArray(query.windowDays) ? query.windowDays[0] : query.windowDays;
    if (raw == null || raw === "") return 7;
    const days = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(days) || days <= 0 || days > 90) {
      throw badRequest("invalid 'windowDays' value (1-90)");
    }
    return days;
  }

  router.get("/companies/:companyId/sessions/summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const windowDays = parseWindowDays(req.query);

    const rows = await db.execute(sql`
      WITH runs_in_window AS (
        SELECT
          hr.agent_id,
          COALESCE(hr.usage_json ->> 'persistedSessionId', '__no_session__') AS session_key,
          COALESCE((hr.usage_json ->> 'rawInputTokens')::bigint,
                   (hr.usage_json ->> 'inputTokens')::bigint,
                   0) AS raw_input,
          COALESCE((hr.usage_json ->> 'rawCachedInputTokens')::bigint,
                   (hr.usage_json ->> 'cachedInputTokens')::bigint,
                   0) AS cached_input,
          COALESCE((hr.usage_json ->> 'rawOutputTokens')::bigint,
                   (hr.usage_json ->> 'outputTokens')::bigint,
                   0) AS output_tokens,
          hr.started_at
        FROM heartbeat_runs hr
        JOIN agents a ON a.id = hr.agent_id
        WHERE a.company_id = ${companyId}
          AND hr.started_at >= NOW() - (${windowDays} || ' days')::interval
          AND hr.usage_json IS NOT NULL
          AND hr.status IN ('succeeded', 'failed')
      ),
      per_session AS (
        SELECT
          agent_id,
          session_key,
          COUNT(*)::bigint AS runs_in_session,
          SUM(raw_input)::bigint AS raw_input,
          SUM(cached_input)::bigint AS cached_input,
          SUM(output_tokens)::bigint AS output_tokens,
          MIN(started_at) AS first_run_at,
          MAX(started_at) AS last_run_at
        FROM runs_in_window
        GROUP BY agent_id, session_key
      ),
      per_agent AS (
        SELECT
          agent_id,
          SUM(runs_in_session)::bigint AS run_count,
          COUNT(*)::bigint AS session_count,
          COUNT(*) FILTER (WHERE runs_in_session = 1)::bigint AS single_run_sessions,
          MAX(runs_in_session)::bigint AS max_runs_per_session,
          ROUND(AVG(runs_in_session)::numeric, 2) AS mean_runs_per_session,
          SUM(raw_input)::bigint AS raw_input_tokens,
          SUM(cached_input)::bigint AS cached_input_tokens,
          SUM(output_tokens)::bigint AS output_tokens
        FROM per_session
        GROUP BY agent_id
      )
      SELECT
        a.id AS agent_id,
        a.name AS agent_name,
        a.status AS agent_status,
        COALESCE(p.run_count, 0)::bigint AS run_count,
        COALESCE(p.session_count, 0)::bigint AS session_count,
        COALESCE(p.single_run_sessions, 0)::bigint AS single_run_sessions,
        COALESCE(p.max_runs_per_session, 0)::bigint AS max_runs_per_session,
        COALESCE(p.mean_runs_per_session, 0)::numeric AS mean_runs_per_session,
        COALESCE(p.raw_input_tokens, 0)::bigint AS raw_input_tokens,
        COALESCE(p.cached_input_tokens, 0)::bigint AS cached_input_tokens,
        COALESCE(p.output_tokens, 0)::bigint AS output_tokens
      FROM agents a
      LEFT JOIN per_agent p ON p.agent_id = a.id
      WHERE a.company_id = ${companyId}
        AND a.status != 'terminated'
      ORDER BY COALESCE(p.run_count, 0) DESC, a.name ASC
    `);

    const windowStartsAt = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const agents = (rows as unknown as Array<Record<string, unknown>>).map((row) => {
      const runCount = Number(row.run_count ?? 0);
      const sessionCount = Number(row.session_count ?? 0);
      const singleRunSessions = Number(row.single_run_sessions ?? 0);
      const rawInput = Number(row.raw_input_tokens ?? 0);
      const cached = Number(row.cached_input_tokens ?? 0);
      const totalInput = rawInput + cached;
      const cacheHitPct = totalInput > 0 ? (cached / totalInput) * 100 : 0;
      const singleRunSessionPct = sessionCount > 0 ? (singleRunSessions / sessionCount) * 100 : 0;
      const tokensPerRun = runCount > 0 ? totalInput / runCount : 0;
      return {
        agentId: String(row.agent_id),
        agentName: String(row.agent_name),
        agentStatus: String(row.agent_status),
        runCount,
        sessionCount,
        singleRunSessions,
        singleRunSessionPct: Number(singleRunSessionPct.toFixed(1)),
        meanRunsPerSession: Number(row.mean_runs_per_session ?? 0),
        maxRunsPerSession: Number(row.max_runs_per_session ?? 0),
        rawInputTokens: rawInput,
        cachedInputTokens: cached,
        outputTokens: Number(row.output_tokens ?? 0),
        cacheHitPct: Number(cacheHitPct.toFixed(1)),
        tokensPerRun: Math.round(tokensPerRun),
      };
    });

    res.json({
      windowDays,
      windowStartsAt,
      generatedAt: new Date().toISOString(),
      agents,
    });
  });

  return router;
}
