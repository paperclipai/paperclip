/**
 * Provider port — spec §5 verbatim (typed transliteration; the spec block uses
 * TS shorthand without types). Stripe-shaped so the future adapter is mechanical.
 *
 * Rules (every provider):
 * - Webhook signatures are always verified; unverifiable ⇒ throw, never a state change.
 * - The webhook handler 200-acks only after ledger insert; unique idempotency_key
 *   makes duplicates no-ops.
 * - Provider outage never changes standing — only explicit events and the sweep do.
 * - Redirect/query params are never trusted for state; resolveCheckout is a
 *   server-side provider query, and the webhook remains the source of truth.
 */
export type ParsedProviderEvent =
  | { type: "checkout.completed"; sessionRef: string; subRef: string; periodEnd: string }
  | { type: "payment.succeeded"; subRef: string; periodEnd: string }
  | { type: "payment.failed"; subRef: string }
  | { type: "subscription.canceled"; subRef: string };

export interface BillingProvider {
  ensureCustomer(user: { id: string; email: string; name: string }): Promise<{ customerId: string }>;

  createCheckout(req: {
    customerId: string;
    companyId: string;
    priceCents: number;
    currency: string;
    /** subscribe-during-trial keeps remaining trial */
    trialEndsAt?: Date;
    /** successUrl carries {SESSION_REF} */
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionRef: string }>;

  /** instant success-page confirmation */
  resolveCheckout?(sessionRef: string): Promise<"complete" | "open" | "expired">;

  /** SCA fallback */
  subscribeWithSavedMethod(req: {
    customerId: string;
    companyId: string;
    priceCents: number;
    currency: string;
    trialEndsAt?: Date;
  }): Promise<{ status: "active" } | { status: "requires_action"; url: string }>;

  createPortal?(customerId: string): Promise<{ url: string }>;

  cancelAtPeriodEnd(subRef: string): Promise<void>;
  resume(subRef: string): Promise<void>;
  /** company deletion */
  cancelNow(subRef: string): Promise<void>;

  verifyAndParseWebhook(
    headers: Record<string, string | string[]>,
    rawBody: string,
  ): ParsedProviderEvent;
}
