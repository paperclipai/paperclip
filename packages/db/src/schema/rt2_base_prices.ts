import { index, integer, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Base prices for deliverable types - used for AI Auto evaluation
 * M4.1: 기준가 ±10% 구간 자동 처리
 *
 * Each company can define base prices for different deliverable types.
 * When AI evaluates a deliverable, the score is compared against the
 * expected value (basePrice * aiScore/100) to determine if it's
 * within the auto-approval band.
 */
export const rt2BasePrices = pgTable(
  "rt2_base_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Deliverable type (e.g., 'code_review', 'bug_fix', 'feature_delivery') */
    deliverableType: text("deliverable_type").notNull(),
    /** Base price in gold units */
    basePrice: integer("base_price").notNull(),
    /** Auto-approve threshold (default 0.1 = ±10%) */
    autoApproveThreshold: real("auto_approve_threshold").notNull().default(0.1),
    /** Is this base price active? */
    isActive: integer("is_active").notNull().default(1), // 1 = active, 0 = inactive
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTypeIdx: index("rt2_base_prices_company_type_idx").on(table.companyId, table.deliverableType),
    companyActiveIdx: index("rt2_base_prices_company_active_idx").on(table.companyId, table.isActive),
  }),
);

/** Default base prices by deliverable type (gold units) */
export const DEFAULT_BASE_PRICES: Record<string, number> = {
  code_review: 50,
  bug_fix: 30,
  feature_delivery: 100,
  documentation: 40,
  testing: 35,
  research: 60,
  design: 80,
  deployment: 45,
  meeting: 20,
  default: 50,
};
