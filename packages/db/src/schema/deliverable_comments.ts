import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { deliverables } from "./deliverables.js";
import { deliverableReviewStages } from "./deliverable_review_stages.js";
import { agents } from "./agents.js";

export const deliverableComments = pgTable(
  "deliverable_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliverableId: uuid("deliverable_id").notNull().references(() => deliverables.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id").references(() => deliverableReviewStages.id, { onDelete: "set null" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliverableIdx: index("idx_deliverable_comments_deliverable").on(table.deliverableId),
  }),
);
