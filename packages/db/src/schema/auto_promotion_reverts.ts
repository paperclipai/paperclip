/**
 * Plan 4 — frozen auto-promotion revert record.
 *
 * One row per revert. Immutable (append-only trigger). UNIQUE(audit_id)
 * enforces "one revert per decision, ever". A reverted skill cannot be
 * re-auto-promoted (UNIQUE(skill_id) on audit ensures that); operator
 * manual promote is the safety valve.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { autoPromotionAudit } from "./auto_promotion_audit.js";

export const autoPromotionReverts = pgTable(
  "auto_promotion_reverts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => autoPromotionAudit.id, { onDelete: "cascade" }),
    revertedAt: timestamp("reverted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revertedBy: text("reverted_by").notNull(),
    reason: text("reason").notNull(),
  },
  (table) => ({
    revertedAtIdx: index("auto_promotion_reverts_reverted_at_idx").on(
      table.revertedAt.desc(),
    ),
    uniqueAudit: unique("auto_promotion_reverts_audit_unique").on(table.auditId),
    reasonLenCheck: check(
      "auto_promotion_reverts_reason_len_check",
      sql`length(${table.reason}) BETWEEN 1 AND 2000`,
    ),
  }),
);
