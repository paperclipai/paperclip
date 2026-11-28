import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { createCheckoutSessionSchema } from "@paperclipai/shared";
import { badRequest, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import {
  getStripePriceId,
  getStripePriceLookupKey,
  PAID_PLAN_TIERS,
  type PaidPlanTier,
} from "../services/planLimits.js";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

async function createStripeCheckoutSession(opts: {
  secretKey: string;
  plan: PaidPlanTier;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  const priceId = getStripePriceId(opts.plan);
  const lookupKey = getStripePriceLookupKey(opts.plan);

  const params = new URLSearchParams({
    mode: "subscription",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    "line_items[0][quantity]": "1",
  });

  if (priceId) {
    params.set("line_items[0][price]", priceId);
  } else {
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][recurring][interval]", "month");
    params.set("line_items[0][price_data][product_data][name]", `Paperclip ${opts.plan.charAt(0).toUpperCase() + opts.plan.slice(1)}`);
    params.set("line_items[0][price_data][lookup_key]", lookupKey);
    params.set("line_items[0][price_data][unit_amount]", "0");
  }

  const response = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${opts.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(`Stripe error: ${error?.error?.message ?? response.statusText}`);
  }

  const session = await response.json() as { url: string };
  return { url: session.url };
}

export function billingRoutes(db: Db) {
  const router = Router();

  router.post(
    "/v1/orgs/:slug/billing/checkout",
    validate(createCheckoutSessionSchema),
    async (req, res) => {
      assertBoard(req);

      const stripeSecretKey = process.env["STRIPE_SECRET_KEY"];
      if (!stripeSecretKey) {
        throw badRequest("Stripe is not configured on this instance");
      }

      const slug = req.params["slug"] as string;
      const [company] = await db
        .select()
        .from(companies)
        .where(eq(companies.issuePrefix, slug.toUpperCase()));

      if (!company) {
        throw notFound(`Organization '${slug}' not found`);
      }

      assertCompanyAccess(req, company.id);

      const { plan, successUrl, cancelUrl } = req.body as {
        plan: PaidPlanTier;
        successUrl?: string;
        cancelUrl?: string;
      };

      if (!PAID_PLAN_TIERS.includes(plan)) {
        throw badRequest(`Invalid plan. Must be one of: ${PAID_PLAN_TIERS.join(", ")}`);
      }

      const appBase =
        process.env["PAPERCLIP_AUTH_PUBLIC_BASE_URL"] ??
        process.env["BETTER_AUTH_BASE_URL"] ??
        `${req.protocol}://${req.get("host")}`;

      const resolvedSuccessUrl =
        successUrl ?? `${appBase}/${company.issuePrefix}/settings/billing?checkout=success`;
      const resolvedCancelUrl =
        cancelUrl ?? `${appBase}/${company.issuePrefix}/settings/billing?checkout=cancelled`;

      const session = await createStripeCheckoutSession({
        secretKey: stripeSecretKey,
        plan,
        successUrl: resolvedSuccessUrl,
        cancelUrl: resolvedCancelUrl,
      });

      res.status(201).json({ url: session.url });
    },
  );

  return router;
}
