import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const companyLlmSettings = pgTable(
  "company_llm_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),

    // Preferred provider (e.g., "openrouter")
    // If null, falls back to platform default
    preferredProviderType: text("preferred_provider_type"),

    // Preferred model name (provider-specific)
    // e.g., "openrouter/meta-llama/llama-2-70b-chat"
    preferredModelId: text("preferred_model_id"),

    // Additional settings (future use)
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: uniqueIndex("company_llm_settings_company_id_idx").on(table.companyId),
  }),
);
