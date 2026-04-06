import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySubscriptions, companyMemberships } from "@paperclipai/db";
import { stripeService } from "../services/stripe.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function billingRoutes(db: Db) {
  const router = Router();
  const stripe = stripeService(db);

  router.get("/billing/plans", async (_req, res) => {
    const plans = await stripe.listPlans();
    res.json(plans);
  });

  // Pre-check whether the current user can create a new company.
  // Returns structured data so the UI can show an inline subscribe flow
  // instead of hitting a raw 402 on POST /companies.
  router.get("/billing/company-creation-eligibility", async (req, res) => {
    assertBoard(req);

    const isAuthenticated = process.env.PAPERCLIP_DEPLOYMENT_MODE === "authenticated";
    if (!isAuthenticated || !req.actor.userId) {
      res.json({ canCreateCompany: true, unpaidCompanies: [] });
      return;
    }

    const userId = req.actor.userId;

    // Check for account-level unlimited subscription
    const accountSub = await stripe.getAccountSubscription(userId);
    if (accountSub && (accountSub.status === "active" || accountSub.status === "past_due")) {
      res.json({ canCreateCompany: true, hasUnlimited: true });
      return;
    }

    // Check if this user has ever had a company (including archived).
    // One free trial per user, ever. Second+ companies require payment upfront.
    // We check memberships (not subscriptions) because companies created before
    // the subscription system don't have subscription records.
    const userCompanies = await db
      .select({ companyId: companyMemberships.companyId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalId, req.actor.userId),
          eq(companyMemberships.principalType, "user"),
        ),
      );

    const hasUsedTrial = userCompanies.length > 0;

    res.json({
      canCreateCompany: !hasUsedTrial,
      reason: hasUsedTrial ? "TRIAL_USED" : undefined,
    });
  });

  router.get("/billing/account-subscription", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId!;
    const sub = await stripe.getAccountSubscription(userId);
    res.json(sub);
  });

  router.post("/billing/account/checkout", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId!;
    const { planId, successPath, cancelPath } = req.body as {
      planId: string;
      successPath?: string;
      cancelPath?: string;
    };

    const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() ?? req.headers.origin ?? "https://paperclip.inc";
    const successUrl = `${publicUrl}${successPath ?? "/account/settings?billing=success"}`;
    const cancelUrl = `${publicUrl}${cancelPath ?? "/account/settings?billing=canceled"}`;

    const url = await stripe.createAccountCheckoutSession(userId, planId, successUrl, cancelUrl);
    res.json({ url });
  });

  router.post("/billing/account/portal", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId!;
    const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() ?? req.headers.origin ?? "https://paperclip.inc";
    const returnUrl = `${publicUrl}/account/settings`;
    const url = await stripe.createAccountPortalSession(userId, returnUrl);
    res.json({ url });
  });

  router.get("/companies/:companyId/subscription", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const subscription = await stripe.getSubscription(companyId);
    res.json(subscription);
  });

  router.post("/companies/:companyId/billing/checkout", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const { planId, successPath, cancelPath } = req.body as {
      planId: string;
      successPath?: string;
      cancelPath?: string;
    };
    if (!planId) {
      res.status(400).json({ error: "planId is required" });
      return;
    }

    if (!stripe.isConfigured()) {
      res.status(400).json({ error: "Stripe is not configured" });
      return;
    }

    const origin = `${req.protocol}://${req.get("host")}`;
    const successUrl = successPath
      ? `${origin}${successPath}`
      : `${origin}/settings?billing=success`;
    const cancelUrl = cancelPath
      ? `${origin}${cancelPath}`
      : `${origin}/settings?billing=canceled`;

    const url = await stripe.createCheckoutSession(companyId, planId, successUrl, cancelUrl);
    res.json({ url });
  });

  router.post("/companies/:companyId/billing/portal", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    if (!stripe.isConfigured()) {
      res.status(400).json({ error: "Stripe is not configured" });
      return;
    }

    const origin = `${req.protocol}://${req.get("host")}`;
    const returnUrl = `${origin}/settings`;

    const url = await stripe.createPortalSession(companyId, returnUrl);
    res.json({ url });
  });

  return router;
}
