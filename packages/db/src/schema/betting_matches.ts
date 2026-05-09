import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const bettingMatches = pgTable(
  "betting_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    externalId: text("external_id"),
    sport: text("sport").notNull(),
    league: text("league").notNull(),
    homeTeam: text("home_team").notNull(),
    awayTeam: text("away_team").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("upcoming"),
    oddsJson: jsonb("odds_json").$type<Record<string, unknown>>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStartsAtIdx: index("betting_matches_company_starts_at_idx").on(table.companyId, table.startsAt),
    externalIdIdx: index("betting_matches_external_id_idx").on(table.externalId),
  }),
);
