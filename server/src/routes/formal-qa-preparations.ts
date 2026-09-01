import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createFormalQaPreparationSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { formalQaPreparationService } from "../services/formal-qa-preparations.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";

/**
 * A Board request is intentionally inert until the server-controlled issuer
 * re-reads its policy and GitHub. The route never accepts a caller's head,
 * check, repository, expiry, or execution choice.
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
      const requested = await service.create({
        ...req.body,
        companyId,
        issuedByUserId: actor.actorId,
      });
      if (!requested.replayed) {
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "formal_qa.preparation_created",
          entityType: "formal_qa_preparation",
          entityId: requested.preparation.id,
          details: {
            projectId: requested.preparation.projectId,
            projectWorkspaceId: requested.preparation.projectWorkspaceId,
            prNumber: requested.preparation.prNumber,
            requestSha256: requested.preparation.requestSha256,
          },
        });
      }
      // Issuance is reconciled asynchronously by the server-owned controller.
      // Keeping this request durable-and-inert means a transient GitHub or
      // credential outage cannot turn a Board request into a user-driven retry
      // loop, nor can an HTTP caller choose when a reviewer process starts.
      res.status(requested.replayed ? 200 : 202).json(requested);
    },
  );

  return router;
}
