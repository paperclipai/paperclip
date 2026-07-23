import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { CompanyStandingStatus } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

/**
 * `company_standing` table — one row per (company, plugin) pair written by a
 * plugin holding `company.standing.write` (billing, compliance, quota, …).
 *
 * Row-per-plugin so plugins cannot clobber each other; the effective standing
 * for a company is the most severe row (`blocked` > `grace` > `active`), and
 * no rows means `active` (fail-safe — a crashed or removed plugin can never
 * leave a company stranded; cleanup hooks delete rows on uninstall/disable).
 */
export const companyStanding = pgTable(
  "company_standing",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    status: text("status").$type<CompanyStandingStatus>().notNull(),
    /** Short machine code, e.g. `subscription_lapsed`. */
    reason: text("reason").notNull(),
    /** Human text shown in banners/errors. */
    message: text("message").notNull(),
    /** Optional deep link, e.g. the billing page. */
    actionUrl: text("action_url"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.pluginId] }),
    companyIdx: index("company_standing_company_idx").on(table.companyId),
    pluginIdx: index("company_standing_plugin_idx").on(table.pluginId),
  }),
);
