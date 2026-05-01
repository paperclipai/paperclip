import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2JarvisAutonomyService } from "../services/rt2-jarvis-autonomy.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2JarvisAutonomyRoutes(db: Db) {
  const router = Router();
  const svc = rt2JarvisAutonomyService(db);

  // AUTO-01: Submit proposal for operator approval
  // POST /api/companies/:companyId/rt2/jarvis/autonomy/submit/:proposalId
  router.post("/companies/:companyId/rt2/jarvis/autonomy/submit/:proposalId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { submittedBy, submittedByType, riskLevel } = req.body;
      const proposal = await svc.submitProposalForApproval(companyId, req.params.proposalId, {
        submittedBy: submittedBy ?? req.body.actorId ?? "system",
        submittedByType: submittedByType ?? "system",
        riskLevel,
      });
      res.json({ data: proposal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // AUTO-02: Approve a proposal
  // POST /api/companies/:companyId/rt2/jarvis/autonomy/approve/:proposalId
  router.post("/companies/:companyId/rt2/jarvis/autonomy/approve/:proposalId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { approverId, approverType, decisionReason } = req.body;
      const proposal = await svc.approveProposal(companyId, req.params.proposalId, {
        approverId: approverId ?? req.body.actorId ?? "operator",
        approverType: approverType ?? "user",
        decisionReason,
      });
      res.json({ data: proposal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // AUTO-02: Reject a proposal
  // POST /api/companies/:companyId/rt2/jarvis/autonomy/reject/:proposalId
  router.post("/companies/:companyId/rt2/jarvis/autonomy/reject/:proposalId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { rejecterId, rejecterType, decisionReason } = req.body;
      if (!decisionReason) {
        return res.status(400).json({ error: "decisionReason is required for rejection" });
      }
      const proposal = await svc.rejectProposal(companyId, req.params.proposalId, {
        rejecterId: rejecterId ?? req.body.actorId ?? "operator",
        rejecterType: rejecterType ?? "user",
        decisionReason,
      });
      res.json({ data: proposal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // AUTO-01: Direct apply — execute an approved proposal
  // POST /api/companies/:companyId/rt2/jarvis/autonomy/apply/:proposalId
  router.post("/companies/:companyId/rt2/jarvis/autonomy/apply/:proposalId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { appliedByActorId, appliedByActorType } = req.body;
      const result = await svc.applyProposal(companyId, req.params.proposalId, {
        appliedByActorId: appliedByActorId ?? req.body.actorId ?? "system",
        appliedByActorType: appliedByActorType ?? "system",
      });
      if (!result.applied) {
        return res.status(409).json({ error: result.applyError });
      }
      res.json({ data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // AUTO-01: List proposals with approval gate status
  // GET /api/companies/:companyId/rt2/jarvis/autonomy/proposals
  router.get("/companies/:companyId/rt2/jarvis/autonomy/proposals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { status, riskLevel, limit } = req.query;
    const proposals = await svc.listProposalsWithGateStatus(companyId, {
      status: status as string | undefined,
      riskLevel: riskLevel as string | undefined,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    res.json({ data: proposals });
  });

  // AUTO-01: Get apply status summary
  // GET /api/companies/:companyId/rt2/jarvis/autonomy/status-summary
  router.get("/companies/:companyId/rt2/jarvis/autonomy/status-summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const summary = await svc.getApplyStatusSummary(companyId);
    res.json({ data: summary });
  });

  return router;
}
