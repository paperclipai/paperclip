import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";

/**
 * Routes for execution-proxy token validation.
 *
 * The execution proxy (running on a workstation) calls these endpoints to
 * validate short-lived run-scoped bearer tokens before executing commands on
 * behalf of an agent heartbeat. Tokens are minted by the Paperclip harness at
 * run start (via createLocalAgentJwt) and are implicitly revoked when the run
 * finishes (finishedAt is set).
 *
 * POST /api/proxy/validate-run-token
 *   Body:  { token: string }
 *   200:   { valid: true,  agentId, companyId, runId }
 *   401:   { valid: false, reason }
 *
 * This endpoint is intentionally unauthenticated — the proxy has no API key of
 * its own; the token-under-validation IS the credential being evaluated.
 */
export function proxyRoutes(db: Db): Router {
  const router = Router();

  router.post("/proxy/validate-run-token", async (req, res) => {
    const { token } = req.body ?? {};
    if (typeof token !== "string" || !token) {
      return res.status(400).json({ valid: false, reason: "missing_token" });
    }

    // 1. Verify JWT signature and static claims (signature, expiry, issuer, audience).
    const claims = verifyLocalAgentJwt(token);
    if (!claims) {
      return res.status(401).json({ valid: false, reason: "invalid_token" });
    }

    // 2. Check the referenced run is still active (finishedAt IS NULL).
    //    This is the "run-scoped" constraint: token is useless after the run ends.
    const run = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        companyId: heartbeatRuns.companyId,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, claims.run_id))
      .then((rows) => rows[0] ?? null);

    if (!run) {
      return res.status(401).json({ valid: false, reason: "run_not_found" });
    }

    const TERMINAL_STATUSES = new Set(["done", "cancelled", "failed", "error"]);
    if (run.finishedAt !== null || TERMINAL_STATUSES.has(run.status)) {
      return res.status(401).json({ valid: false, reason: "run_finished" });
    }

    // 3. Sanity-check: JWT sub must match the run's agent.
    if (run.agentId !== claims.sub || run.companyId !== claims.company_id) {
      return res.status(401).json({ valid: false, reason: "token_agent_mismatch" });
    }

    return res.status(200).json({
      valid: true,
      agentId: run.agentId,
      companyId: run.companyId,
      runId: run.id,
    });
  });

  return router;
}
