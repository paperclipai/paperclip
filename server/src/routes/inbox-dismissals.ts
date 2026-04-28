import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { inboxDismissalService, logActivity } from "../services/index.js";

const inboxDismissalSchema = z.object({
  itemKey: z.string().trim().min(1).regex(/^(approval|join|run):.+$/, "Unsupported inbox item key"),
});

export function inboxDismissalRoutes(db: Db) {
  const router = Router();
  const svc = inboxDismissalService(db);

  router.get("/companies/:companyId/inbox-dismissals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const dismissals = await svc.list(companyId, req.actor.userId);
    res.json(dismissals);
  });

  router.post(
    "/companies/:companyId/inbox-dismissals",
    validate(inboxDismissalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Board authentication required" });
        return;
      }
      if (!req.actor.userId) {
        res.status(403).json({ error: "Board user context required" });
        return;
      }

      const dismissal = await svc.dismiss(companyId, req.actor.userId, req.body.itemKey, new Date());
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "inbox.dismissed",
        entityType: "company",
        entityId: companyId,
        details: {
          userId: req.actor.userId,
          itemKey: dismissal.itemKey,
          dismissedAt: dismissal.dismissedAt,
        },
      });

      res.status(201).json(dismissal);
    },
  );

  return router;
}
