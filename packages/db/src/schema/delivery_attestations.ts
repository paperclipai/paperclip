import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const deliveryAttestations = pgTable(
  "delivery_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    declarationRevision: integer("declaration_revision").notNull(),
    targetFingerprint: text("target_fingerprint").notNull(),
    outcome: text("outcome").$type<"succeeded" | "failed">().notNull(),
    deliveredRevision: text("delivered_revision"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: uniqueIndex("delivery_attestations_run_idx").on(table.runId),
    issueOutcomeIdx: index("delivery_attestations_issue_outcome_idx").on(
      table.companyId,
      table.issueId,
      table.outcome,
      table.createdAt,
    ),
  }),
);
