export type SubscriptionStatus =
  | "trialing"
  | "awaiting_payment"
  | "active"
  | "grace"
  | "blocked"
  | "canceled"
  | "complimentary";

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "awaiting_payment",
  "active",
  "grace",
  "blocked",
  "canceled",
  "complimentary",
];

/** One row per company (spec §4). Timestamps are ISO 8601 strings. */
export interface SubscriptionRow {
  id: string;
  companyId: string;
  /** Payer / trial-eligibility anchor: company owner at row-creation time. */
  ownerUserId: string;
  customerId: string | null;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  /** When the row entered `grace` (drives the graceDays deadline). */
  graceSince: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** 0 ⇒ complimentary. */
  priceCentsOverride: number | null;
  providerSubscriptionId: string | null;
  /** Enforces one live checkout session per company. */
  openCheckoutSessionRef: string | null;
  openCheckoutUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerRow {
  id: string;
  userId: string;
  provider: string;
  providerCustomerId: string;
  hasDefaultPaymentMethod: boolean;
}

export interface LedgerInsert {
  id: string;
  idempotencyKey: string;
  type: string;
  subscriptionId: string | null;
  companyId: string | null;
  rawPayload: Record<string, unknown>;
}

export interface LedgerRow extends LedgerInsert {
  appliedAt: string | null;
  createdAt: string;
}

/** Internal event vocabulary consumed by the pure state machine. */
export type BillingEvent =
  | { type: "clock" }
  | { type: "checkout.completed"; sessionRef: string; subRef: string; periodEnd: string }
  | { type: "one_click.activated"; subRef: string | null; periodEnd: string }
  | { type: "payment.succeeded"; subRef: string; periodEnd: string }
  | { type: "payment.failed"; subRef: string }
  | { type: "subscription.canceled"; subRef: string }
  | { type: "owner.cancel_at_period_end" }
  | { type: "owner.resume" }
  | { type: "admin.set_price_override"; priceCents: number | null }
  | { type: "admin.extend_trial"; trialEndsAt: string }
  | { type: "company.deleted" };

export type StandingCommand =
  | { kind: "clear" }
  | {
      kind: "set";
      status: "active" | "grace" | "blocked";
      reason: string;
      message: string;
      actionUrl?: string;
    };

/** User-presentable, typed error surfaced as 4xx by api routes and bridge handlers. */
export class BillingUserError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BillingUserError";
    this.code = code;
  }
}
