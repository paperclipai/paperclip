import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySubscriptions, companyMemberships, companies } from "@paperclipai/db";
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

    const userSubs = await db
      .select({
        status: companySubscriptions.status,
        companyId: companySubscriptions.companyId,
        companyName: companies.name,
        issuePrefix: companies.issuePrefix,
      })
      .from(companySubscriptions)
      .innerJoin(
        companyMemberships,
        eq(companySubscriptions.companyId, companyMemberships.companyId),
      )
      .innerJoin(companies, eq(companySubscriptions.companyId, companies.id))
      .where(
        and(
          eq(companyMemberships.principalId, req.actor.userId),
          eq(companyMemberships.principalType, "user"),
        ),
      );

    const unpaidCompanies = userSubs
      .filter((s) => s.status !== "active" && s.status !== "free")
      .map((s) => ({
        companyId: s.companyId,
        companyName: s.companyName,
        status: s.status,
        issuePrefix: s.issuePrefix,
      }));

    res.json({
      canCreateCompany: unpaidCompanies.length === 0,
      reason: unpaidCompanies.length > 0 ? "UNPAID_COMPANIES" : undefined,
      unpaidCompanies,
    });
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
