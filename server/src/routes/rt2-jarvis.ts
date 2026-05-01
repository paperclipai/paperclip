import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { Rt2JarvisRewriteProposalInput } from "@paperclipai/shared";
import { rt2JarvisService } from "../services/rt2-jarvis.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2JarvisRoutes(db: Db) {
  const router = Router();
  const svc = rt2JarvisService(db);

  router.get("/companies/:companyId/rt2/jarvis/rewrite-proposals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listRewriteProposals(companyId));
  });

  router.post("/companies/:companyId/rt2/jarvis/rewrite-proposals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = req.body as Partial<Rt2JarvisRewriteProposalInput>;
    if (!input.targetType || !input.targetId || !input.targetKey || !input.title || !input.before || !input.after) {
      res.status(400).json({ error: "targetType, targetId, targetKey, title, before, and after are required" });
      return;
    }
    const actorId = String(req.actor.userId ?? "system");
    res.status(201).json(await svc.createRewriteProposal(companyId, input as Rt2JarvisRewriteProposalInput, actorId));
  });

  router.post("/companies/:companyId/rt2/jarvis/rewrite-proposals/:proposalId/request-approval", async (req, res) => {
    const companyId = req.params.companyId as string;
    const proposalId = req.params.proposalId as string;
    assertCompanyAccess(req, companyId);
    const actorId = String(req.actor.userId ?? "system");
    res.json(await svc.requestRewriteApproval(companyId, proposalId, actorId));
  });

  router.post("/companies/:companyId/rt2/jarvis/rewrite-proposals/:proposalId/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    const proposalId = req.params.proposalId as string;
    assertCompanyAccess(req, companyId);
    const actorId = String(req.actor.userId ?? "system");
    res.json(await svc.decideRewriteProposal(companyId, proposalId, "approved", actorId, req.body?.reason));
  });

  router.post("/companies/:companyId/rt2/jarvis/rewrite-proposals/:proposalId/reject", async (req, res) => {
    const companyId = req.params.companyId as string;
    const proposalId = req.params.proposalId as string;
    assertCompanyAccess(req, companyId);
    const actorId = String(req.actor.userId ?? "system");
    res.json(await svc.decideRewriteProposal(companyId, proposalId, "rejected", actorId, req.body?.reason));
  });

  router.post("/companies/:companyId/rt2/jarvis/rewrite-proposals/:proposalId/apply", async (req, res) => {
    const companyId = req.params.companyId as string;
    const proposalId = req.params.proposalId as string;
    assertCompanyAccess(req, companyId);
    const actorId = String(req.actor.userId ?? "system");
    res.json(await svc.applyApprovedWikiRewrite(companyId, proposalId, actorId, req.body?.reason));
  });

  router.get("/companies/:companyId/rt2/jarvis/tasks/:taskIssueId/advice", async (req, res) => {
    const companyId = req.params.companyId as string;
    const taskIssueId = req.params.taskIssueId as string;
    assertCompanyAccess(req, companyId);
    const advice = await svc.getTaskAdvice(companyId, taskIssueId);
    res.json(advice);
  });

  router.get("/companies/:companyId/rt2/jarvis/tasks/:taskIssueId/breakdown", async (req, res) => {
    const companyId = req.params.companyId as string;
    const taskIssueId = req.params.taskIssueId as string;
    assertCompanyAccess(req, companyId);
    const breakdown = await svc.getTaskBreakdown(companyId, taskIssueId);
    res.json(breakdown);
  });

  router.get("/companies/:companyId/rt2/jarvis/insights", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = String(req.query.projectId ?? "").trim();

    assertCompanyAccess(req, companyId);

    if (!projectId) {
      res.status(400).json({ error: "projectId is required" });
      return;
    }

    const insights = await svc.getProjectInsights(companyId, projectId);
    res.json(insights);
  });

  return router;
}
