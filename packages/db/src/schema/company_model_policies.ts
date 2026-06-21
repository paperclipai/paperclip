import { pgTable, uuid, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// One row per company. `rules` mirrors the PAPERCLIP_MODEL_POLICIES per-company
// array (ModelPolicyRule[] from server/src/services/model-policy.ts).
export const companyModelPolicies = pgTable(
  "company_model_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    rules: jsonb("rules").$type<unknown[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUniqueIdx: uniqueIndex("company_model_policies_company_uniq").on(table.companyId),
  }),
);
