import { pgTable, uuid, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { estateTrusts } from "./estate_trusts.js";
import { estateAssets } from "./estate_assets.js";

export const estateTrustAssets = pgTable(
  "estate_trust_assets",
  {
    trustId: uuid("trust_id").notNull().references(() => estateTrusts.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => estateAssets.id, { onDelete: "cascade" }),
    transferDate: timestamp("transfer_date", { withTimezone: true }),
    transferDeedDocId: text("transfer_deed_doc_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.trustId, table.assetId] }),
  }),
);
