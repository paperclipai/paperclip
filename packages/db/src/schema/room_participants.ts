import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { rooms } from "./rooms.js";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const roomParticipants = pgTable(
  "room_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    userId: text("user_id"),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roomIdx: index("room_participants_room_idx").on(table.roomId),
    companyIdx: index("room_participants_company_idx").on(table.companyId),
    roomAgentUniq: uniqueIndex("room_participants_room_agent_uniq").on(table.roomId, table.agentId),
    agentIdx: index("room_participants_agent_idx").on(table.agentId),
  }),
);
