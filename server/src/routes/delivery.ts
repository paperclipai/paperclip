import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import {
  deliveryIssueActionSchema,
  deliveryPolicyWriteSchema,
  deliveryReconciliationWriteSchema,
  type DeliveryIssueAction,
} from "@paperclipai/shared/validators/delivery";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { forbidden, unauthorized } from "../errors.js";
import { issueService } from "../services/issues.js";
import { projectService } from "../services/projects.js";
import { logActivity } from "../services/activity-log.js";
import type { DeliveryService } from "../services/delivery/index.js";
import { assertPublicationCapabilityBinding } from "../services/delivery/publication-capability.js";
import { verifyRuntimeToolsToken } from "../runtime-tools-token.js";

/**
 * Delivery lifecycle API.
 *
 * Every route is company-scoped and activity-logged. The routes never accept a
 * repository, credential, review, or merge fact from the caller: those are
 * derived from the persisted policy and verified against GitHub.
 */
export function deliveryRoutes(
  db: Db,
  deps: { delivery: DeliveryService },
) {
  const router = Router();
  const issues = issueService(db);
  const projects = projectService(db);
  const delivery = deps.delivery;

  function publicationCapability(req: Request, companyId: string) {
    if (req.headers.origin || req.headers.cookie || req.headers["sec-fetch-site"]) {
      throw forbidden("Publication capability cannot be presented by a browser session");
    }
    // Header-only: the capability is the runtime tools token minted for the
    // calling agent run. The Authorization bearer fallback is dead — an agent
    // API key in that header is a different credential and must never satisfy
    // the publication binding.
    const raw = req.header("x-paperclip-publication-capability") ?? "";
    const claims = verifyRuntimeToolsToken(raw, "github_credentials");
    if (!claims) throw unauthorized("A signed publication capability is required");
    assertPublicationCapabilityBinding({
      claims,
      companyId,
      actor: { type: req.actor.type, agentId: req.actor.agentId ?? null, runId: req.actor.runId ?? null },
    });
    return claims;
  }

  function assertOperator(req: Request) {
    assertBoard(req);
  }

  async function logDelivery(input: {
    req: Request;
    companyId: string;
    action: string;
    issueId?: string | null;
    unitId?: string | null;
    details?: Record<string, unknown>;
  }) {
    const actor = getActorInfo(input.req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: input.action,
      entityType: input.issueId ? "issue" : "delivery_unit",
      entityId: input.issueId ?? input.unitId ?? input.companyId,
      issueId: input.issueId ?? null,
      details: { unitId: input.unitId ?? null, ...(input.details ?? {}) },
    });
  }

  async function accessibleIssue(req: Request, res: Response, issueId: string) {
    return await getAccessibleResource(req, res, issues.getById(issueId), "Issue not found");
  }

  async function accessibleProject(req: Request, res: Response, projectId: string) {
    return await getAccessibleResource(req, res, projects.getById(projectId), "Project not found");
  }

  router.get("/issues/:id/delivery", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await accessibleIssue(req, res, issueId);
    if (!issue) return;
    res.json(await delivery.getSummary(issue.companyId, issueId));
  });

  router.post("/issues/:id/delivery", validate(deliveryIssueActionSchema), async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await accessibleIssue(req, res, issueId);
    if (!issue) return;
    const actorInfo = getActorInfo(req);
    const actor = {
      type: actorInfo.actorType === "agent" ? "agent" as const : "user" as const,
      id: actorInfo.actorId,
      agentId: actorInfo.agentId,
      userId: actorInfo.actorType === "user" ? actorInfo.actorId : null,
    };
    const action = req.body as DeliveryIssueAction;

    switch (action.action) {
      case "submit": {
        if (actorInfo.actorType === "agent") publicationCapability(req, issue.companyId);
        const summary = await delivery.submit({
          companyId: issue.companyId,
          issueId,
          actor,
          action: {
            headSha: action.headSha,
            baseSha: action.baseSha ?? null,
            sourceBranch: action.sourceBranch,
            artifactReady: action.artifactReady,
            coveredIssueIds: action.coveredIssueIds,
            targetBranch: action.targetBranch,
          },
        });
        await logDelivery({ req, companyId: issue.companyId, action: "delivery.candidate_submitted", issueId, unitId: summary.unitId });
        res.json(summary);
        return;
      }
      case "reconcile": {
        const summary = await delivery.reconcileIssue(issue.companyId, issueId);
        await logDelivery({ req, companyId: issue.companyId, action: "delivery.reconciled", issueId, unitId: summary.unitId });
        res.json(summary);
        return;
      }
      case "feedback": {
        const summary = await delivery.recordFeedback({
          companyId: issue.companyId,
          issueId,
          actor,
          findingId: action.findingId,
          disposition: action.disposition,
          explanation: action.explanation,
        });
        await logDelivery({
          req,
          companyId: issue.companyId,
          action: "delivery.finding_disposition",
          issueId,
          unitId: summary.unitId,
          details: { findingId: action.findingId, disposition: action.disposition },
        });
        res.json(summary);
        return;
      }
      case "retry": {
        const summary = await delivery.retry({ companyId: issue.companyId, issueId, actor });
        await logDelivery({ req, companyId: issue.companyId, action: "delivery.retried", issueId, unitId: summary.unitId });
        res.json(summary);
        return;
      }
      case "pause": {
        assertOperator(req);
        const summary = await delivery.pause({ companyId: issue.companyId, issueId, actor, reason: action.reason });
        await logDelivery({ req, companyId: issue.companyId, action: "delivery.paused", issueId, unitId: summary.unitId });
        res.json(summary);
        return;
      }
      case "resume": {
        assertOperator(req);
        const summary = await delivery.resume({ companyId: issue.companyId, issueId, actor });
        await logDelivery({ req, companyId: issue.companyId, action: "delivery.resumed", issueId, unitId: summary.unitId });
        res.json(summary);
        return;
      }
      case "cancel": {
        assertOperator(req);
        const summary = await delivery.cancel({ companyId: issue.companyId, issueId, actor, reason: action.reason });
        await logDelivery({ req, companyId: issue.companyId, action: "delivery.cancelled", issueId, unitId: summary.unitId });
        res.json(summary);
        return;
      }
      case "disposition": {
        // Operator-governed classification: recording code/non_code plus the
        // disposition is what lets an issue Done without a merge receipt, so
        // only a board session may write it. The service enforces the same.
        assertOperator(req);
        const summary = await delivery.recordDisposition({
          companyId: issue.companyId,
          issueId,
          actor,
          kind: action.kind,
          reasonCode: action.reasonCode,
          message: action.message,
          owner: action.owner ?? null,
          nextAction: action.nextAction ?? null,
        });
        await logDelivery({
          req,
          companyId: issue.companyId,
          action: "delivery.disposition_recorded",
          issueId,
          unitId: summary.unitId,
          details: { kind: action.kind, reasonCode: action.reasonCode },
        });
        res.json(summary);
        return;
      }
      case "dependencies": {
        // Merge order is operator-governed: only a board session may rewire
        // needs-artifact / must-merge-after edges between delivery units.
        assertOperator(req);
        const summary = await delivery.setDependencies({
          companyId: issue.companyId,
          issueId,
          actor,
          needsArtifactIssueIds: action.needsArtifactIssueIds,
          mustMergeAfterIssueIds: action.mustMergeAfterIssueIds,
        });
        await logDelivery({
          req,
          companyId: issue.companyId,
          action: "delivery.dependencies_updated",
          issueId,
          unitId: summary.unitId,
        });
        res.json(summary);
        return;
      }
      default: {
        res.status(400).json({ error: "Unsupported delivery action" });
        return;
      }
    }
  });

  router.get("/companies/:companyId/delivery", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const projectId = typeof req.query.projectId === "string" && req.query.projectId.length > 0
      ? req.query.projectId
      : null;
    res.json({ items: await delivery.listSummaries(companyId, projectId) });
  });

  router.get("/projects/:id/delivery-policy", async (req, res) => {
    const projectId = req.params.id as string;
    const project = await accessibleProject(req, res, projectId);
    if (!project) return;
    // Contract: the response is the policy object or null.
    res.json(await delivery.getPolicy(project.companyId, projectId));
  });

  router.put("/projects/:id/delivery-policy", validate(deliveryPolicyWriteSchema), async (req, res) => {
    const projectId = req.params.id as string;
    const project = await accessibleProject(req, res, projectId);
    if (!project) return;
    assertOperator(req);
    const actor = getActorInfo(req);
    const policy = await delivery.putPolicy({
      companyId: project.companyId,
      projectId,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
      patch: req.body,
    });
    await logDelivery({
      req,
      companyId: project.companyId,
      action: "delivery.policy_updated",
      details: { projectId, version: policy.version, enabled: policy.enabled, paused: policy.paused },
    });
    res.json(policy);
  });

  router.get("/issues/:id/delivery/review", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await accessibleIssue(req, res, issueId);
    if (!issue) return;
    res.json(await delivery.readReview(issue.companyId, issueId));
  });

  router.post("/issues/:id/delivery/review", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await accessibleIssue(req, res, issueId);
    if (!issue) return;
    // A read-only refresh: the reconciler re-reads Greptile and re-evaluates
    // policy. No org-wide context mutation and no caller-supplied repo args.
    const summary = await delivery.reconcileIssue(issue.companyId, issueId);
    await logDelivery({
      req,
      companyId: issue.companyId,
      action: "delivery.review_refreshed",
      issueId,
      unitId: summary.unitId,
    });
    res.json(await delivery.readReview(issue.companyId, issueId));
  });

  router.get("/companies/:companyId/delivery/reconciliation", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const projectId = typeof req.query.projectId === "string" && req.query.projectId.length > 0
      ? req.query.projectId
      : null;
    res.json(await delivery.inventory({ companyId, projectId }));
  });

  router.post(
    "/companies/:companyId/delivery/reconciliation",
    validate(deliveryReconciliationWriteSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertOperator(req);
      const actor = getActorInfo(req);
      const item = await delivery.recordReconciliation({
        companyId,
        actor: { type: "user", id: actor.actorId, userId: actor.actorId },
        write: req.body,
      });
      await logDelivery({
        req,
        companyId,
        action: "delivery.reconciliation_recorded",
        issueId: item.issueId,
        details: { classification: item.classification, outcome: item.outcome, idempotencyKey: req.body.idempotencyKey },
      });
      res.json({ item });
    },
  );

  return router;
}
