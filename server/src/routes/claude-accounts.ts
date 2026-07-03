import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { claudeAccountUsageService } from "../services/claude-account-usage.js";
import { claudeAuthSwitchService } from "../services/claude-auth-switch.js";
import { assertBoardOrgAccess } from "./authz.js";

/**
 * Multi-account Claude subscription usage + smart auth-switch (TWX-1117 /
 * TWX-1118 C1 / TWX-1121 C3).
 *
 * GET  /api/instance/claude-accounts/usage           -> persisted snapshots (no network)
 * GET  /api/instance/claude-accounts/usage?refresh=1 -> probe all profiles then return
 * GET  /api/instance/claude-accounts/switch-decisions -> recent switch-decision audit
 * POST /api/instance/claude-accounts/switch          -> run one decision cycle now
 *
 * Board-gated. The refresh path enforces <=1 probe/min/account and 429 backoff
 * internally, and only rotates+persists tokens for inactive profiles whose stored
 * token is rejected. The switch decision engine honors the account-tier policy and
 * only executes a host switch when explicitly enabled (shadow/dry-run by default).
 */
export function claudeAccountsRoutes(db: Db) {
  const router = Router();
  const svc = claudeAccountUsageService(db);
  const switchSvc = claudeAuthSwitchService(db);

  router.get("/instance/claude-accounts/usage", async (req, res) => {
    assertBoardOrgAccess(req);
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    const result = refresh ? await svc.refreshAll() : await svc.getPersisted();
    res.json(result);
  });

  router.get("/instance/claude-accounts/switch-decisions", async (req, res) => {
    assertBoardOrgAccess(req);
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    res.json({ decisions: await switchSvc.recentDecisions(limit) });
  });

  router.post("/instance/claude-accounts/switch", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await switchSvc.runOnce());
  });

  return router;
}
