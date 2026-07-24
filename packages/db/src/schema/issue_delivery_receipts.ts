import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/** A requester-visible acknowledgement of a specific delivered revision. */
export const issueDeliveryReceipts = pgTable(
  "issue_delivery_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    producerIssueId: uuid("producer_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    primaryWorkProductKey: text("primary_work_product_key").notNull(),
    revision: text("revision").notNull(),
    /** Stable digest of the requester-visible terminal output. */
    outputDigest: text("output_digest").notNull(),
    format: text("format").notNull(),
    summary: text("summary").notNull(),
    inlineText: text("inline_text"),
    inspectionUrl: text("inspection_url"),
    documentOnly: boolean("document_only").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceLookupIdx: index("issue_delivery_receipts_source_lookup_idx").on(table.companyId, table.sourceIssueId),
    receiptIdentityUq: uniqueIndex("issue_delivery_receipts_identity_uq").on(
      table.companyId,
      table.sourceIssueId,
      table.primaryWorkProductKey,
      table.revision,
      table.outputDigest,
    ),
  }),
);
