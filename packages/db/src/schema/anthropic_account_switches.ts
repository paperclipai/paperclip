import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { anthropicAccounts } from "./anthropic_accounts.js";

export const anthropicAccountSwitches = pgTable(
  "anthropic_account_switches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: text("run_id"),
    fromAccountId: uuid("from_account_id").references(() => anthropicAccounts.id, {
      onDelete: "set null",
    }),
    toAccountId: uuid("to_account_id")
      .notNull()
      .references(() => anthropicAccounts.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    switchedAt: timestamp("switched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    toAccountIdx: index("anthropic_account_switches_to_account_idx").on(table.toAccountId),
    switchedAtIdx: index("anthropic_account_switches_switched_at_idx").on(table.switchedAt),
  }),
);

export type AnthropicAccountSwitch = typeof anthropicAccountSwitches.$inferSelect;
export type NewAnthropicAccountSwitch = typeof anthropicAccountSwitches.$inferInsert;
