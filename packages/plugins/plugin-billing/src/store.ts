import type { CustomerRow, LedgerInsert, LedgerRow, SubscriptionRow } from "./domain.js";

/**
 * Persistence port. Two adapters:
 * - SqlBillingStore (ctx.db, plugin namespace) in production,
 * - MemoryBillingStore in tests (the SDK test harness's ctx.db is a recorder).
 */
export interface BillingStore {
  getSubscriptionByCompany(companyId: string): Promise<SubscriptionRow | null>;
  /** Lookup by provider subscription ID. Never matches null refs — returns null if subRef is null/undefined, and skips rows with null providerSubscriptionId. */
  getSubscriptionByProviderRef(subRef: string): Promise<SubscriptionRow | null>;
  /** Lookup by checkout session ID. Never matches null refs — returns null if sessionRef is null/undefined, and skips rows with null openCheckoutSessionRef. */
  getSubscriptionBySessionRef(sessionRef: string): Promise<SubscriptionRow | null>;
  listSubscriptions(): Promise<SubscriptionRow[]>;
  insertSubscription(sub: SubscriptionRow): Promise<void>;
  updateSubscription(sub: SubscriptionRow): Promise<void>;
  getCustomerByUser(provider: string, userId: string): Promise<CustomerRow | null>;
  /**
   * Upsert on (provider, user_id). Returns the id of the SURVIVING stored row —
   * the pre-existing id on conflict, the passed id on first insert. Concurrent
   * callers that each mint a local id must use this return value, not their own,
   * or they FK-violate against billing_customers(id) downstream.
   */
  upsertCustomer(customer: CustomerRow): Promise<string>;
  /** Unique idempotency_key makes replays no-ops: returns "duplicate" instead of throwing. */
  insertLedgerEvent(event: LedgerInsert): Promise<"inserted" | "duplicate">;
  markLedgerApplied(ledgerId: string, appliedAtIso: string): Promise<void>;
  listUnappliedLedgerEvents(limit: number): Promise<LedgerRow[]>;
  listLedgerEventsForCompany(companyId: string, limit: number): Promise<LedgerRow[]>;
  /** Trial eligibility: has this owner EVER had a trial (ledger-based, survives company deletion). */
  ownerHadTrial(ownerUserId: string): Promise<boolean>;
}
