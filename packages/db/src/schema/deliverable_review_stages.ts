import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { deliverables } from "./deliverables.js";
import { agents } from "./agents.js";

export const deliverableReviewStages = pgTable(
  "deliverable_review_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliverableId: uuid("deliverable_id").notNull().references(() => deliverables.id, { onDelete: "cascade" }),
    stageIndex: integer("stage_index").notNull(),
    label: text("label").notNull(),
    reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id, { onDelete: "set null" }),
    reviewerUserId: text("reviewer_user_id"),
    status: text("status").notNull().default("pending"),
    decisionNote: text("decision_note"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliverableStageUniqueIdx: uniqueIndex("idx_deliverable_review_stages_unique").on(table.deliverableId, table.stageIndex),
    deliverableIdx: index("idx_deliverable_review_stages_deliverable").on(table.deliverableId),
  }),
);
