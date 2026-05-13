import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const bootstrapTokens = pgTable(
  "bootstrap_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    agentId: uuid("agent_id").notNull(),
    companyId: uuid("company_id").notNull(),
    runId: text("run_id").notNull(),
    jobUid: text("job_uid").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex("bootstrap_tokens_token_hash_idx").on(t.tokenHash),
    runIdIdx:     index("bootstrap_tokens_run_id_idx").on(t.runId),
    expiresIdx:   index("bootstrap_tokens_expires_idx").on(t.expiresAt),
  }),
);
