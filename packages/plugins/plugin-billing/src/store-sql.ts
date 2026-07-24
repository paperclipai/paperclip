import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { DB_NAMESPACE } from "./constants.js";
import type { CustomerRow, LedgerInsert, LedgerRow, SubscriptionRow, SubscriptionStatus } from "./domain.js";
import type { BillingStore } from "./store.js";

const NS = DB_NAMESPACE;

const SUB_COLUMNS =
  "id, company_id, owner_user_id, customer_id, status, trial_ends_at, grace_since, current_period_end, "
  + "cancel_at_period_end, price_cents_override, provider_subscription_id, open_checkout_session_ref, "
  + "open_checkout_url, created_at, updated_at";

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return null;
}

function mapSub(row: Record<string, unknown>): SubscriptionRow {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    ownerUserId: String(row.owner_user_id),
    customerId: row.customer_id === null ? null : String(row.customer_id),
    status: String(row.status) as SubscriptionStatus,
    trialEndsAt: isoOrNull(row.trial_ends_at),
    graceSince: isoOrNull(row.grace_since),
    currentPeriodEnd: isoOrNull(row.current_period_end),
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    priceCentsOverride: row.price_cents_override === null ? null : Number(row.price_cents_override),
    providerSubscriptionId: row.provider_subscription_id === null ? null : String(row.provider_subscription_id),
    openCheckoutSessionRef: row.open_checkout_session_ref === null ? null : String(row.open_checkout_session_ref),
    openCheckoutUrl: row.open_checkout_url === null ? null : String(row.open_checkout_url),
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: isoOrNull(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function mapLedger(row: Record<string, unknown>): LedgerRow {
  const raw = row.raw_payload;
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    type: String(row.type),
    subscriptionId: row.subscription_id === null ? null : String(row.subscription_id),
    companyId: row.company_id === null ? null : String(row.company_id),
    rawPayload: typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : ((raw ?? {}) as Record<string, unknown>),
    appliedAt: isoOrNull(row.applied_at),
    createdAt: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
  };
}

export class SqlBillingStore implements BillingStore {
  constructor(private readonly db: PluginDatabaseClient) {}

  private async one(sql: string, params: unknown[]): Promise<SubscriptionRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(sql, params);
    return rows.length > 0 ? mapSub(rows[0]) : null;
  }

  getSubscriptionByCompany(companyId: string): Promise<SubscriptionRow | null> {
    return this.one(`SELECT ${SUB_COLUMNS} FROM ${NS}.subscriptions WHERE company_id = $1`, [companyId]);
  }

  /** Never matches null refs: JS guard skips the query entirely, SQL guard is belt-and-suspenders. */
  getSubscriptionByProviderRef(subRef: string): Promise<SubscriptionRow | null> {
    if (subRef == null) return Promise.resolve(null);
    return this.one(
      `SELECT ${SUB_COLUMNS} FROM ${NS}.subscriptions `
      + "WHERE provider_subscription_id IS NOT NULL AND provider_subscription_id = $1",
      [subRef],
    );
  }

  /** Never matches null refs: JS guard skips the query entirely, SQL guard is belt-and-suspenders. */
  getSubscriptionBySessionRef(sessionRef: string): Promise<SubscriptionRow | null> {
    if (sessionRef == null) return Promise.resolve(null);
    return this.one(
      `SELECT ${SUB_COLUMNS} FROM ${NS}.subscriptions `
      + "WHERE open_checkout_session_ref IS NOT NULL AND open_checkout_session_ref = $1",
      [sessionRef],
    );
  }

  async listSubscriptions(): Promise<SubscriptionRow[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT ${SUB_COLUMNS} FROM ${NS}.subscriptions ORDER BY created_at ASC`,
      [],
    );
    return rows.map(mapSub);
  }

  async insertSubscription(sub: SubscriptionRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${NS}.subscriptions (${SUB_COLUMNS}) `
      + "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
      [
        sub.id, sub.companyId, sub.ownerUserId, sub.customerId, sub.status, sub.trialEndsAt, sub.graceSince,
        sub.currentPeriodEnd, sub.cancelAtPeriodEnd, sub.priceCentsOverride, sub.providerSubscriptionId,
        sub.openCheckoutSessionRef, sub.openCheckoutUrl, sub.createdAt, sub.updatedAt,
      ],
    );
  }

  async updateSubscription(sub: SubscriptionRow): Promise<void> {
    await this.db.execute(
      `UPDATE ${NS}.subscriptions SET customer_id = $2, status = $3, trial_ends_at = $4, grace_since = $5, `
      + "current_period_end = $6, cancel_at_period_end = $7, price_cents_override = $8, "
      + "provider_subscription_id = $9, open_checkout_session_ref = $10, open_checkout_url = $11, "
      + "updated_at = $12 WHERE id = $1",
      [
        sub.id, sub.customerId, sub.status, sub.trialEndsAt, sub.graceSince, sub.currentPeriodEnd,
        sub.cancelAtPeriodEnd, sub.priceCentsOverride, sub.providerSubscriptionId,
        sub.openCheckoutSessionRef, sub.openCheckoutUrl, sub.updatedAt,
      ],
    );
  }

  async getCustomerByUser(provider: string, userId: string): Promise<CustomerRow | null> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, user_id, provider, provider_customer_id, has_default_payment_method `
      + `FROM ${NS}.billing_customers WHERE provider = $1 AND user_id = $2`,
      [provider, userId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: String(row.id),
      userId: String(row.user_id),
      provider: String(row.provider),
      providerCustomerId: String(row.provider_customer_id),
      hasDefaultPaymentMethod: Boolean(row.has_default_payment_method),
    };
  }

  async upsertCustomer(customer: CustomerRow): Promise<string> {
    // The id column is deliberately NOT in the DO UPDATE SET, so on conflict the
    // stored row keeps its original id and RETURNING id yields the SURVIVING id
    // (the winner of a concurrent insert), not the caller's freshly-minted one.
    const rows = await this.db.query<{ id: unknown }>(
      `INSERT INTO ${NS}.billing_customers (id, user_id, provider, provider_customer_id, has_default_payment_method) `
      + "VALUES ($1, $2, $3, $4, $5) "
      + "ON CONFLICT (provider, user_id) DO UPDATE SET provider_customer_id = $4, has_default_payment_method = $5, updated_at = now() "
      + "RETURNING id",
      [customer.id, customer.userId, customer.provider, customer.providerCustomerId, customer.hasDefaultPaymentMethod],
    );
    return rows.length > 0 ? String(rows[0].id) : customer.id;
  }

  async insertLedgerEvent(event: LedgerInsert): Promise<"inserted" | "duplicate"> {
    const result = await this.db.execute(
      `INSERT INTO ${NS}.billing_events (id, idempotency_key, type, subscription_id, company_id, raw_payload) `
      + "VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (idempotency_key) DO NOTHING",
      [event.id, event.idempotencyKey, event.type, event.subscriptionId, event.companyId, JSON.stringify(event.rawPayload)],
    );
    return result.rowCount > 0 ? "inserted" : "duplicate";
  }

  async markLedgerApplied(ledgerId: string, appliedAtIso: string): Promise<void> {
    await this.db.execute(`UPDATE ${NS}.billing_events SET applied_at = $2 WHERE id = $1`, [ledgerId, appliedAtIso]);
  }

  async listUnappliedLedgerEvents(limit: number): Promise<LedgerRow[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, idempotency_key, type, subscription_id, company_id, raw_payload, applied_at, created_at `
      + `FROM ${NS}.billing_events WHERE applied_at IS NULL ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return rows.map(mapLedger);
  }

  async listLedgerEventsForCompany(companyId: string, limit: number): Promise<LedgerRow[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id, idempotency_key, type, subscription_id, company_id, raw_payload, applied_at, created_at `
      + `FROM ${NS}.billing_events WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [companyId, limit],
    );
    return rows.map(mapLedger);
  }

  async ownerHadTrial(ownerUserId: string): Promise<boolean> {
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT id FROM ${NS}.billing_events WHERE type = 'trial.started' AND raw_payload->>'ownerUserId' = $1 LIMIT 1`,
      [ownerUserId],
    );
    return rows.length > 0;
  }
}
