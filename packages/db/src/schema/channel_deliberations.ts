import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agentChannels } from "./agent_channels.js";
import { agents } from "./agents.js";

export const channelDeliberations = pgTable(
  "channel_deliberations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id").notNull().references(() => agentChannels.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    /** open | synthesized | closed */
    status: text("status").notNull().default("open"),
    synthesisText: text("synthesis_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("channel_deliberations_company_idx").on(table.companyId),
    channelIdx: index("channel_deliberations_channel_idx").on(table.channelId),
    statusIdx: index("channel_deliberations_status_idx").on(table.companyId, table.status),
  }),
);

export const channelDeliberationPositions = pgTable(
  "channel_deliberation_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliberationId: uuid("deliberation_id").notNull().references(() => channelDeliberations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    positionText: text("position_text").notNull(),
    evidenceText: text("evidence_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliberationIdx: index("channel_deliberation_positions_delib_idx").on(table.deliberationId),
  }),
);

export const channelDeliberationRebuttals = pgTable(
  "channel_deliberation_rebuttals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliberationId: uuid("deliberation_id").notNull().references(() => channelDeliberations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    targetPositionId: uuid("target_position_id").notNull().references(() => channelDeliberationPositions.id, { onDelete: "cascade" }),
    rebuttalText: text("rebuttal_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliberationIdx: index("channel_deliberation_rebuttals_delib_idx").on(table.deliberationId),
  }),
);
