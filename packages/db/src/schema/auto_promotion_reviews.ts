/**
 * Plan 4 — append-only auto-promotion review trail.
 *
 * Each call to paperclip_review_auto_promotion writes one row.
 * Multiple reviews per audit row are allowed (operator can re-inspect
 * later). Powers "which audits have never been reviewed?" queries.
 */
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

import { autoPromotionAudit } from "./auto_promotion_audit.js";

export const autoPromotionReviews = pgTable(
  "auto_promotion_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => autoPromotionAudit.id, { onDelete: "cascade" }),
    reviewerId: text("reviewer_id").notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    context: text("context"),
  },
  (table) => ({
    auditIdx: index("auto_promotion_reviews_audit_idx").on(table.auditId),
    reviewedAtIdx: index("auto_promotion_reviews_reviewed_at_idx").on(
      table.reviewedAt.desc(),
    ),
  }),
);
