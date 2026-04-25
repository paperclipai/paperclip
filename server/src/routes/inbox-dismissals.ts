import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { inboxDismissalService, logActivity } from "../services/index.js";

const inboxDismissalSchema = z.object({
  itemKey: z.string().trim().min(1).regex(/^(approval|join|run):.+$/, "Unsupported inbox item key"),
});

export function inboxDismissalRoutes(db: Db) {
  const router = Router();
  const svc = inboxDismissalService(db);

  router.post("/heartbeat-runs/:runId/resolve", async (req, res) => {
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const runId = req.params.runId as string;
    const canSeeAllCompanies = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
    const visibleCompanyIds = canSeeAllCompanies ? [] : req.actor.companyIds ?? [];
    if (!canSeeAllCompanies && visibleCompanyIds.length === 0) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }

    const [run] = await db
      .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(
        canSeeAllCompanies
          ? eq(heartbeatRuns.id, runId)
          : and(eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.companyId, visibleCompanyIds)),
      )
      .limit(1);

    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }

    assertCompanyAccess(req, run.companyId);
    if (run.status !== "failed" && run.status !== "timed_out") {
      res.status(400).json({ error: "Only failed or timed out heartbeat runs can be resolved" });
      return;
    }

    const dismissal = await svc.dismiss(run.companyId, req.actor.userId, `run:${run.id}`, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: run.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat_run.resolved",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: {
        userId: req.actor.userId,
        itemKey: dismissal.itemKey,
        resolvedAt: dismissal.dismissedAt,
      },
    });

    res.status(201).json(dismissal);
  });

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
