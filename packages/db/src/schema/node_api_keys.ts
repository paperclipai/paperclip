import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { nodes } from "./nodes.js";
import { companies } from "./companies.js";

export const nodeApiKeys = pgTable(
  "node_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id").notNull().references(() => nodes.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyHashIdx: index("node_api_keys_key_hash_idx").on(table.keyHash),
    companyNodeIdx: index("node_api_keys_company_node_idx").on(table.companyId, table.nodeId),
  }),
);
