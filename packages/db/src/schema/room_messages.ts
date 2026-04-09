import { type AnyPgColumn, pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { rooms } from "./rooms.js";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";

export const roomMessages = pgTable(
  "room_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    senderAgentId: uuid("sender_agent_id").references(() => agents.id),
    senderUserId: text("sender_user_id"),
    type: text("type").notNull(),
    body: text("body").notNull(),
    actionPayload: jsonb("action_payload").$type<Record<string, unknown>>(),
    actionStatus: text("action_status"),
    actionTargetAgentId: uuid("action_target_agent_id").references(() => agents.id),
    // Phase 4 prep: action execution audit trail. Populated when an action
    // transitions pending → executed | failed.
    actionResult: jsonb("action_result").$type<Record<string, unknown>>(),
    actionError: text("action_error"),
    actionExecutedAt: timestamp("action_executed_at", { withTimezone: true }),
    actionExecutedByAgentId: uuid("action_executed_by_agent_id").references(() => agents.id),
    actionExecutedByUserId: text("action_executed_by_user_id"),
    // Phase 5.2f — when an action message requires human sign-off, the
    // message carries a FK to the `approvals` row that gates it. Null
    // for text messages and for action messages created without a
    // requires_approval flag.
    //
    // Hardening (0068): FK is `ON DELETE RESTRICT`, not SET NULL. A
    // SET NULL would silently un-gate a message if its approval was
    // ever deleted — the runtime check in updateActionStatus keys on
    // `approvalId !== null`. RESTRICT fails loudly instead.
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "restrict" }),
    attachments: jsonb("attachments").$type<
      Array<{
        assetId: string;
        name: string;
        contentType: string;
        size: number;
        url: string;
        thumbnailUrl?: string | null;
      }>
    >(),
    replyToId: uuid("reply_to_id").references((): AnyPgColumn => roomMessages.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roomCreatedIdx: index("room_messages_room_created_idx").on(table.roomId, table.createdAt),
    companyIdx: index("room_messages_company_idx").on(table.companyId),
    actionStatusIdx: index("room_messages_action_status_idx").on(table.companyId, table.actionStatus),
    approvalIdx: index("room_messages_approval_idx").on(table.approvalId),
  }),
);
