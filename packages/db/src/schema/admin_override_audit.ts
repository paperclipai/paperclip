import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";

export const adminOverrideAudit = pgTable(
  "admin_override_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    overrideJwtJti: text("override_jwt_jti").notNull().unique(),
    principalUserId: uuid("principal_user_id").notNull(),
    originIp: text("origin_ip").notNull(),
    userAgent: text("user_agent"),
    reason: text("reason").notNull(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "restrict" }),
    oldStatus: text("old_status").notNull(),
    newStatus: text("new_status").notNull(),
    requestId: text("request_id").notNull(),
    jwtIat: timestamp("jwt_iat", { withTimezone: true }).notNull(),
    jwtExp: timestamp("jwt_exp", { withTimezone: true }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tsIdx: index("admin_override_audit_ts_idx").on(table.ts),
    principalTsIdx: index("admin_override_audit_principal_ts_idx").on(table.principalUserId, table.ts),
    issueTsIdx: index("admin_override_audit_issue_ts_idx").on(table.issueId, table.ts),
    reasonMinLength: check(
      "admin_override_reason_min_length",
      sql`char_length(${table.reason}) >= 20`,
    ),
    expGtIat: check("admin_override_exp_gt_iat", sql`${table.jwtExp} > ${table.jwtIat}`),
    ttlMax: check(
      "admin_override_ttl_max",
      sql`${table.jwtExp} - ${table.jwtIat} <= interval '5 minutes'`,
    ),
  }),
);
