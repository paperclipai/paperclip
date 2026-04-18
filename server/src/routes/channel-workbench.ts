import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { channelWorkbenchService } from "../services/channel-workbench.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function channelWorkbenchRoutes(db: Db) {
  const router = Router();
  const svc = channelWorkbenchService(db);

  router.get("/companies/:companyId/channel-workbench/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.getOverview(companyId, scenario);
    res.json(payload);
  });

  router.get("/companies/:companyId/channel-workbench/next-actions", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.getNextActions(companyId, scenario);
    res.json(payload);
  });

  router.get("/companies/:companyId/channel-workbench/snapshot-export", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.getSnapshotExport(companyId, scenario);
    res.json(payload);
  });

  router.get("/companies/:companyId/channel-workbench/evidence-dod", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.getEvidenceDod(companyId, scenario);
    res.json(payload);
  });

  router.get("/companies/:companyId/channel-workbench/gate-result", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.getGateResult(companyId, scenario);
    res.json(payload);
  });

  router.get("/companies/:companyId/channel-workbench/issue-ledger", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.getIssueLedger(companyId, scenario);
    res.json(payload);
  });

  router.get("/companies/:companyId/channel-workbench/source-documents", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.getSourceDocuments(companyId, scenario);
    res.json(payload);
  });

  router.get("/companies/:companyId/channel-workbench/spec-editor", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.getSpecEditor(companyId, scenario);
    res.json(payload);
  });

  router.get("/companies/:companyId/channel-workbench/role-view", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.getRoleView(companyId, scenario);
    res.json(payload);
  });

  router.post("/companies/:companyId/channel-workbench/rerun-gate", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.rerunGate(companyId, scenario);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "channel_workbench.gate_rerun_requested",
      entityType: "channel_case",
      entityId: payload.caseId,
      details: {
        previousScenario: payload.previousScenario.key,
        currentScenario: payload.currentScenario.key,
        gateRunId: payload.gateRunId,
        status: payload.status,
        gateSummaryStatus: payload.gateSummaryStatus,
        targetPage: payload.targetPage,
      },
    });
    res.json(payload);
  });

  router.post("/companies/:companyId/channel-workbench/export-ai", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.exportAi(companyId, scenario);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "channel_workbench.ai_package_exported",
      entityType: "channel_case",
      entityId: payload.caseId,
      details: {
        previousScenario: payload.previousScenario.key,
        currentScenario: payload.currentScenario.key,
        exportId: payload.exportId,
        snapshotId: payload.snapshotId,
        ruleVersion: payload.ruleVersion,
        status: payload.status,
        packageStatus: payload.packageStatus,
        targetPage: payload.targetPage,
      },
    });
    res.json(payload);
  });

  router.post("/companies/:companyId/channel-workbench/upload-evidence", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scenario = typeof req.query.scenario === "string" ? req.query.scenario : undefined;
    assertCompanyAccess(req, companyId);
    const payload = await svc.uploadEvidence(companyId, scenario);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "channel_workbench.evidence_uploaded",
      entityType: "channel_case",
      entityId: payload.caseId,
      details: {
        previousScenario: payload.previousScenario.key,
        currentScenario: payload.currentScenario.key,
        evidenceId: payload.evidenceId,
        obligationId: payload.obligationId,
        status: payload.status,
        evidenceStatus: payload.evidenceStatus,
        completedEvidenceCount: payload.completedEvidenceCount,
        remainingBlockingCount: payload.remainingBlockingCount,
        dodSummaryStatus: payload.dodSummaryStatus,
        targetPage: payload.targetPage,
      },
    });
    res.json(payload);
  });

  return router;
}
