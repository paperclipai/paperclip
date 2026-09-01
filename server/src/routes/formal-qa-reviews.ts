import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { formalQaReviewService } from "../services/formal-qa-reviews.js";
import { assertCompanyAccess, getAccessibleResource } from "./authz.js";

/** Read-only terminal evidence for the separately-authorized readiness controller. */
export function formalQaReviewRoutes(db: Db) {
  const router = Router();
  const reviews = formalQaReviewService(db);

  router.get("/companies/:companyId/formal-qa-reviews", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const preparationId = typeof req.query.preparationId === "string" ? req.query.preparationId : undefined;
    const rawLimit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    const limit = rawLimit && Number.isSafeInteger(rawLimit) ? rawLimit : undefined;
    res.json(await reviews.list(companyId, { preparationId, limit }));
  });

  router.get("/formal-qa-reviews/:id", async (req, res) => {
    const review = await getAccessibleResource(
      req,
      res,
      reviews.getById(req.params.id as string),
      "Formal-QA review not found",
    );
    if (!review) return;
    res.json(review);
  });

  return router;
}
