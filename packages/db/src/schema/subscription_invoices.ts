import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySubscriptions } from "./company_subscriptions.js";

export const subscriptionInvoices = pgTable(
  "subscription_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    subscriptionId: uuid("subscription_id").notNull().references(() => companySubscriptions.id),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    invoiceNumber: text("invoice_number"),
    status: text("status").notNull().default("draft"),
    amountCents: integer("amount_cents").notNull().default(0),
    amountPaidCents: integer("amount_paid_cents").notNull().default(0),
    amountRemainingCents: integer("amount_remaining_cents").notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    invoicePdfUrl: text("invoice_pdf_url"),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("subscription_invoices_company_idx").on(table.companyId),
    stripeInvoiceIdx: uniqueIndex("subscription_invoices_stripe_invoice_idx").on(table.stripeInvoiceId),
    subscriptionIdx: index("subscription_invoices_subscription_idx").on(table.subscriptionId),
  }),
);
