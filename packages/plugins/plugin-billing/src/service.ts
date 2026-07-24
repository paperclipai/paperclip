import { randomUUID } from "node:crypto";
import { applyBillingEvent, type ApplyDeps } from "./apply.js";
import { BILLING_PAGE_PATH } from "./constants.js";
import { ensureSubscriptionForCompany, type OwnerResolver } from "./creation.js";
import { BillingUserError, type SubscriptionRow, type SubscriptionStatus } from "./domain.js";
import { formatAmount } from "./format.js";
import { applyStandingCommand } from "./standing.js";
import { addDaysIso, expectedStanding } from "./state-machine.js";

export interface BillingSummary {
  companyId: string;
  status: SubscriptionStatus;
  priceCents: number;
  currency: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  graceDeadline: string | null;
  hasDefaultPaymentMethod: boolean;
  openCheckoutSessionRef: string | null;
  openCheckoutUrl: string | null;
  events: Array<{ type: string; createdAt: string; appliedAt: string | null }>;
}

export interface CreationDisclosure {
  requiresSubscription: boolean;
  trialAvailable: boolean;
  trialDays: number;
  priceCents: number;
  currency: string;
  message: string;
}

export interface AdminCompanyRow {
  companyId: string;
  status: SubscriptionStatus;
  ownerUserId: string;
  priceCents: number;
  priceCentsOverride: number | null;
  currency: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasOpenCheckout: boolean;
}

export interface ServiceDeps extends ApplyDeps {
  owners: OwnerResolver;
}

export class BillingService {
  constructor(private readonly deps: ServiceDeps) {}

  private priceCents(sub: SubscriptionRow): number {
    return sub.priceCentsOverride ?? this.deps.config.defaultMonthlyPriceCents;
  }

  private async ensure(companyId: string): Promise<SubscriptionRow> {
    return ensureSubscriptionForCompany(this.deps, companyId);
  }

  private async clearOpenCheckout(sub: SubscriptionRow): Promise<SubscriptionRow> {
    const ledgerId = randomUUID();
    await this.deps.store.insertLedgerEvent({
      id: ledgerId,
      idempotencyKey: `checkout-expired:${sub.openCheckoutSessionRef}`,
      type: "checkout.expired",
      subscriptionId: sub.id,
      companyId: sub.companyId,
      rawPayload: { sessionRef: sub.openCheckoutSessionRef },
    });
    await this.deps.store.markLedgerApplied(ledgerId, this.deps.now().toISOString());
    const cleared = { ...sub, openCheckoutSessionRef: null, openCheckoutUrl: null, updatedAt: this.deps.now().toISOString() };
    await this.deps.store.updateSubscription(cleared);
    return cleared;
  }

  async summary(companyId: string): Promise<BillingSummary> {
    const sub = await this.ensure(companyId);
    const customer = await this.deps.store.getCustomerByUser(this.deps.config.provider, sub.ownerUserId);
    const events = await this.deps.store.listLedgerEventsForCompany(companyId, 25);
    return {
      companyId,
      status: sub.status,
      priceCents: this.priceCents(sub),
      currency: this.deps.config.currency,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      graceDeadline: sub.graceSince ? addDaysIso(sub.graceSince, this.deps.config.graceDays) : null,
      hasDefaultPaymentMethod: customer?.hasDefaultPaymentMethod ?? false,
      openCheckoutSessionRef: sub.openCheckoutSessionRef,
      openCheckoutUrl: sub.openCheckoutUrl,
      events: events.map((event) => ({ type: event.type, createdAt: event.createdAt, appliedAt: event.appliedAt })),
    };
  }

  /** Price disclosure for the create-company dialog (spec §6.3): no surprises post-create. */
  async creationSummary(actorUserId: string): Promise<CreationDisclosure> {
    const config = this.deps.config;
    const price = formatAmount(config.defaultMonthlyPriceCents, config.currency);
    const trialAvailable = config.trialDays > 0
      && (config.trialPolicy === "every-company"
        || (config.trialPolicy === "first-company-per-owner" && !(await this.deps.store.ownerHadTrial(actorUserId))));
    return {
      requiresSubscription: !trialAvailable,
      trialAvailable,
      trialDays: config.trialDays,
      priceCents: config.defaultMonthlyPriceCents,
      currency: config.currency,
      message: trialAvailable
        ? `Your new company starts with a ${config.trialDays}-day free trial, then ${price}/month.`
        : `New companies require a ${price}/month subscription.`,
    };
  }

