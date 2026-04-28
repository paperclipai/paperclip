import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { generateRt2ContradictionCandidatesSchema, listRt2ContradictionCandidatesSchema, resolveRt2ContradictionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { rt2ContradictionReviewService } from "../services/rt2-contradiction-review.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2ContradictionReviewRoutes(db: Db) {
  const router = Router();
  const service = rt2ContradictionReviewService(db);

  router.get("/companies/:companyId/rt2/contradictions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const query = listRt2ContradictionCandidatesSchema.parse(req.query);
    res.json(await service.listCandidates(companyId, query));
  });

  router.post(
    "/companies/:companyId/rt2/contradictions/generate",
    validate(generateRt2ContradictionCandidatesSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const body = generateRt2ContradictionCandidatesSchema.parse(req.body ?? {});
      const result = await service.generateCandidates(companyId, body);
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "rt2-contradiction-review",
        action: "rt2.knowledge.contradictions_generated",
        entityType: "knowledge_contradiction",
        entityId: body.projectId,
        details: {
          checkedPages: result.checkedPages,
          semanticComparisons: result.semanticComparisons,
          candidatesCreated: result.candidatesCreated,
        },
      });
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/rt2/contradictions/:candidateId/resolve",
    validate(resolveRt2ContradictionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const candidateId = req.params.candidateId as string;
      assertCompanyAccess(req, companyId);
      const body = resolveRt2ContradictionSchema.parse(req.body ?? {});
      try {
        const result = await service.resolveCandidate(companyId, candidateId, body, req.actor.userId ?? "rt2-operator");
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "rt2-contradiction-review",
          action: "rt2.knowledge.contradiction_resolved",
          entityType: "knowledge_contradiction",
          entityId: candidateId,
          details: {
            decision: body.decision,
            reason: body.reason,
            auditEventId: result.resolution.auditEventId,
          },
        });
        res.json(result);
      } catch (error) {
        if ((error as Error & { status?: number }).status === 404) {
          res.status(404).json({ error: "Contradiction candidate not found" });
          return;
        }
        throw error;
      }
    },
  );

  return router;
}
