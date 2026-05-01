import { pgEnum, pgTable, uuid, text, integer, timestamp, index, unique } from "drizzle-orm/pg-core";
import { jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const creditEventTypeEnum = pgEnum("credit_event_type", [
  "subscription_grant",
  "purchase",
  "burn",
  "refund",
  "adjustment",
]);

export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => companies.id),
    eventType: creditEventTypeEnum("event_type").notNull(),
    // positive = credit, negative = debit
    amount: integer("amount").notNull(),
    billingPeriodStart: timestamp("billing_period_start", { withTimezone: true }),
    billingPeriodEnd: timestamp("billing_period_end", { withTimezone: true }),
    metadata: jsonb("metadata").$type<{
      runId?: string;
      agentId?: string;
      actionType?: string;
      stripeInvoiceId?: string;
      stripeSubscriptionId?: string;
      [key: string]: unknown;
    } | null>(),
    // Ties to agent run ID to prevent double-burns
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUq: unique("credit_ledger_idempotency_key_uq").on(table.idempotencyKey),
    accountCreatedIdx: index("credit_ledger_account_created_idx").on(table.accountId, table.createdAt),
    accountEventTypeIdx: index("credit_ledger_account_event_type_idx").on(table.accountId, table.eventType),
    accountBillingPeriodIdx: index("credit_ledger_account_billing_period_idx").on(
      table.accountId,
      table.billingPeriodStart,
      table.billingPeriodEnd,
    ),
  }),
);
