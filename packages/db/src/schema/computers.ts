import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

/** One row is the serialization boundary for a shared, externally owned computer. */
export const computers = pgTable(
  "computers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "restrict" }),
    provider: text("provider").notNull().default("boat"),
    providerId: text("provider_id").notNull(),
    ledger: jsonb("ledger").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    physical: uniqueIndex("computers_physical_uq").on(
      table.provider,
      table.providerId,
    ),
    environment: uniqueIndex("computers_environment_uq").on(
      table.environmentId,
    ),
    company: index("computers_company_idx").on(table.companyId),
  }),
);
