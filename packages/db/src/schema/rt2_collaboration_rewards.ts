import { pgTable, uuid, text, timestamp, integer, real, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Collaboration rewards - tracks reputation and multipliers per user/agent
 */
export const rt2CollaborationRewards = pgTable(
  "rt2_collaboration_rewards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // userId or agentId depending on actorType
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(), // 'user' or 'agent'
    // Reputation index (0-1000 scale, starts at 500)
    reputationIndex: integer("reputation_index").notNull().default(500),
    // Collaboration multiplier (1.0 - 1.5)
    multiplier: real("multiplier").notNull().default(1.0),
    // AI contribution score (0-100)
    aiContributionScore: integer("ai_contribution_score").notNull().default(0),
    // Collaboration stats
    totalCollaborations: integer("total_collaborations").notNull().default(0),
    successfulCollaborations: integer("successful_collaborations").notNull().default(0),
    // Timestamps
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyActorIdx: index("collab_rewards_company_actor_idx").on(table.companyId, table.actorId),
    companyReputationIdx: index("collab_rewards_company_reputation_idx").on(table.companyId, table.reputationIndex),
  }),
);

/**
 * Collaboration event log - tracks individual collaboration events
 */
export const rt2CollaborationEvents = pgTable(
  "rt2_collaboration_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // The actor who received the collaboration reward
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(), // 'user' or 'agent'
    // The work product/deliverable they collaborated on
    workProductId: uuid("work_product_id").references(() => agents.id, { onDelete: "set null" }),
    // Collaboration type
    collaborationType: text("collaboration_type").notNull(), // 'peer_review', 'pair_work', 'knowledge_sharing', 'help_provided'
    // Whether it was successful
    successful: text("successful").notNull().default("pending"), // 'pending', 'yes', 'no'
    // Points earned from this collaboration
    pointsEarned: integer("points_earned").notNull().default(0),
    // Reputation change (positive or negative)
    reputationChange: integer("reputation_change").notNull().default(0),
    // Description of the collaboration
    description: text("description"),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyActorIdx: index("collab_events_company_actor_idx").on(table.companyId, table.actorId),
    companyWorkProductIdx: index("collab_events_company_work_product_idx").on(table.companyId, table.workProductId),
  }),
);
