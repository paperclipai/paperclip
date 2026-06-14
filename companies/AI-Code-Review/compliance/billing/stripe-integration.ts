import Stripe from "stripe"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-11-20.acacia",
})

export interface PlanConfig {
  id: string
  name: string
  monthlyReviewLimit: number
  seatLimit: number
  stripePriceId: string
}

export const PLANS: Record<string, PlanConfig> = {
  free: {
    id: "free",
    name: "Free",
    monthlyReviewLimit: 100,
    seatLimit: 5,
    stripePriceId: "", // free tier has no Stripe price
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyReviewLimit: 10_000,
    seatLimit: 25,
    stripePriceId: "price_pro_monthly",
  },
  team: {
    id: "team",
    name: "Team",
    monthlyReviewLimit: 50_000,
    seatLimit: 100,
    stripePriceId: "price_team_monthly",
  },
}

export async function createCheckoutSession(
  orgId: string,
  planId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const plan = PLANS[planId]
  if (!plan || !plan.stripePriceId) {
    throw new Error(`Invalid or free plan: ${planId}`)
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    client_reference_id: orgId,
    metadata: { orgId, planId },
    success_url: successUrl,
    cancel_url: cancelUrl,
  })

  return session.url!
}

export async function handleWebhook(
  body: Buffer,
  signature: string,
): Promise<void> {
  const event = stripe.webhooks.constructEvent(
    body,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!,
  )

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session
      // Activate subscription for org
      break
    }
    case "invoice.payment_failed": {
      // Send payment failure notification to org admin
      break
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      // Sync subscription status with local DB
      break
    }
  }
}

export async function getUsage(orgId: string): Promise<{
  current: number
  limit: number
  percentage: number
}> {
  // Query billing_usage table for current period
  // Compare against plan limit
  // Return usage stats
  return { current: 0, limit: 100, percentage: 0 }
}
