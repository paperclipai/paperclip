import type { CustomerRow, LedgerInsert, LedgerRow, SubscriptionRow } from "./domain.js";
import type { BillingStore } from "./store.js";

export class MemoryBillingStore implements BillingStore {
  private subscriptions = new Map<string, SubscriptionRow>(); // by companyId
  private customers = new Map<string, CustomerRow>(); // by `${provider}:${userId}`
  private ledger: LedgerRow[] = [];
  private ledgerKeys = new Set<string>();

  constructor(private readonly nowFn: () => Date = () => new Date()) {}

  async getSubscriptionByCompany(companyId: string): Promise<SubscriptionRow | null> {
    const row = this.subscriptions.get(companyId);
    return row ? { ...row } : null;
  }

  async getSubscriptionByProviderRef(subRef: string): Promise<SubscriptionRow | null> {
    if (subRef == null) return null;
    for (const row of this.subscriptions.values()) {
      if (row.providerSubscriptionId !== null && row.providerSubscriptionId === subRef) return { ...row };
    }
    return null;
  }

  async getSubscriptionBySessionRef(sessionRef: string): Promise<SubscriptionRow | null> {
    if (sessionRef == null) return null;
    for (const row of this.subscriptions.values()) {
      if (row.openCheckoutSessionRef !== null && row.openCheckoutSessionRef === sessionRef) return { ...row };
    }
    return null;
  }

  async listSubscriptions(): Promise<SubscriptionRow[]> {
    return [...this.subscriptions.values()].map((row) => ({ ...row }));
  }

  async insertSubscription(sub: SubscriptionRow): Promise<void> {
    if (this.subscriptions.has(sub.companyId)) {
      throw new Error(`duplicate subscription for company ${sub.companyId}`);
    }
    this.subscriptions.set(sub.companyId, { ...sub });
  }

  async updateSubscription(sub: SubscriptionRow): Promise<void> {
    this.subscriptions.set(sub.companyId, { ...sub });
  }

  async getCustomerByUser(provider: string, userId: string): Promise<CustomerRow | null> {
    const row = this.customers.get(`${provider}:${userId}`);
    return row ? { ...row } : null;
  }

  async upsertCustomer(customer: CustomerRow): Promise<string> {
    // Mirror SqlBillingStore: on conflict the (provider, user_id) row keeps its
    // original id (id is not in the SQL DO UPDATE SET) and that surviving id is
    // returned, so a losing concurrent caller converges on the stored id.
    const key = `${customer.provider}:${customer.userId}`;
    const existing = this.customers.get(key);
    const id = existing ? existing.id : customer.id;
    this.customers.set(key, { ...customer, id });
    return id;
  }

  async insertLedgerEvent(event: LedgerInsert): Promise<"inserted" | "duplicate"> {
    if (this.ledgerKeys.has(event.idempotencyKey)) return "duplicate";
    this.ledgerKeys.add(event.idempotencyKey);
    this.ledger.push({ ...event, appliedAt: null, createdAt: this.nowFn().toISOString() });
    return "inserted";
  }

  async markLedgerApplied(ledgerId: string, appliedAtIso: string): Promise<void> {
    const row = this.ledger.find((entry) => entry.id === ledgerId);
    if (row) row.appliedAt = appliedAtIso;
  }

  async listUnappliedLedgerEvents(limit: number): Promise<LedgerRow[]> {
    return this.ledger.filter((entry) => entry.appliedAt === null).slice(0, limit).map((entry) => ({ ...entry }));
  }

  async listLedgerEventsForCompany(companyId: string, limit: number): Promise<LedgerRow[]> {
    return [...this.ledger]
      .filter((entry) => entry.companyId === companyId)
      .reverse()
      .slice(0, limit)
      .map((entry) => ({ ...entry }));
  }

  async ownerHadTrial(ownerUserId: string): Promise<boolean> {
    return this.ledger.some(
      (entry) => entry.type === "trial.started" && entry.rawPayload.ownerUserId === ownerUserId,
    );
  }
}
