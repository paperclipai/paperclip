import { index, pgTable, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { assets } from "./assets.js";
import { companies } from "./companies.js";

export const agentAvatars = pgTable(
  "agent_avatars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("agent_avatars_company_idx").on(table.companyId),
    agentUq: uniqueIndex("agent_avatars_agent_uq").on(table.agentId),
    assetUq: uniqueIndex("agent_avatars_asset_uq").on(table.assetId),
  }),
);
