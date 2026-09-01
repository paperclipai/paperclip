import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createFormalQaPreparationSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { formalQaPreparationService } from "../services/formal-qa-preparations.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

/**
 * Board-only preparation records are deliberately inert. They establish a
 * durable, tenant-scoped exact-head receipt, but never create a heartbeat,
 * execution workspace, host command, or agent credential.
 */
export function formalQaPreparationRoutes(db: Db) {
  const router = Router();
  const service = formalQaPreparationService(db);

  router.get("/companies/:companyId/formal-qa-preparations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
    res.json(await service.list(companyId, projectId));
  });

  router.get("/formal-qa-preparations/:id", async (req, res) => {
    const preparation = await getAccessibleResource(
      req,
      res,
      service.getById(req.params.id as string),
      "Formal-QA preparation not found",
    );
    if (!preparation) return;
    res.json(preparation);
  });

  router.post(
    "/companies/:companyId/formal-qa-preparations",
    validate(createFormalQaPreparationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const result = await service.create({
        ...req.body,
        companyId,
        issuedByUserId: actor.actorId,
      });
      if (!result.replayed) {
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "formal_qa.preparation_created",
          entityType: "formal_qa_preparation",
          entityId: result.preparation.id,
          details: {
            projectId: result.preparation.projectId,
            projectWorkspaceId: result.preparation.projectWorkspaceId,
            repository: result.preparation.repository,
            prNumber: result.preparation.prNumber,
            headSha: result.preparation.headSha,
            requestSha256: result.preparation.requestSha256,
          },
        });
      }
      res.status(result.replayed ? 200 : 201).json(result);
    },
  );

  return router;
}
