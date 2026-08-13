import { pgTable, uuid, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { roadmapBlocks } from "./roadmap_blocks.js";

/** "Unlocks" edges between roadmap blocks: from -> to reads "completing from opens to". */
export const roadmapBlockEdges = pgTable(
  "roadmap_block_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    fromBlockId: uuid("from_block_id").notNull().references(() => roadmapBlocks.id, { onDelete: "cascade" }),
    toBlockId: uuid("to_block_id").notNull().references(() => roadmapBlocks.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("roadmap_block_edges_company_idx").on(table.companyId),
    edgeUq: uniqueIndex("roadmap_block_edges_company_edge_uq").on(table.companyId, table.fromBlockId, table.toBlockId),
  }),
);
