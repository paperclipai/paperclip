import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export const identityMaps = pgTable(
  "identity_maps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    neoreefId: text("neoreef_id"),
    zohoId: text("zoho_id"),
    paperclipUserId: text("paperclip_user_id").references(() => authUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("identity_maps_company_idx").on(table.companyId),
    neoreefIdIdx: index("identity_maps_neoreef_id_idx").on(table.neoreefId),
    zohoIdIdx: index("identity_maps_zoho_id_idx").on(table.zohoId),
    paperclipUserIdIdx: index("identity_maps_paperclip_user_id_idx").on(table.paperclipUserId),
  })
);
