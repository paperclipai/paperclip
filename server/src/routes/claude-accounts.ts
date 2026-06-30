import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { claudeAccountUsageService } from "../services/claude-account-usage.js";
import { assertBoardOrgAccess } from "./authz.js";

/**
 * Multi-account Claude subscription usage (TWX-1117 / TWX-1118).
 *
 * GET /api/instance/claude-accounts/usage          -> persisted snapshots (no network)
 * GET /api/instance/claude-accounts/usage?refresh=1 -> probe all profiles then return
 *
 * Board-gated. The refresh path enforces <=1 probe/min/account and 429 backoff
 * internally, and only rotates+persists tokens for inactive profiles whose stored
 * token is rejected; the host's active auth is never switched.
 */
export function claudeAccountsRoutes(db: Db) {
  const router = Router();
  const svc = claudeAccountUsageService(db);

  router.get("/instance/claude-accounts/usage", async (req, res) => {
    assertBoardOrgAccess(req);
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    const result = refresh ? await svc.refreshAll() : await svc.getPersisted();
    res.json(result);
  });

  return router;
}
