import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const llmModelCache = pgTable(
  "llm_model_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerType: text("provider_type").notNull(),
    modelId: text("model_id").notNull(),

    // Full model metadata (from provider API)
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),

    // TTL: cache expires after this time
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerModelIdx: uniqueIndex("llm_model_cache_provider_model_idx").on(
      table.providerType,
      table.modelId,
    ),
  }),
);
