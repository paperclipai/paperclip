import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2CoPilotService } from "../services/rt2-copilot.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

export function rt2CoPilotRoutes(db: Db) {
  const router = Router();
  const svc = rt2CoPilotService(db);

  // M3.1: Get pending evaluations for manager review
  router.get("/companies/:companyId/rt2/copilot/pending", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const pending = await svc.getPendingEvaluations(companyId);
    res.json(pending);
  });

  // M3.1: Create AI preliminary evaluation
  router.post("/companies/:companyId/rt2/copilot/evaluate", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { taskIssueId, evaluator, score, category, rationale, direction } = req.body;

    if (!taskIssueId || !evaluator || score === undefined || !category) {
      throw badRequest("taskIssueId, evaluator, score, and category are required");
    }

    if (!["positive", "negative"].includes(direction)) {
      throw badRequest("direction must be 'positive' or 'negative'");
    }

    const evaluation = await svc.createPreliminaryEvaluation(
      companyId,
      taskIssueId,
      evaluator,
      score,
      category,
      rationale || "",
      direction,
    );

    res.json(evaluation);
  });

  // M3.1: Approve evaluation
  router.post("/companies/:companyId/rt2/copilot/approve/:evaluationId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { evaluationId } = req.params;
    const { managerId, feedback } = req.body;

    if (!managerId) {
      throw badRequest("managerId is required");
    }

    const evaluation = await svc.approveEvaluation(
      evaluationId,
      companyId,
      managerId,
      feedback,
    );

    res.json(evaluation);
  });

  // M3.1: Reject evaluation
  router.post("/companies/:companyId/rt2/copilot/reject/:evaluationId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { evaluationId } = req.params;
    const { managerId, feedback } = req.body;

    if (!managerId) {
      throw badRequest("managerId is required");
    }

    if (!feedback) {
      throw badRequest("feedback is required when rejecting");
    }

    const evaluation = await svc.rejectEvaluation(
      evaluationId,
      companyId,
      managerId,
      feedback,
    );

    res.json(evaluation);
  });

  // M3.1: Get finalized evaluations for a deliverable
  router.get("/companies/:companyId/rt2/copilot/evaluations/:deliverableId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { deliverableId } = req.params;

    const evaluations = await svc.getFinalizedEvaluations(companyId, deliverableId);
    res.json(evaluations);
  });

  // M3.1: Get feedback summary for learning
  router.get("/companies/:companyId/rt2/copilot/feedback-summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    const summary = await svc.getFeedbackSummary(companyId, startDate, endDate);
    res.json(summary);
  });

  // M3.1: Get AI rationale report for a task
  router.get("/companies/:companyId/rt2/copilot/rationale/:taskIssueId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { taskIssueId } = req.params;

    const report = await svc.getAIRationaleReport(companyId, taskIssueId);
    res.json(report);
  });

  // M3.1: Batch approve pending evaluations
  router.post("/companies/:companyId/rt2/copilot/batch-approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { evaluationIds, managerId, feedback } = req.body;

    if (!evaluationIds || !Array.isArray(evaluationIds) || evaluationIds.length === 0) {
      throw badRequest("evaluationIds array is required");
    }

    if (!managerId) {
      throw badRequest("managerId is required");
    }

    const count = await svc.batchApprove(evaluationIds, companyId, managerId, feedback);
    res.json({ approvedCount: count });
  });

  return router;
}
