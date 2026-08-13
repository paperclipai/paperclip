import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Long-range planning blocks (the imported Miro board). Blocks are their own
 * lightweight entities; promoting one creates an initiative/epic goal row and
 * adds a roadmap_block_links row (a block can mirror several goals).
 * Positions are shared team state, not per-user.
 */
export const roadmapBlocks = pgTable(
  "roadmap_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    detail: text("detail"),
    status: text("status").notNull().default("planned"),
    x: integer("x").notNull().default(0),
    y: integer("y").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("roadmap_blocks_company_idx").on(table.companyId),
  }),
);
