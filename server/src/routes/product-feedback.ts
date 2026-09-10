import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  productFeedbackSubmissionRequestSchema,
  type ProductFeedbackCapability,
  type ProductFeedbackRelayRequest,
} from "@paperclipai/shared";
import { logActivity } from "../services/activity-log.js";
import {
  ProductFeedbackRelayError,
  type ProductFeedbackRelay,
} from "../services/product-feedback-relay.js";
import { getActorInfo, hasCompanyAccess } from "./authz.js";

export function productFeedbackRoutes(opts: {
  db: Db;
  capability: ProductFeedbackCapability;
  relay?: ProductFeedbackRelay;
}) {
  const router = Router();

  router.post("/product-feedback", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");

    if (!opts.capability.enabled) {
      res.status(404).json({ code: "product_feedback_disabled", error: "Product feedback is not enabled." });
      return;
    }

    if (
      req.actor.type !== "board"
      || (req.actor.source !== "session" && req.actor.source !== "local_implicit")
    ) {
      res.status(403).json({ code: "board_session_required", error: "A board session is required." });
      return;
    }

    const parsed = productFeedbackSubmissionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: "invalid_product_feedback_request",
        error: "The feedback request is invalid.",
      });
      return;
    }
    if (!hasCompanyAccess(req, parsed.data.companyId)) {
      res.status(404).json({ code: "company_not_found", error: "Company not found." });
      return;
    }

    if (!opts.relay) {
      res.status(503).json({
        code: "product_feedback_unavailable",
        error: "Feedback delivery is not available on this instance yet. Your draft is still here.",
      });
      return;
    }

    const relayRequest: ProductFeedbackRelayRequest = {
      schemaVersion: parsed.data.schemaVersion,
      submissionId: parsed.data.submissionId,
      submittedAt: parsed.data.submittedAt,
      feedback: parsed.data.feedback,
      followUpConsent: parsed.data.followUpConsent,
      ...(parsed.data.reporterEmail ? { reporterEmail: parsed.data.reporterEmail } : {}),
      context: parsed.data.context,
    };

    try {
      const actor = getActorInfo(req);
      await logActivity(opts.db, {
        companyId: parsed.data.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "product_feedback.submission_requested",
        entityType: "product_feedback_submission",
        entityId: parsed.data.submissionId,
        details: {
          destination: "paperclip_telemetry_backend",
          followUpConsent: parsed.data.followUpConsent,
          diagnosticCount: parsed.data.context.diagnostics.length,
        },
      });
      const receipt = await opts.relay.submit(relayRequest);
      res.status(202).json(receipt);
    } catch (error) {
      const status = error instanceof ProductFeedbackRelayError && error.status === 429 ? 429 : 502;
      res.status(status).json({
        code: status === 429 ? "product_feedback_rate_limited" : "product_feedback_delivery_failed",
        error: status === 429
          ? "Too many feedback requests. Your draft is still here. Try again shortly."
          : "Feedback could not be sent. Your draft is still here. Try again.",
      });
    }
  });

  return router;
}
