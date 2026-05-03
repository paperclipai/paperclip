import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const providerRateLimitBlocks = pgTable(
  "provider_rate_limit_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    adapterType: text("adapter_type").notNull(),
    limitKind: text("limit_kind").notNull(),
    modelFamily: text("model_family"),
    message: text("message"),
    resetsAt: timestamp("resets_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAdapterIdx: index("provider_rate_limit_blocks_company_adapter_idx")
      .on(table.companyId, table.adapterType),
    companyAdapterResolvedIdx: index("provider_rate_limit_blocks_resolved_idx")
      .on(table.companyId, table.adapterType, table.resolvedAt),
  }),
);
