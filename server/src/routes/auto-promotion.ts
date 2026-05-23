/**
 * Plan 4 Phase 5 - auto-promotion HTTP routes.
 *
 * Wires 8 endpoints to autoPromotionService. Path convention (all under the
 * /api namespace already mounted in app.ts):
 *
 *   GET    /companies/:companyId/guilds/:guildId/auto-promotion-config
 *   PATCH  /companies/:companyId/guilds/:guildId/auto-promotion-config
 *   GET    /companies/:companyId/guilds/:guildId/auto-promotions
 *   GET    /companies/:companyId/auto-promotions/:auditId
 *   GET    /companies/:companyId/auto-promotions/:auditId/review
 *   POST   /companies/:companyId/auto-promotions/:auditId/revert
 *   GET    /companies/:companyId/guilds/:guildId/auto-promotion-scans
 *   POST   /companies/:companyId/guilds/:guildId/auto-promotion-scans
 *
 * Auth rules:
 *   - All routes require company access (assertCompanyAccess).
 *   - Mutating routes (PATCH config, POST revert, POST scan) additionally
 *     require a non-agent actor (assertNonAgentActor). Agent-bearer tokens
 *     cannot mutate auto-promotion state.
 *   - Read routes are available to any authenticated company actor.
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  autoPromotionConfigPatchSchema,
  autoPromotionListQuerySchema,
  autoPromotionRevertSchema,
} from "@paperclipai/shared";

import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { autoPromotionService } from "../services/auto-promotion.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function autoPromotionRoutes(db: Db) {
  const router = Router();
  const svc = autoPromotionService(db);

  function assertNonAgentActor(req: Parameters<typeof assertCompanyAccess>[0]) {
    if (req.actor.type === "agent") {
      throw forbidden(
        "Auto-promotion management requires operator approval; agent-bearer " +
          "tokens cannot mutate auto-promotion state.",
      );
    }
  }

  // GET /companies/:companyId/guilds/:guildId/auto-promotion-config
  // Returns the config row including health metrics (lastSuccessfulScanAt).
  router.get(
    "/companies/:companyId/guilds/:guildId/auto-promotion-config",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      assertCompanyAccess(req, companyId);
      const config = await svc.getConfig(companyId, guildId);
      res.json(config);
    },
  );

  // PATCH /companies/:companyId/guilds/:guildId/auto-promotion-config
  // Updates one or more config fields atomically. Operator-only.
  router.patch(
    "/companies/:companyId/guilds/:guildId/auto-promotion-config",
    validate(autoPromotionConfigPatchSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      assertCompanyAccess(req, companyId);
      assertNonAgentActor(req);
      const actor = getActorInfo(req);
      const result = await svc.patchConfig(companyId, guildId, req.body, {
        id: actor.actorId,
        type: actor.actorType,
      });
      res.json(result);
    },
  );

  // GET /companies/:companyId/guilds/:guildId/auto-promotions
  // Lists audit rows with optional filters: since, until, revertedOnly,
  // neverReviewed, limit.
  router.get(
    "/companies/:companyId/guilds/:guildId/auto-promotions",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      assertCompanyAccess(req, companyId);
      const parsed = autoPromotionListQuerySchema.parse(req.query);
      const result = await svc.listAudits(companyId, guildId, parsed);
      res.json(result);
    },
  );

  // GET /companies/:companyId/auto-promotions/:auditId
  // Returns the full audit envelope (audit + skill snapshot + recentUses +
  // revert + reviewCount). Read-only; does NOT write a review row.
  router.get(
    "/companies/:companyId/auto-promotions/:auditId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const auditId = req.params.auditId as string;
      assertCompanyAccess(req, companyId);
      const envelope = await svc.getAuditEnvelope(companyId, auditId);
      res.json(envelope);
    },
  );

  // GET /companies/:companyId/auto-promotions/:auditId/review
  // Returns the audit envelope AND writes a review row for the calling actor.
  // Calling this endpoint multiple times is intentional (each call records a
  // separate review row so audit trails are preserved).
  router.get(
    "/companies/:companyId/auto-promotions/:auditId/review",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const auditId = req.params.auditId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const envelope = await svc.getAuditEnvelope(companyId, auditId);
      const review = await svc.recordReview(companyId, auditId, actor.actorId);
      res.json({
        ...envelope,
        reviewCount: envelope.reviewCount + 1,
        review,
      });
    },
  );

  // POST /companies/:companyId/auto-promotions/:auditId/revert
  // Reverts a promotion back to provisional. Operator-only.
  router.post(
    "/companies/:companyId/auto-promotions/:auditId/revert",
    validate(autoPromotionRevertSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const auditId = req.params.auditId as string;
      assertCompanyAccess(req, companyId);
      assertNonAgentActor(req);
      const actor = getActorInfo(req);
      const result = await svc.revert(
        companyId,
        auditId,
        req.body.reason,
        actor.actorId,
      );
      res.json(result);
    },
  );

  // GET /companies/:companyId/guilds/:guildId/auto-promotion-scans
  // Returns aggregated scan-tick history from activity_log.
  router.get(
    "/companies/:companyId/guilds/:guildId/auto-promotion-scans",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      assertCompanyAccess(req, companyId);
      const limitRaw = req.query.limit;
      const limit =
        limitRaw !== undefined
          ? Math.min(200, Math.max(1, parseInt(String(limitRaw), 10) || 20))
          : 20;
      const ticks = await svc.listScanTicks(companyId, guildId, limit);
      res.json(ticks);
    },
  );

  // POST /companies/:companyId/guilds/:guildId/auto-promotion-scans
  // Triggers a manual scan. Generates a fresh scanId, loads current config,
  // then delegates to svc.scanGuild. Operator-only.
  router.post(
    "/companies/:companyId/guilds/:guildId/auto-promotion-scans",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const guildId = req.params.guildId as string;
      assertCompanyAccess(req, companyId);
      assertNonAgentActor(req);
      const scanId = randomUUID();
      const config = await svc.getConfig(companyId, guildId);
      const result = await svc.scanGuild(scanId, config);
      res.json(result);
    },
  );

  return router;
}