  /** Idempotent: one live checkout session per company (spec §6.3). */
  async createCheckout(companyId: string): Promise<{ url: string; sessionRef: string }> {
    let sub = await this.ensure(companyId);
    if (sub.status === "complimentary") throw new BillingUserError("complimentary", "This company is complimentary — no subscription needed.");
    if (sub.status === "active") throw new BillingUserError("already_subscribed", "This company already has an active subscription.");

    if (sub.openCheckoutSessionRef && sub.openCheckoutUrl) {
      const state = this.deps.provider.resolveCheckout
        ? await this.deps.provider.resolveCheckout(sub.openCheckoutSessionRef)
        : "open";
      if (state === "open") return { url: sub.openCheckoutUrl, sessionRef: sub.openCheckoutSessionRef };
      if (state === "complete") throw new BillingUserError("checkout_confirming", "Your payment is being confirmed — this page updates automatically.");
      sub = await this.clearOpenCheckout(sub);
    }

    let customer = await this.deps.store.getCustomerByUser(this.deps.config.provider, sub.ownerUserId);
    if (!customer) {
      const { customerId } = await this.deps.provider.ensureCustomer({
        id: sub.ownerUserId,
        // The SDK exposes no user email/name; the stub ignores them (see STRIPE_ADAPTER.md).
        email: `user-${sub.ownerUserId}@billing.invalid`,
        name: sub.ownerUserId,
      });
      customer = { id: randomUUID(), userId: sub.ownerUserId, provider: this.deps.config.provider, providerCustomerId: customerId, hasDefaultPaymentMethod: false };
      // A concurrent createCheckout for the same owner may have minted+stored a
      // different id first; upsert returns the SURVIVING stored id, so adopt it
      // instead of our local one before it flows into the subscription's FK.
      const storedId = await this.deps.store.upsertCustomer(customer);
      customer = { ...customer, id: storedId };
    }

    const { url, sessionRef } = await this.deps.provider.createCheckout({
      customerId: customer.providerCustomerId,
      companyId,
      priceCents: this.priceCents(sub),
      currency: this.deps.config.currency,
      trialEndsAt: sub.status === "trialing" && sub.trialEndsAt ? new Date(sub.trialEndsAt) : undefined,
      successUrl: `${BILLING_PAGE_PATH}?checkout=success&session={SESSION_REF}`,
      cancelUrl: `${BILLING_PAGE_PATH}?checkout=cancel`,
    });

    const ledgerId = randomUUID();
    await this.deps.store.insertLedgerEvent({
      id: ledgerId,
      idempotencyKey: `checkout-created:${sessionRef}`,
      type: "checkout.created",
      subscriptionId: sub.id,
      companyId,
      rawPayload: { sessionRef, url },
    });
    await this.deps.store.markLedgerApplied(ledgerId, this.deps.now().toISOString());
    await this.deps.store.updateSubscription({
      ...sub,
      customerId: customer.id,
      openCheckoutSessionRef: sessionRef,
      openCheckoutUrl: url,
      updatedAt: this.deps.now().toISOString(),
    });
    return { url, sessionRef };
  }

  /** Server-side confirmation for the "Confirming payment…" page — never trusts redirect params. */
  async resolveCheckout(companyId: string, sessionRef: string): Promise<{ state: "complete" | "open" | "expired"; status: SubscriptionStatus }> {
    let sub = await this.ensure(companyId);
    const state = this.deps.provider.resolveCheckout ? await this.deps.provider.resolveCheckout(sessionRef) : "open";
    if (state === "expired" && sub.openCheckoutSessionRef === sessionRef) {
      sub = await this.clearOpenCheckout(sub);
    }
    const fresh = await this.deps.store.getSubscriptionByCompany(companyId);
    return { state, status: (fresh ?? sub).status };
  }

