import Stripe from "stripe";
import { Resend } from "resend";
import { eq, and, asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySubscriptions,
  subscriptionPlans,
  companies,
  companyMemberships,
  authUsers,
  agents,
} from "@paperclipai/db";
import type { SubscriptionPlan, CompanySubscription } from "@paperclipai/shared";

let _stripe: Stripe | null = null;

function getStripe(): Stripe | null {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  _stripe = new Stripe(key);
  return _stripe;
}

/**
 * Send a billing-related notification email directly via Resend.
 * Self-contained so the webhook handler doesn't need the EmailSender wired in.
 */
async function sendBillingEmail(
  db: Db,
  stripeCustomerId: string,
  subject: string,
  body: string,
): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  if (!resendApiKey) {
    console.warn(`[stripe] Cannot send billing email: RESEND_API_KEY not set. Subject: ${subject}`);
    return;
  }

  try {
    // Look up the company subscription to find the companyId
    const subRow = await db
      .select({ companyId: companySubscriptions.companyId })
      .from(companySubscriptions)
      .where(eq(companySubscriptions.stripeCustomerId, stripeCustomerId))
      .then((rows) => rows[0] ?? null);

    if (!subRow) {
      console.warn(`[stripe] No subscription found for customer ${stripeCustomerId}, cannot send billing email`);
      return;
    }

    // Look up company name
    const company = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, subRow.companyId))
      .then((rows) => rows[0] ?? null);

    const companyName = company?.name ?? "your company";
    const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() ?? "https://paperclip.inc";

    // Find active members of the company to email
    const members = await db
      .select({ email: authUsers.email })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
      .where(
        and(
          eq(companyMemberships.companyId, subRow.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      );

    if (members.length === 0) {
      console.warn(`[stripe] No active members found for company ${subRow.companyId}, cannot send billing email`);
      return;
    }

    const emailFrom = process.env.PAPERCLIP_EMAIL_FROM?.trim() || "Paperclip <noreply@paperclip.inc>";
    const resend = new Resend(resendApiKey);

    // Interpolate company name and public URL into the body
    const interpolatedBody = body
      .replace(/\{companyName\}/g, companyName)
      .replace(/\{publicUrl\}/g, publicUrl);

    const recipientEmails = members.map((m) => m.email);

    await resend.emails.send({
      from: emailFrom,
      to: recipientEmails,
      subject,
      text: interpolatedBody,
    });

    console.info(`[stripe] Sent billing email "${subject}" to ${recipientEmails.length} recipient(s) for company ${subRow.companyId}`);
  } catch (err) {
    // Never let email failures break the webhook handler
    console.error(`[stripe] Failed to send billing email: ${err}`);
  }
}

