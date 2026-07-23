import { randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { CHECKOUT_PAGE_ROUTE, DB_NAMESPACE, STUB_SIGNATURE_HEADER, WEBHOOK_PATH } from "../constants.js";
import { WebhookVerificationError, headerValue, signStubPayload, verifyStubSignature } from "../hmac.js";
import type { BillingProvider, ParsedProviderEvent } from "./types.js";

const DAY_MS = 86_400_000;
const PERIOD_MS = 30 * DAY_MS;
const DUNNING_RETRY_MS = 1 * DAY_MS;
/** Optimistic-concurrency retry budget for a single stub_state mutation. */
const MUTATE_MAX_ATTEMPTS = 5;

export interface StubCustomer {
  customerId: string;
  userId: string;
  email: string;
  name: string;
  hasSavedMethod: boolean;
  scaRequired: boolean;
}

export interface StubSession {
  sessionRef: string;
  kind: "checkout" | "sca";
  customerId: string;
  companyId: string;
  priceCents: number;
  currency: string;
  trialEndsAtIso: string | null;
  successUrl: string;
  cancelUrl: string;
  status: "open" | "complete" | "expired";
  lastError: string | null;
  createdAtIso: string;
}

export interface StubSubscription {
  subRef: string;
  customerId: string;
  companyId: string;
  priceCents: number;
  currency: string;
  status: "active" | "past_due" | "canceled";
  periodEndIso: string;
  cancelAtPeriodEnd: boolean;
  failNextRenewal: boolean;
}

interface StubDueEvent {
  id: string;
  dueAtIso: string;
  /** {kind:"renewal", subRef} or {kind:"raw", rawBody, signature} (redelivery). */
  payload:
    | { kind: "renewal"; subRef: string }
    | { kind: "raw"; rawBody: string; signature: string };
}

export interface StubState {
  customers: StubCustomer[];
  sessions: StubSession[];
  subscriptions: StubSubscription[];
  dueEvents: StubDueEvent[];
}

export function emptyStubState(): StubState {
  return { customers: [], sessions: [], subscriptions: [], dueEvents: [] };
}

/** A state snapshot plus the opaque version token it was read at (for optimistic concurrency). */
export interface StubStateSnapshot {
  state: StubState;
  version: number;
}

export interface StubStateStore {
  /** Load the current state together with the version it was read at. */
  load(): Promise<StubStateSnapshot>;
  /**
   * Compare-and-swap: persist `state` only if the stored version still equals
   * `expectedVersion`. Returns false when a concurrent writer has since advanced
   * the version — the caller should reload and retry.
   */
  save(state: StubState, expectedVersion: number): Promise<boolean>;
}

export class MemoryStubStateStore implements StubStateStore {
  private state: StubState = emptyStubState();
  private version = 0;

  async load(): Promise<StubStateSnapshot> {
    return { state: JSON.parse(JSON.stringify(this.state)) as StubState, version: this.version };
  }

  async save(state: StubState, expectedVersion: number): Promise<boolean> {
    if (expectedVersion !== this.version) return false;
    this.state = JSON.parse(JSON.stringify(state)) as StubState;
    this.version += 1;
    return true;
  }
}

/** Persists the whole stub-provider state as the singleton stub_state row. */
export class SqlStubStateStore implements StubStateStore {
  constructor(private readonly db: PluginDatabaseClient) {}

  async load(): Promise<StubStateSnapshot> {
    const rows = await this.db.query<{ state: unknown; version: number | string }>(
      `SELECT state, version FROM ${DB_NAMESPACE}.stub_state WHERE id = 1`,
      [],
    );
    const raw = rows[0]?.state;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const state = (parsed ?? {}) as Partial<StubState>;
    return {
      state: {
        customers: state.customers ?? [],
        sessions: state.sessions ?? [],
        subscriptions: state.subscriptions ?? [],
        dueEvents: state.dueEvents ?? [],
      },
      version: Number(rows[0]?.version ?? 0),
    };
  }

  async save(state: StubState, expectedVersion: number): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE ${DB_NAMESPACE}.stub_state SET state = $1::jsonb, version = version + 1, updated_at = now() `
      + "WHERE id = 1 AND version = $2",
      [JSON.stringify(state), expectedVersion],
    );
    return result.rowCount > 0;
  }
}

export interface StubTransport {
  deliver(headers: Record<string, string>, rawBody: string): Promise<void>;
}

/**
 * Production transport: POSTs signed events to this plugin's own manifest
 * webhook endpoint so the entire production path (signature verify → ledger →
 * transition → standing) is exercised with no external account. The route is
 * unauthenticated-but-signed by design (PLUGIN_SPEC §18).
 */
export class HttpStubTransport implements StubTransport {
  constructor(private readonly baseUrl: () => Promise<string>) {}

  async deliver(headers: Record<string, string>, rawBody: string): Promise<void> {
    const base = (await this.baseUrl()).replace(/\/$/, "");
    const response = await fetch(`${base}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: rawBody,
    });
    if (!response.ok) {
      throw new Error(`stub webhook delivery failed with status ${response.status}`);
    }
  }
}