  async oneClickSubscribe(companyId: string): Promise<{ status: "active" } | { status: "requires_action"; url: string }> {
    const sub = await this.ensure(companyId);
    if (sub.status === "complimentary") throw new BillingUserError("complimentary", "This company is complimentary — no subscription needed.");
    if (sub.status === "active") throw new BillingUserError("already_subscribed", "This company already has an active subscription.");

    const customer = await this.deps.store.getCustomerByUser(this.deps.config.provider, sub.ownerUserId);
    if (!customer || !customer.hasDefaultPaymentMethod) {
      throw new BillingUserError("no_payment_method", "No saved payment method on file — use checkout instead.");
    }

    const result = await this.deps.provider.subscribeWithSavedMethod({
      customerId: customer.providerCustomerId,
      companyId,
      priceCents: this.priceCents(sub),
      currency: this.deps.config.currency,
      trialEndsAt: sub.status === "trialing" && sub.trialEndsAt ? new Date(sub.trialEndsAt) : undefined,
    });
    if (result.status === "requires_action") return result;

    // Optimistic activation; the provider's payment.succeeded webhook attaches the real subRef.
    const freshest = (await this.deps.store.getSubscriptionByCompany(companyId)) ?? sub;
    if (freshest.status !== "active") {
      const periodEnd = freshest.status === "trialing" && freshest.trialEndsAt
        ? freshest.trialEndsAt
        : addDaysIso(this.deps.now().toISOString(), 30);
      const ledgerId = randomUUID();
      // Content-addressable key (matches the checkout-*/${type}:${companyId} sites):
      // concurrent retries of the same activation intent collapse to one ledger row
      // (ON CONFLICT DO NOTHING), while a genuinely new intent after the subscription
      // moves to a different status yields a fresh key.
      const inserted = await this.deps.store.insertLedgerEvent({
        id: ledgerId,
        idempotencyKey: `oneclick:${companyId}:${freshest.id}:${freshest.status}`,
        type: "one_click.activated",
        subscriptionId: freshest.id,
        companyId,
        rawPayload: { subRef: null, periodEnd },
      });
      if (inserted === "inserted") {
        await applyBillingEvent(this.deps, freshest, { type: "one_click.activated", subRef: null, periodEnd }, ledgerId);
      }
    }
    return { status: "active" };
  }

  private async ownerAction(companyId: string, kind: "cancel" | "resume"): Promise<BillingSummary> {
    const sub = await this.ensure(companyId);
    if (sub.status !== "active" || sub.providerSubscriptionId === null) {
      throw new BillingUserError("not_active", "This company has no active provider subscription.");
    }
    try {
      if (kind === "cancel") await this.deps.provider.cancelAtPeriodEnd(sub.providerSubscriptionId);
      else await this.deps.provider.resume(sub.providerSubscriptionId);
    } catch {
      throw new BillingUserError("provider_unavailable", "The payment provider is unreachable — try again shortly.");
    }
    const type = kind === "cancel" ? "owner.cancel_at_period_end" : "owner.resume";
    const ledgerId = randomUUID();
    // Content-addressable key (same style as oneClickSubscribe's oneclick:… key):
    // concurrent retries of the same intent read identical subscription state and
    // collapse to ONE ledger row (ON CONFLICT DO NOTHING), while a genuinely new
    // intent after the state moved derives a fresh key and is never deduped away.
    // cancelAtPeriodEnd is the field cancel/resume actually flip, so it (not the
    // guarded-constant status alone) is what distinguishes a repeat-after-change.
    // Only apply when WE won the insert, so a duplicate never double-applies.
    const inserted = await this.deps.store.insertLedgerEvent({
      id: ledgerId,
      idempotencyKey: `${type}:${companyId}:${sub.id}:${sub.status}:${sub.cancelAtPeriodEnd}`,
      type,
      subscriptionId: sub.id,
      companyId,
      rawPayload: {},
    });
    if (inserted === "inserted") {
      await applyBillingEvent(this.deps, sub, { type } as { type: "owner.cancel_at_period_end" | "owner.resume" }, ledgerId);
    }
    return this.summary(companyId);
  }

  cancelAtPeriodEnd(companyId: string): Promise<BillingSummary> {
    return this.ownerAction(companyId, "cancel");
  }

  resume(companyId: string): Promise<BillingSummary> {
    return this.ownerAction(companyId, "resume");
  }

  async portal(companyId: string): Promise<{ url: string | null }> {
    const sub = await this.ensure(companyId);
    if (!this.deps.provider.createPortal) return { url: null };
    const customer = await this.deps.store.getCustomerByUser(this.deps.config.provider, sub.ownerUserId);
    if (!customer) return { url: null };
    const { url } = await this.deps.provider.createPortal(customer.providerCustomerId);
    return { url };
  }

