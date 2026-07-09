import { pgTable, uuid, text, timestamp, jsonb, primaryKey, index } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";
import { securityAuditLog } from "./security_audit_log.js";

export const forceReassignIdempotency = pgTable(
  "force_reassign_idempotency",
  {
    companyId: text("company_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    issueId: uuid("issue_id").references(() => issues.id),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    auditId: uuid("audit_id").references(() => securityAuditLog.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.idempotencyKey] }),
    createdAtIdx: index("force_reassign_idempotency_created_idx").on(table.createdAt),
  }),
);