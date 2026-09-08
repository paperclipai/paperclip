import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  deliveryAcceptSchema,
  deliveryEnrollSchema,
  deliveryEvidenceIngestSchema,
  deliverySubmitSchema,
  deliveryVerdictSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { deliveryTrackingService, issueService, logActivity } from "../services/index.js";
import type { DeliveryActor } from "../services/delivery-tracking.js";
import { assertBoard, getAccessibleResource, getActorInfo } from "./authz.js";
import { forbidden } from "../errors.js";

/**
 * Delivery tracking routes.
 *
 * Every route is scoped to one issue and does nothing unless that issue has
 * been explicitly enrolled, so an instance that never enrolls anything is
 * unaffected by this surface. The server derives the acting identity and the
 * current run; a caller cannot assert either.
 */
export function deliveryRoutes(db: Db) {
  const router = Router();
  const issuesSvc = issueService(db);
  const deliverySvc = deliveryTrackingService(db);

  function resolveDeliveryActor(req: Request): DeliveryActor {
    const actor = getActorInfo(req);
    if (actor.actorType === "agent") {
      if (!actor.agentId) throw forbidden("Agent identity required");
      return { type: "agent", agentId: actor.agentId, runId: actor.runId };
    }
    return { type: "user", userId: actor.actorId, sessionId: actor.sessionId };
  }

  async function logDeliveryActivity(
    req: Request,
    input: { companyId: string; issueId: string; action: string; details: Record<string, unknown> },
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: input.action,
      entityType: "issue",
      entityId: input.issueId,
      details: input.details,
    });
  }

  router.get("/issues/:id/delivery", async (req, res) => {
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;
    res.json(await deliverySvc.snapshot(issue.id, resolveDeliveryActor(req)));
  });

  router.post("/issues/:id/delivery/enroll", validate(deliveryEnrollSchema), async (req, res) => {
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;

    const track = await deliverySvc.enroll(issue.id, req.body, resolveDeliveryActor(req));
    await logDeliveryActivity(req, {
      companyId: issue.companyId,
      issueId: issue.id,
      action: "issue.delivery_track_enrolled",
      details: {
        trackId: track.id,
        requireReview: track.requireReview,
        requireVerifiedEvidence: track.requireVerifiedEvidence,
        pinPlanRevision: track.pinPlanRevision,
        reviewerAgentIds: track.reviewerAgentIds,
      },
    });
    res.status(201).json({ track });
  });

  router.post("/issues/:id/delivery/close", async (req, res) => {
    assertBoard(req);
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;

    const track = await deliverySvc.closeTrack(issue.id, resolveDeliveryActor(req));
    if (!track) {
      res.status(404).json({ error: "No active delivery track for this issue" });
      return;
    }
    await logDeliveryActivity(req, {
      companyId: issue.companyId,
      issueId: issue.id,
      action: "issue.delivery_track_closed",
      details: { trackId: track.id },
    });
    res.json({ track });
  });

  router.post("/issues/:id/delivery/submit", validate(deliverySubmitSchema), async (req, res) => {
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;

    const submission = await deliverySvc.submit(issue.id, req.body, resolveDeliveryActor(req));
    await logDeliveryActivity(req, {
      companyId: issue.companyId,
      issueId: issue.id,
      action: "issue.delivery_candidate_submitted",
      details: {
        submissionId: submission.id,
        headSha: submission.candidate.headSha,
        baseSha: submission.candidate.baseSha,
        repositoryUrl: submission.candidate.repositoryUrl,
        planRevisionId: submission.planRevisionId,
        evidenceIds: submission.evidenceIds,
      },
    });
    res.status(201).json({ submission });
  });

  router.post("/issues/:id/delivery/verdict", validate(deliveryVerdictSchema), async (req, res) => {
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;

    const result = await deliverySvc.recordVerdict(issue.id, req.body, resolveDeliveryActor(req));
    await logDeliveryActivity(req, {
      companyId: issue.companyId,
      issueId: issue.id,
      action: "issue.delivery_verdict_recorded",
      details: {
        verdictId: result.verdict.id,
        submissionId: result.submission.id,
        candidateHeadSha: result.verdict.candidateHeadSha,
        verdict: result.verdict.verdict,
        findingCount: result.verdict.findings.length,
        evidenceIds: result.verdict.evidenceIds,
      },
    });
    res.status(201).json(result);
  });

  router.post("/issues/:id/delivery/accept", validate(deliveryAcceptSchema), async (req, res) => {
    assertBoard(req);
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;

    const acceptance = await deliverySvc.accept(issue.id, req.body, resolveDeliveryActor(req));
    await logDeliveryActivity(req, {
      companyId: issue.companyId,
      issueId: issue.id,
      action: "issue.delivery_candidate_accepted",
      details: {
        acceptanceId: acceptance.id,
        submissionId: acceptance.submissionId,
        verdictId: acceptance.verdictId,
        candidateHeadSha: acceptance.candidateHeadSha,
        planRevisionId: acceptance.planRevisionId,
        evidenceIds: acceptance.evidenceIds,
      },
    });
    res.status(201).json({ acceptance });
  });

  router.post("/issues/:id/delivery/evidence", validate(deliveryEvidenceIngestSchema), async (req, res) => {
    assertBoard(req);
    const issue = await getAccessibleResource(req, res, issuesSvc.getById(req.params.id as string), "Issue not found");
    if (!issue) return;

    const evidence = await deliverySvc.ingestEvidence(issue.id, req.body, resolveDeliveryActor(req));
    await logDeliveryActivity(req, {
      companyId: issue.companyId,
      issueId: issue.id,
      action: "issue.delivery_evidence_registered",
      details: {
        evidenceId: evidence.id,
        kind: evidence.kind,
        digest: evidence.digest,
        candidateHeadSha: evidence.candidateHeadSha,
        planRevisionId: evidence.planRevisionId,
        producerLabel: evidence.producerLabel,
      },
    });
    res.status(201).json({ evidence });
  });

  return router;
}
