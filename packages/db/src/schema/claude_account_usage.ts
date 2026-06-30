import { pgTable, text, boolean, integer, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Per-account Claude subscription usage snapshots (TWX-1117 / TWX-1118).
 *
 * Host-singleton: one row per `~/.claude/auth-profiles/*` profile on this host,
 * upserted on each probe. `profile` (the credentials filename stem) is the
 * primary key. Stores only derived usage metrics — never OAuth tokens.
 */
export const claudeAccountUsage = pgTable(
  "claude_account_usage",
  {
    profile: text("profile").primaryKey(),
    email: text("email"),
    subscriptionType: text("subscription_type"),
    tier: text("tier").notNull().default("unknown"),
    active: boolean("active").notNull().default(false),
    fiveHourPct: integer("five_hour_pct"),
    fiveHourResetsAt: timestamp("five_hour_resets_at", { withTimezone: true }),
    sevenDayPct: integer("seven_day_pct"),
    sevenDayResetsAt: timestamp("seven_day_resets_at", { withTimezone: true }),
    sevenDayOpusPct: integer("seven_day_opus_pct"),
    sevenDayOpusResetsAt: timestamp("seven_day_opus_resets_at", { withTimezone: true }),
    sevenDaySonnetPct: integer("seven_day_sonnet_pct"),
    sevenDaySonnetResetsAt: timestamp("seven_day_sonnet_resets_at", { withTimezone: true }),
    source: text("source").notNull().default("error"),
    error: text("error"),
    probedAt: timestamp("probed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    probedAtIdx: index("claude_account_usage_probed_at_idx").on(table.probedAt),
  }),
);
