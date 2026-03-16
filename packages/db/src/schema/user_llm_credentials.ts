import { pgTable, uuid, text, timestamp, boolean, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";

export const userLlmCredentials = pgTable(
  "user_llm_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(), // from better-auth users.id
    providerType: text("provider_type").notNull(), // openrouter, anthropic, openai, huggingface, ollama, custom

    // Encrypted payload: { scheme: "local_encrypted_v1", iv, tag, ciphertext }
    encryptedPayload: jsonb("encrypted_payload").$type<{ scheme: string; iv: string; tag: string; ciphertext: string }>().notNull(),

    // For validation/display
    keyFingerprint: text("key_fingerprint"), // Last 6 chars of key (e.g., "v1-abc")
    baseUrl: text("base_url"), // For custom providers only

    isActive: boolean("is_active").notNull().default(true),
    testedAt: timestamp("tested_at", { withTimezone: true }),
    testError: text("test_error"), // If last test failed, store error message

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userProviderIdx: uniqueIndex("user_llm_creds_user_provider_idx").on(table.userId, table.providerType),
    userIdIdx: index("user_llm_creds_user_id_idx").on(table.userId),
  }),
);