export class StubProvider implements BillingProvider {
  constructor(
    private readonly deps: {
      store: StubStateStore;
      secret: string;
      transport: StubTransport;
      now: () => Date;
    },
  ) {}

  // -------------------------------------------------------------- internals

  /**
   * Read-modify-write the singleton stub_state under optimistic concurrency:
   * load a versioned snapshot, apply `fn`, and compare-and-swap. A concurrent
   * writer that advanced the version makes the save fail; we reload and re-run
   * `fn` against fresh state so no write is lost. Bounded to avoid a livelock.
   */
  private async mutate<T>(fn: (state: StubState) => Promise<T> | T): Promise<T> {
    for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt += 1) {
      const { state, version } = await this.deps.store.load();
      const result = await fn(state);
      if (await this.deps.store.save(state, version)) return result;
    }
    throw new Error(
      `stub state mutate: optimistic concurrency retries exhausted after ${MUTATE_MAX_ATTEMPTS} attempts`,
    );
  }

  /**
   * Emit a freshly-produced event AFTER its state mutation has committed
   * (emit-after-commit). Sign and deliver exactly once; on transport failure
   * queue the exact signed body for redelivery in its OWN committed mutation.
   * MUST NOT be called from inside a `mutate` callback: a CAS collision re-runs
   * that callback, and delivering there would emit a duplicate webhook (with an
   * identifier that the losing attempt never persisted), so the billing service
   * would latch a subRef that no stub subscription actually has.
   */
  private async deliverEvent(body: Record<string, unknown>): Promise<void> {
    const rawBody = JSON.stringify({ eventId: randomUUID(), sentAt: this.deps.now().toISOString(), ...body });
    const signature = signStubPayload(this.deps.secret, rawBody);
    try {
      await this.deps.transport.deliver({ [STUB_SIGNATURE_HEADER]: signature }, rawBody);
    } catch {
      await this.queueRaw(rawBody, signature, this.deps.now().toISOString());
    }
  }

  /** Queue an already-signed body for later redelivery in its own committed mutation. */
  private async queueRaw(rawBody: string, signature: string, dueAtIso: string): Promise<void> {
    await this.mutate((state) => {
      state.dueEvents.push({ id: randomUUID(), dueAtIso, payload: { kind: "raw", rawBody, signature } });
    });
  }

  private scheduleRenewal(state: StubState, subRef: string, dueAtIso: string): void {
    state.dueEvents.push({ id: randomUUID(), dueAtIso, payload: { kind: "renewal", subRef } });
  }

  private activateSession(state: StubState, session: StubSession, subRef: string): StubSubscription {
    const periodEndIso = session.trialEndsAtIso ?? new Date(this.deps.now().getTime() + PERIOD_MS).toISOString();
    const sub: StubSubscription = {
      subRef,
      customerId: session.customerId,
      companyId: session.companyId,
      priceCents: session.priceCents,
      currency: session.currency,
      status: "active",
      periodEndIso,
      cancelAtPeriodEnd: false,
      failNextRenewal: false,
    };
    state.subscriptions.push(sub);
    this.scheduleRenewal(state, sub.subRef, periodEndIso);
    session.status = "complete";
    return sub;
  }

  // -------------------------------------------------- BillingProvider port

  async ensureCustomer(user: { id: string; email: string; name: string }): Promise<{ customerId: string }> {
    // Mint the id OUTSIDE the mutate callback so a CAS retry reuses the same one.
    const customerId = `stub_cus_${randomUUID()}`;
    return this.mutate((state) => {
      const existing = state.customers.find((c) => c.userId === user.id);
      if (existing) return { customerId: existing.customerId };
      const customer: StubCustomer = {
        customerId,
        userId: user.id,
        email: user.email,
        name: user.name,
        hasSavedMethod: false,
        scaRequired: false,
      };
      state.customers.push(customer);
      return { customerId: customer.customerId };
    });
  }

  async createCheckout(req: {
    customerId: string;
    companyId: string;
    priceCents: number;
    currency: string;
    trialEndsAt?: Date;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string; sessionRef: string }> {
    // Mint the ref OUTSIDE the mutate callback so a CAS retry reuses the same one.
    const sessionRef = `stub_sess_${randomUUID()}`;
    return this.mutate((state) => {
      state.sessions.push({
        sessionRef,
        kind: "checkout",
        customerId: req.customerId,
        companyId: req.companyId,
        priceCents: req.priceCents,
        currency: req.currency,
        trialEndsAtIso: req.trialEndsAt ? req.trialEndsAt.toISOString() : null,
        successUrl: req.successUrl.replaceAll("{SESSION_REF}", sessionRef),
        cancelUrl: req.cancelUrl,
        status: "open",
        lastError: null,
        createdAtIso: this.deps.now().toISOString(),
      });
      return { url: `${CHECKOUT_PAGE_ROUTE}?session=${sessionRef}`, sessionRef };
    });
  }

  async resolveCheckout(sessionRef: string): Promise<"complete" | "open" | "expired"> {
    const { state } = await this.deps.store.load();
    const session = state.sessions.find((s) => s.sessionRef === sessionRef);
    if (!session) return "expired";
    return session.status;
  }

  async subscribeWithSavedMethod(req: {
    customerId: string;
    companyId: string;
    priceCents: number;
    currency: string;
    trialEndsAt?: Date;
  }): Promise<{ status: "active" } | { status: "requires_action"; url: string }> {
    // Mint identifiers OUTSIDE the mutate callback so a CAS retry reuses them, and
    // emit the webhook AFTER the state commits (see deliverEvent): otherwise a retry
    // would deliver payment.succeeded twice with two different subRefs, and the
    // billing service would latch the never-persisted one.
    const subRef = `stub_sub_${randomUUID()}`;
    const scaSessionRef = `stub_sess_${randomUUID()}`;
    const outcome = await this.mutate((state) => {
      const customer = state.customers.find((c) => c.customerId === req.customerId);
      if (!customer || !customer.hasSavedMethod) {
        throw new Error("no saved payment method on file for this customer");
      }
      if (customer.scaRequired) {
        state.sessions.push({
          sessionRef: scaSessionRef,
          kind: "sca",
          customerId: req.customerId,
          companyId: req.companyId,
          priceCents: req.priceCents,
          currency: req.currency,
          trialEndsAtIso: req.trialEndsAt ? req.trialEndsAt.toISOString() : null,
          successUrl: "",
          cancelUrl: "",
          status: "open",
          lastError: null,
          createdAtIso: this.deps.now().toISOString(),
        });
        return { status: "requires_action" as const, url: `${CHECKOUT_PAGE_ROUTE}?session=${scaSessionRef}` };
      }
      const periodEndIso = req.trialEndsAt
        ? req.trialEndsAt.toISOString()
        : new Date(this.deps.now().getTime() + PERIOD_MS).toISOString();
      const sub: StubSubscription = {
        subRef,
        customerId: req.customerId,
        companyId: req.companyId,
        priceCents: req.priceCents,
        currency: req.currency,
        status: "active",
        periodEndIso,
        cancelAtPeriodEnd: false,
        failNextRenewal: false,
      };
      state.subscriptions.push(sub);
      this.scheduleRenewal(state, sub.subRef, periodEndIso);
      return {
        status: "active" as const,
        event: { type: "payment.succeeded", subRef: sub.subRef, periodEnd: periodEndIso, companyId: req.companyId },
      };
    });
    if (outcome.status === "requires_action") return { status: "requires_action", url: outcome.url };
    await this.deliverEvent(outcome.event);
    return { status: "active" };
  }

  async cancelAtPeriodEnd(subRef: string): Promise<void> {
    await this.mutate((state) => {
      const sub = state.subscriptions.find((s) => s.subRef === subRef);
      if (sub) sub.cancelAtPeriodEnd = true;
    });
  }

  async resume(subRef: string): Promise<void> {
    await this.mutate((state) => {
      const sub = state.subscriptions.find((s) => s.subRef === subRef);
      if (sub) sub.cancelAtPeriodEnd = false;
    });
  }

  async cancelNow(subRef: string): Promise<void> {
    const event = await this.mutate((state) => {
      const sub = state.subscriptions.find((s) => s.subRef === subRef);
      if (!sub || sub.status === "canceled") return null;
      sub.status = "canceled";
      state.dueEvents = state.dueEvents.filter(
        (evt) => !(evt.payload.kind === "renewal" && evt.payload.subRef === subRef),
      );
      return { type: "subscription.canceled" as const, subRef, companyId: sub.companyId };
    });
    // Emit only after the cancel committed, and only if we actually canceled it.
    if (event) await this.deliverEvent(event);
  }

  verifyAndParseWebhook(headers: Record<string, string | string[]>, rawBody: string): ParsedProviderEvent {
    const signature = headerValue(headers, STUB_SIGNATURE_HEADER);
    if (!verifyStubSignature(this.deps.secret, rawBody, signature)) {
      throw new WebhookVerificationError("invalid or missing stub webhook signature");
    }
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    switch (body.type) {
      case "checkout.completed":
        return {
          type: "checkout.completed",
          sessionRef: String(body.sessionRef),
          subRef: String(body.subRef),
          periodEnd: String(body.periodEnd),
        };
      case "payment.succeeded":
        return { type: "payment.succeeded", subRef: String(body.subRef), periodEnd: String(body.periodEnd) };
      case "payment.failed":
        return { type: "payment.failed", subRef: String(body.subRef) };
      case "subscription.canceled":
        return { type: "subscription.canceled", subRef: String(body.subRef) };
      default:
        throw new Error(`unknown stub event type: ${String(body.type)}`);
    }
  }

  // ------------------------------------------------ simulator/test surface

  async getSession(sessionRef: string): Promise<StubSession | null> {
    const { state } = await this.deps.store.load();
    return state.sessions.find((s) => s.sessionRef === sessionRef) ?? null;
  }

  /** Simulator "Pay" button; also completes SCA sessions. */
  async completeCheckout(sessionRef: string, options: { savePaymentMethod: boolean }): Promise<void> {
    // Mint the subRef OUTSIDE the mutate callback so a CAS retry reuses it, and
    // emit AFTER the state commits (see deliverEvent) so a retry cannot deliver
    // checkout.completed twice with two different subRefs.
    const subRef = `stub_sub_${randomUUID()}`;
    const event = await this.mutate((state) => {
      const session = state.sessions.find((s) => s.sessionRef === sessionRef);
      if (!session || session.status !== "open") {
        throw new Error(`stub session ${sessionRef} is not open`);
      }
      if (options.savePaymentMethod) {
        const customer = state.customers.find((c) => c.customerId === session.customerId);
        if (customer) customer.hasSavedMethod = true;
      }
      const sub = this.activateSession(state, session, subRef);
      return {
        type: "checkout.completed" as const,
        sessionRef,
        subRef: sub.subRef,
        periodEnd: sub.periodEndIso,
        companyId: session.companyId,
      };
    });
    await this.deliverEvent(event);
  }

  /** Simulator "Payment fails" button: decline, session stays open, no event. */
  async failCheckout(sessionRef: string): Promise<void> {
    await this.mutate((state) => {
      const session = state.sessions.find((s) => s.sessionRef === sessionRef);
      if (session && session.status === "open") session.lastError = "card_declined";
    });
  }

  /** Simulator "Cancel" button: expire the session, state unchanged (spec §6.3). */
  async cancelCheckout(sessionRef: string): Promise<void> {
    await this.mutate((state) => {
      const session = state.sessions.find((s) => s.sessionRef === sessionRef);
      if (session && session.status === "open") session.status = "expired";
    });
  }

  /**
   * Simulation hooks: no production caller. Exercised by the test suite
   * (service/stub-provider/e2e-journey specs) and reserved for future
   * stub-checkout tooling that needs to force customer/subscription state
   * (saved-method presence, SCA challenge, forced renewal failure) without
   * a real provider round trip.
   */
  async setSavedMethod(customerId: string, hasSavedMethod: boolean): Promise<void> {
    await this.mutate((state) => {
      const customer = state.customers.find((c) => c.customerId === customerId);
      if (customer) customer.hasSavedMethod = hasSavedMethod;
    });
  }

  async setScaRequired(customerId: string, scaRequired: boolean): Promise<void> {
    await this.mutate((state) => {
      const customer = state.customers.find((c) => c.customerId === customerId);
      if (customer) customer.scaRequired = scaRequired;
    });
  }

  async setFailNextRenewal(subRef: string, fail: boolean): Promise<void> {
    await this.mutate((state) => {
      const sub = state.subscriptions.find((s) => s.subRef === subRef);
      if (sub) sub.failNextRenewal = fail;
    });
  }

  async customerHasSavedMethod(customerId: string): Promise<boolean> {
    const { state } = await this.deps.store.load();
    return state.customers.find((c) => c.customerId === customerId)?.hasSavedMethod ?? false;
  }

  /**
   * Deliver every due event (renewals, dunning retries, failed-transport
   * redeliveries). Called by the billing-sweep job; deterministic in tests.
   */
  async deliverDue(now: Date): Promise<number> {
    // Phase 1 (committed): drain the due events and apply every state transition
    // exactly once. Collect the resulting webhooks/redeliveries but do NOT deliver
    // them here — a CAS collision re-runs this callback, and delivering inside it
    // would double-advance renewal periods and double-emit. Delivery is phase 2.
    const { emissions, rawToRedeliver } = await this.mutate((state) => {
      const isDue = (event: StubDueEvent) => Date.parse(event.dueAtIso) <= now.getTime();
      const due = state.dueEvents.filter(isDue);
      state.dueEvents = state.dueEvents.filter((event) => !isDue(event));
      const emissions: Record<string, unknown>[] = [];
      const rawToRedeliver: Array<{ rawBody: string; signature: string }> = [];

      for (const event of due) {
        if (event.payload.kind === "raw") {
          rawToRedeliver.push({ rawBody: event.payload.rawBody, signature: event.payload.signature });
          continue;
        }

        const sub = state.subscriptions.find((s) => s.subRef === (event.payload as { subRef: string }).subRef);
        if (!sub || sub.status === "canceled") continue;

        if (sub.cancelAtPeriodEnd) {
          sub.status = "canceled";
          emissions.push({ type: "subscription.canceled", subRef: sub.subRef, companyId: sub.companyId });
          continue;
        }

        if (sub.failNextRenewal) {
          sub.status = "past_due";
          emissions.push({ type: "payment.failed", subRef: sub.subRef, companyId: sub.companyId });
          this.scheduleRenewal(state, sub.subRef, new Date(now.getTime() + DUNNING_RETRY_MS).toISOString());
          continue;
        }

        sub.status = "active";
        sub.periodEndIso = new Date(Date.parse(sub.periodEndIso) + PERIOD_MS).toISOString();
        this.scheduleRenewal(state, sub.subRef, sub.periodEndIso);
        emissions.push({
          type: "payment.succeeded",
          subRef: sub.subRef,
          periodEnd: sub.periodEndIso,
          companyId: sub.companyId,
        });
      }

      return { emissions, rawToRedeliver };
    });

    // Phase 2 (after commit): deliver. Redeliveries send the exact stored body and
    // count only on success (re-queued on failure); fresh emissions were already
    // applied to state so they count as processed regardless of transport outcome.
    let delivered = 0;
    for (const raw of rawToRedeliver) {
      try {
        await this.deps.transport.deliver({ [STUB_SIGNATURE_HEADER]: raw.signature }, raw.rawBody);
        delivered += 1;
      } catch {
        await this.queueRaw(raw.rawBody, raw.signature, new Date(now.getTime() + DUNNING_RETRY_MS).toISOString());
      }
    }
    for (const body of emissions) {
      await this.deliverEvent(body);
      delivered += 1;
    }
    return delivered;
  }
}