  /** Stub-simulator hook: the plugin-side saved-method flag drives the one-click CTA. */
  async markSavedMethod(ownerUserId: string): Promise<void> {
    const customer = await this.deps.store.getCustomerByUser(this.deps.config.provider, ownerUserId);
    if (customer && !customer.hasDefaultPaymentMethod) {
      await this.deps.store.upsertCustomer({ ...customer, hasDefaultPaymentMethod: true });
    }
  }

  async adminOverview(): Promise<AdminCompanyRow[]> {
    const subs = await this.deps.store.listSubscriptions();
    return subs.map((sub) => ({
      companyId: sub.companyId,
      status: sub.status,
      ownerUserId: sub.ownerUserId,
      priceCents: this.priceCents(sub),
      priceCentsOverride: sub.priceCentsOverride,
      currency: this.deps.config.currency,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      hasOpenCheckout: sub.openCheckoutSessionRef !== null,
    }));
  }

  async adminSetPriceOverride(companyId: string, priceCents: number | null): Promise<BillingSummary> {
    if (priceCents !== null && (!Number.isInteger(priceCents) || priceCents < 0)) {
      throw new BillingUserError("invalid_price", "Price override must be a non-negative integer or null.");
    }
    const sub = await this.ensure(companyId);
    const ledgerId = randomUUID();
    // Content-addressable key (same style as the owner/oneclick sites): the key is
    // the TARGET price + subscription id, so retries of the same override collapse to
    // ONE ledger row (ON CONFLICT DO NOTHING) while setting a genuinely different
    // price yields a fresh key. Setting the same price twice is idempotent, so
    // collapsing it is correct. Only apply when WE won the insert, so a duplicate
    // never double-applies.
    const inserted = await this.deps.store.insertLedgerEvent({
      id: ledgerId,
      idempotencyKey: `admin-price:${companyId}:${sub.id}:${priceCents ?? "null"}`,
      type: "admin.set_price_override",
      subscriptionId: sub.id,
      companyId,
      rawPayload: { priceCents },
    });
    if (inserted === "inserted") {
      await applyBillingEvent(this.deps, sub, { type: "admin.set_price_override", priceCents }, ledgerId);
    }
    return this.summary(companyId);
  }

  async adminExtendTrial(companyId: string, days: number): Promise<BillingSummary> {
    if (!Number.isInteger(days) || days <= 0) {
      throw new BillingUserError("invalid_days", "Trial extension must be a positive whole number of days.");
    }
    const sub = await this.ensure(companyId);
    const base = sub.trialEndsAt && Date.parse(sub.trialEndsAt) > this.deps.now().getTime()
      ? sub.trialEndsAt
      : this.deps.now().toISOString();
    const trialEndsAt = addDaysIso(base, days);
    const ledgerId = randomUUID();
    // Content-addressable key on the COMPUTED target trial-end (+ subscription id).
    // Concurrent retries of one extend read the same base and derive the same target,
    // so they collapse to ONE ledger row (ON CONFLICT DO NOTHING). A genuine second
    // extension advances `base` to the just-extended end, so its target moves farther
    // out and yields a fresh key — it is never deduped away. Only apply when WE won
    // the insert, so a duplicate never double-applies.
    const inserted = await this.deps.store.insertLedgerEvent({
      id: ledgerId,
      idempotencyKey: `admin-trial:${companyId}:${sub.id}:${trialEndsAt}`,
      type: "admin.extend_trial",
      subscriptionId: sub.id,
      companyId,
      rawPayload: { trialEndsAt },
    });
    if (inserted === "inserted") {
      await applyBillingEvent(this.deps, sub, { type: "admin.extend_trial", trialEndsAt }, ledgerId);
    }
    return this.summary(companyId);
  }

  /** Reconcile standing from local state and expire a stuck checkout. Does not replay unapplied ledger rows (sweep handles that) or query provider-side subscription state. */
  async adminForceResync(companyId: string): Promise<BillingSummary> {
    let sub = await this.ensure(companyId);
    if (sub.openCheckoutSessionRef && this.deps.provider.resolveCheckout) {
      const state = await this.deps.provider.resolveCheckout(sub.openCheckoutSessionRef);
      if (state === "expired") sub = await this.clearOpenCheckout(sub);
    }
    await applyStandingCommand(this.deps.standing, companyId, expectedStanding(sub, this.deps.config));
    return this.summary(companyId);
  }
}