function parseFeatures(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function toPlanDto(row: typeof subscriptionPlans.$inferSelect): SubscriptionPlan {
  return {
    id: row.id,
    name: row.name,
    monthlyPriceCents: row.monthlyPriceCents,
    maxAgents: row.maxAgents,
    maxCompanies: row.maxCompanies,
    maxMonthlyCostCents: row.maxMonthlyCostCents,
    features: parseFeatures(row.features),
    sortOrder: row.sortOrder,
  };
}

export function stripeService(db: Db) {
  return {
    isConfigured(): boolean {
      return !!process.env.STRIPE_SECRET_KEY?.trim();
    },

    async listPlans(): Promise<SubscriptionPlan[]> {
      const rows = await db
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.active, true))
        .orderBy(asc(subscriptionPlans.sortOrder));
      return rows.map(toPlanDto);
    },

    async getSubscription(companyId: string): Promise<CompanySubscription | null> {
      const rows = await db
        .select({
          sub: companySubscriptions,
          plan: subscriptionPlans,
        })
        .from(companySubscriptions)
        .innerJoin(subscriptionPlans, eq(companySubscriptions.planId, subscriptionPlans.id))
        .where(eq(companySubscriptions.companyId, companyId));

      const row = rows[0];
      if (!row) return null;

      return {
        id: row.sub.id,
        companyId: row.sub.companyId,
        planId: row.sub.planId,
        plan: toPlanDto(row.plan),
        status: row.sub.status as CompanySubscription["status"],
        currentPeriodStart: row.sub.currentPeriodStart?.toISOString() ?? null,
        currentPeriodEnd: row.sub.currentPeriodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: row.sub.cancelAtPeriodEnd,
        trialEndsAt: row.sub.trialEndsAt?.toISOString() ?? null,
      };
    },

    async getOrCreateCustomer(companyId: string, companyName: string): Promise<string> {
      const existing = await db
        .select({ stripeCustomerId: companySubscriptions.stripeCustomerId })
        .from(companySubscriptions)
        .where(eq(companySubscriptions.companyId, companyId))
        .then((rows) => rows[0] ?? null);

      if (existing?.stripeCustomerId) {
        return existing.stripeCustomerId;
      }

      const stripe = getStripe();
      if (!stripe) throw new Error("Stripe is not configured");

      const customer = await stripe.customers.create({ name: companyName });

      // Upsert into company_subscriptions
      const existingRow = await db
        .select({ id: companySubscriptions.id })
        .from(companySubscriptions)
        .where(eq(companySubscriptions.companyId, companyId))
        .then((rows) => rows[0] ?? null);

      if (existingRow) {
        await db
          .update(companySubscriptions)
          .set({
            stripeCustomerId: customer.id,
            updatedAt: new Date(),
          })
          .where(eq(companySubscriptions.companyId, companyId));
      } else {
        // Get or create a default free plan
        const freePlan = await db
          .select()
          .from(subscriptionPlans)
          .where(eq(subscriptionPlans.id, "free"))
          .then((rows) => rows[0] ?? null);

        const planId = freePlan ? "free" : (await db
          .select({ id: subscriptionPlans.id })
          .from(subscriptionPlans)
          .orderBy(asc(subscriptionPlans.sortOrder))
          .then((rows) => rows[0]?.id ?? "free"));

        await db.insert(companySubscriptions).values({
          companyId,
          planId,
          stripeCustomerId: customer.id,
          status: "free",
        });
      }

      return customer.id;
    },

    async createCheckoutSession(
      companyId: string,
      planId: string,
      successUrl: string,
      cancelUrl: string,
    ): Promise<string> {
      const stripe = getStripe();
      if (!stripe) throw new Error("Stripe is not configured");

      const plan = await db
        .select()
        .from(subscriptionPlans)
        .where(and(eq(subscriptionPlans.id, planId), eq(subscriptionPlans.active, true)))
        .then((rows) => rows[0] ?? null);

      if (!plan || !plan.stripePriceId) {
        throw new Error("Plan not found or not available for purchase");
      }

      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw new Error("Company not found");

      const customerId = await this.getOrCreateCustomer(companyId, company.name);

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          companyId,
          planId,
        },
      });

      if (!session.url) throw new Error("Failed to create checkout session");
      return session.url;
    },

    async createPortalSession(companyId: string, returnUrl: string): Promise<string> {
      const stripe = getStripe();
      if (!stripe) throw new Error("Stripe is not configured");

      const sub = await db
        .select({ stripeCustomerId: companySubscriptions.stripeCustomerId })
        .from(companySubscriptions)
        .where(eq(companySubscriptions.companyId, companyId))
        .then((rows) => rows[0] ?? null);

      if (!sub?.stripeCustomerId) {
        throw new Error("No billing account found for this company");
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: returnUrl,
      });

      return session.url;
    },

    async handleWebhookEvent(event: Stripe.Event): Promise<void> {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const companyId = session.metadata?.companyId;
          const planId = session.metadata?.planId;
          if (!companyId || !planId) break;

          const stripeSubscriptionId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id ?? null;

          await db
            .update(companySubscriptions)
            .set({
              planId,
              stripeSubscriptionId,
              status: "active",
              trialEndsAt: null,
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.companyId, companyId));

          // Resume agents that were paused by the system (subscription expiry)
          await resumeSystemPausedAgents(db, companyId);
          break;
        }

        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

          await db
            .update(companySubscriptions)
            .set({
              status: sub.status === "active" ? "active"
                : sub.status === "past_due" ? "past_due"
                : sub.status === "trialing" ? "trialing"
                : sub.status === "canceled" ? "canceled"
                : sub.status,
              currentPeriodStart: new Date(sub.current_period_start * 1000),
              currentPeriodEnd: new Date(sub.current_period_end * 1000),
              cancelAtPeriodEnd: sub.cancel_at_period_end,
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.stripeCustomerId, customerId));
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

          // Keep the current plan (don't revert to "free" in cloud mode)
          // so the user can easily resubscribe from the billing page.
          await db
            .update(companySubscriptions)
            .set({
              status: "canceled",
              stripeSubscriptionId: null,
              cancelAtPeriodEnd: false,
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.stripeCustomerId, customerId));

          await sendBillingEmail(
            db,
            customerId,
            "Your Paperclip subscription has been canceled",
            "Your subscription for {companyName} has been canceled and your account has been reverted to the free plan.\n\nIf this was a mistake, you can resubscribe at {publicUrl}/billing.\n\nIf you have any questions, please reach out to our support team.",
          );
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
          if (!customerId) break;

          await db
            .update(companySubscriptions)
            .set({
              status: "past_due",
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.stripeCustomerId, customerId));

          await sendBillingEmail(
            db,
            customerId,
            "Payment failed for your Paperclip subscription",
            "We couldn't process your payment for {companyName}. Please update your billing information at {publicUrl}/billing.\n\nIf payment continues to fail, your subscription may be canceled.",
          );
          break;
        }

        case "invoice.paid": {
          const invoice = event.data.object as Stripe.Invoice;
          const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
          if (!customerId) break;

          await db
            .update(companySubscriptions)
            .set({
              status: "active",
              updatedAt: new Date(),
            })
            .where(eq(companySubscriptions.stripeCustomerId, customerId));

          // Resume agents if they were paused due to subscription issues
          const subRow = await db
            .select({ companyId: companySubscriptions.companyId })
            .from(companySubscriptions)
            .where(eq(companySubscriptions.stripeCustomerId, customerId))
            .then((rows) => rows[0] ?? null);
          if (subRow) {
            await resumeSystemPausedAgents(db, subRow.companyId);
          }
          break;
        }
      }
    },
  };
}

/**
 * Resume agents that were paused by the system due to subscription expiry.
 * Only resumes agents with pauseReason "system" to avoid unpausing
 * manually paused or budget-paused agents.
 */
async function resumeSystemPausedAgents(db: Db, companyId: string): Promise<void> {
  const resumed = await db
    .update(agents)
    .set({
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.status, "paused"),
        eq(agents.pauseReason, "system"),
      ),
    )
    .returning({ id: agents.id });

  if (resumed.length > 0) {
    console.info(
      `[stripe] Resumed ${resumed.length} system-paused agent(s) for company ${companyId}`,
    );
  }
}
