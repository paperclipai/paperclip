import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createSubscriptionSchema,
  createCheckoutSessionSchema,
  updateSubscriptionSchema,
  reportUsageSchema,
} from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { billingService } from "../services/billing.js";
import { pricingExperimentService } from "../services/pricing-experiment.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Stripe webhook route — mounted on main app BEFORE auth middleware.
 * Relies on Stripe signature verification instead of bearer/auth.
 */
export function billingWebhookRoute(db: Db) {
  const router = Router();
  const billing = billingService(db);

  router.post("/webhook", async (req, res, next) => {
    try {
      const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;
      if (!rawBody) {
        throw badRequest("Missing raw body for webhook verification");
      }
      const signature = req.headers["stripe-signature"];
      const sigStr = Array.isArray(signature) ? signature[0] : signature;
      if (!sigStr) {
        throw badRequest("Missing Stripe signature header");
      }
      const result = await billing.handleWebhook(rawBody.toString("utf8"), sigStr);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Authenticated billing API routes — mounted inside the API router (behind auth+board guard).
 */
export function billingRoutes(db: Db) {
  const router = Router();
  const experiment = pricingExperimentService(db);
  const billing = billingService(db, experiment);

  const requireBoardUser = (req: Parameters<typeof assertCompanyAccess>[0]): void => {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user context required");
  };

  /**
   * GET /api/companies/:companyId/billing/tiers
   * List available subscription tiers
   */
  router.get("/companies/:companyId/billing/tiers", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const tiers = await billing.listTiers(companyId);
      res.json(tiers);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/companies/:companyId/billing/subscription
   * Get current subscription details
   */
  router.get("/companies/:companyId/billing/subscription", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const subscription = await billing.getSubscription(companyId);
      res.json(subscription);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/companies/:companyId/billing/subscription
   * Create or update subscription (direct — for admin use; does not collect card details)
   */
  router.post(
    "/companies/:companyId/billing/subscription",
    validate(createSubscriptionSchema),
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        requireBoardUser(req);
        const subscription = await billing.createOrUpdateSubscription(
          companyId,
          req.body,
        );
        res.status(201).json(subscription);
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * POST /api/companies/:companyId/billing/create-checkout-session
   * Create a Stripe Checkout Session to collect payment method before subscription
   */
  router.post(
    "/companies/:companyId/billing/create-checkout-session",
    validate(createCheckoutSessionSchema),
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        requireBoardUser(req);
        const result = await billing.createCheckoutSession(companyId, req.body);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * PATCH /api/companies/:companyId/billing/subscription
   * Update subscription (change tier or billing period)
   */
  router.patch(
    "/companies/:companyId/billing/subscription",
    validate(updateSubscriptionSchema),
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        requireBoardUser(req);
        const subscription = await billing.createOrUpdateSubscription(
          companyId,
          {
            tierId: req.body.tierId,
            billingPeriod: req.body.billingPeriod ?? "monthly",
          },
        );
        res.json(subscription);
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * POST /api/companies/:companyId/billing/subscription/cancel
   * Cancel subscription at period end
   */
  router.post("/companies/:companyId/billing/subscription/cancel", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      requireBoardUser(req);
      const result = await billing.cancelSubscription(companyId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/companies/:companyId/billing/subscription/reactivate
   * Reactivate a subscription scheduled for cancellation
   */
  router.post("/companies/:companyId/billing/subscription/reactivate", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      requireBoardUser(req);
      const result = await billing.reactivateSubscription(companyId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/companies/:companyId/billing/usage
   * Get current billing period usage
   */
  router.get("/companies/:companyId/billing/usage", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const usage = await billing.getUsage(companyId);
      res.json(usage);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/companies/:companyId/billing/usage
   * Report usage for a metric
   */
  router.post(
    "/companies/:companyId/billing/usage",
    validate(reportUsageSchema),
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        requireBoardUser(req);
        const result = await billing.reportUsage(companyId, req.body);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * GET /api/companies/:companyId/billing/invoices
   * List invoices
   */
  router.get("/companies/:companyId/billing/invoices", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const invoices = await billing.listInvoices(companyId);
      res.json(invoices);
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/companies/:companyId/billing/invoices/sync
   * Sync invoices from Stripe
   */
  router.post("/companies/:companyId/billing/invoices/sync", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      requireBoardUser(req);
      const invoices = await billing.syncInvoicesFromStripe(companyId);
      res.json(invoices);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/companies/:companyId/billing/overview
   * Get billing overview (subscription + usage + invoices + total spent)
   */
  router.get("/companies/:companyId/billing/overview", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const overview = await billing.getBillingOverview(companyId);
      res.json(overview);
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/companies/:companyId/billing/experiment-variant
   * Get the A/B pricing experiment variant assigned to this company.
   */
  router.get("/companies/:companyId/billing/experiment-variant", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const variant = await billing.getExperimentVariant(companyId);
      const config = experiment.loadConfig();
      res.json({ variant, enabled: config.enabled });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/companies/:companyId/billing/experiment-results
   * Get experiment results summary (board-only).
   */
  router.get("/companies/:companyId/billing/experiment-results", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      requireBoardUser(req);
      const results = await billing.getExperimentResults();
      res.json(results);
    } catch (err) {
      next(err);
    }
  });

  return router;
}