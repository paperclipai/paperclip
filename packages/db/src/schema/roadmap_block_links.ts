import { pgTable, uuid, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { roadmapBlocks } from "./roadmap_blocks.js";

/**
 * A roadmap block can mirror several goals at once (e.g. a board note that
 * spans two epics), so links live in their own join table.
 */
export const roadmapBlockLinks = pgTable(
  "roadmap_block_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    blockId: uuid("block_id").notNull().references(() => roadmapBlocks.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyBlockIdx: index("roadmap_block_links_company_block_idx").on(table.companyId, table.blockId),
    blockGoalUq: uniqueIndex("roadmap_block_links_block_goal_uq").on(table.blockId, table.goalId),
  }),
);
