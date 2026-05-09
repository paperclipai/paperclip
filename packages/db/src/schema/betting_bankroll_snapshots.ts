import { pgTable, uuid, text, timestamp, doublePrecision, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const bettingBankrollSnapshots = pgTable(
  "betting_bankroll_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    balance: doublePrecision("balance").notNull(),
    currency: text("currency").notNull().default("RON"),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
    totalBets: integer("total_bets").notNull().default(0),
    wonBets: integer("won_bets").notNull().default(0),
    lostBets: integer("lost_bets").notNull().default(0),
    voidBets: integer("void_bets").notNull().default(0),
    totalStaked: doublePrecision("total_staked").notNull().default(0),
    totalReturn: doublePrecision("total_return").notNull().default(0),
    roi: doublePrecision("roi"),
  },
  (table) => ({
    companySnapshotAtIdx: index("betting_bankroll_snapshots_company_snapshot_at_idx").on(table.companyId, table.snapshotAt),
  }),
);
