import { Router } from "express";
import type { Db } from "@ironworksai/db";
import {
  billingService,
  verifyPolarWebhookSignature,
  PLAN_DEFINITIONS,
  type PlanTier,
} from "../services/billing.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";

const VALID_TIERS: PlanTier[] = ["starter", "growth", "business"];

export function billingRoutes(db: Db) {
  const router = Router();
  const svc = billingService(db);

  // GET /companies/:companyId/billing/subscription
  router.get("/companies/:companyId/billing/subscription", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const sub = await svc.getOrCreateSubscription(companyId);
    const plan = PLAN_DEFINITIONS[sub.planTier];
    const projectCount = await svc.getProjectCount(companyId);
    const storageUsedBytes = await svc.getStorageUsageBytes(companyId);

    res.json({
      subscription: sub,
      plan,
      usage: {
        projects: projectCount,
        storageBytes: storageUsedBytes,
      },
    });
  });

  // POST /companies/:companyId/billing/checkout
  router.post("/companies/:companyId/billing/checkout", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { planTier, successUrl, cancelUrl } = req.body as {
      planTier?: string;
      successUrl?: string;
      cancelUrl?: string;
    };

    if (!planTier || !VALID_TIERS.includes(planTier as PlanTier)) {
      throw badRequest(`Invalid planTier. Must be one of: ${VALID_TIERS.join(", ")}`);
    }
    if (!successUrl || !cancelUrl) {
      throw badRequest("successUrl and cancelUrl are required");
    }
    // SEC-TAINT-008: Validate redirect URLs are relative paths (same-origin)
    // to prevent open redirect via Polar checkout flow
    for (const url of [successUrl, cancelUrl]) {
      if (typeof url === "string" && (url.startsWith("http") || url.startsWith("//"))) {
        throw badRequest("Redirect URLs must be relative paths, not absolute URLs");
      }
    }

    const url = await svc.createCheckoutSession(
      companyId,
      planTier as PlanTier,
      successUrl,
      cancelUrl,
    );
    res.json({ url });
  });

  // POST /companies/:companyId/billing/portal
  router.post("/companies/:companyId/billing/portal", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { returnUrl } = req.body as { returnUrl?: string };
    if (!returnUrl) {
      throw badRequest("returnUrl is required");
    }

    const url = await svc.createCustomerPortalSession(companyId, returnUrl);
    res.json({ url });
  });

  return router;
}

/**
 * Polar webhook route -- mounted separately from the API router
 * because it must NOT require auth (Polar signs the requests itself).
 */
export function polarWebhookRoute(db: Db) {
  const router = Router();
  const svc = billingService(db);

  router.post("/api/webhooks/polar", async (req, res) => {
    // Standard Webhooks / Svix uses three headers for signature verification.
    // Accept both the canonical "webhook-*" names and the legacy "svix-*" aliases.
    const webhookId =
      (req.headers["webhook-id"] as string | undefined) ??
      (req.headers["svix-id"] as string | undefined);
    const webhookTimestamp =
      (req.headers["webhook-timestamp"] as string | undefined) ??
      (req.headers["svix-timestamp"] as string | undefined);
    const webhookSignature =
      (req.headers["webhook-signature"] as string | undefined) ??
      (req.headers["svix-signature"] as string | undefined);

    if (!webhookId || !webhookTimestamp || !webhookSignature) {
      res.status(400).json({
        error: "Missing required Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature)",
      });
      return;
    }

    try {
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        res.status(400).json({ error: "Missing raw body — ensure express.json verify is configured" });
        return;
      }
      const event = verifyPolarWebhookSignature(rawBody, {
        webhookId,
        webhookTimestamp,
        webhookSignature,
      });
      await svc.handleWebhook(event);
      res.json({ received: true });
    } catch (err) {
      logger.error({ err }, "Polar webhook verification or processing failed");
      res.status(400).json({
        error: err instanceof Error ? err.message : "Webhook processing failed",
      });
    }
  });

  return router;
}
