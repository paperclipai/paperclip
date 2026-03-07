import { pgTable, uuid, text, timestamp, jsonb, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Agent-to-agent messaging — the communication backbone.
 *
 * Enables direct and broadcast messaging between agents within a company.
 * Messages can be directed (agent → agent) or broadcast to a channel
 * that multiple agents subscribe to.
 */
export const agentMessages = pgTable(
  "agent_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Channel name for broadcast messages, e.g. "engineering", "all", or null for direct */
    channel: text("channel"),
    /** Sender agent ID */
    fromAgentId: uuid("from_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    /** Recipient agent ID (null = broadcast to channel) */
    toAgentId: uuid("to_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    /** Message type: "text", "request", "response", "notification", "decision" */
    messageType: text("message_type").notNull().default("text"),
    /** Message subject/topic */
    subject: text("subject"),
    /** Message body */
    body: text("body").notNull(),
    /** Structured payload (for machine-readable data) */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** Reference to a parent message (for threading) */
    parentMessageId: uuid("parent_message_id"),
    /** Reference to a related entity (task, issue, etc.) */
    referenceType: text("reference_type"),
    referenceId: uuid("reference_id"),
    /** Priority: "low", "normal", "high", "urgent" */
    priority: text("priority").notNull().default("normal"),
    /** Whether the recipient has acknowledged this message */
    acknowledged: boolean("acknowledged").notNull().default(false),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("agent_messages_company_idx").on(table.companyId),
    fromAgentIdx: index("agent_messages_from_agent_idx").on(table.fromAgentId),
    toAgentIdx: index("agent_messages_to_agent_idx").on(table.toAgentId),
    channelIdx: index("agent_messages_channel_idx").on(table.companyId, table.channel),
    parentIdx: index("agent_messages_parent_idx").on(table.parentMessageId),
    createdAtIdx: index("agent_messages_created_at_idx").on(table.createdAt),
  }),
);
