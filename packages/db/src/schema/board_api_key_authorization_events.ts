import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Instance-level board-key security decisions. Deliberately has no FK to the
 * key or owner: audit history must survive key revocation and owner deletion.
 * The details object is written only by the central gate from a fixed allowlist.
 */
export const boardApiKeyAuthorizationEvents = pgTable(
  "board_api_key_authorization_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardApiKeyId: uuid("board_api_key_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    tokenPrefix: text("token_prefix"),
    action: text("action").notNull(),
    classification: text("classification").notNull(),
    authoritativeCompanyId: uuid("authoritative_company_id"),
    authoritativeResourceType: text("authoritative_resource_type"),
    authoritativeResourceId: text("authoritative_resource_id"),
    decision: text("decision").notNull(),
    reason: text("reason").notNull(),
    requestId: text("request_id"),
    runId: uuid("run_id"),
    details: jsonb("details").$type<Record<string, string | boolean | null>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyCreatedIdx: index("board_api_key_authorization_events_key_created_idx").on(
      table.boardApiKeyId,
      table.createdAt.desc(),
    ),
    companyCreatedIdx: index("board_api_key_authorization_events_company_created_idx").on(
      table.authoritativeCompanyId,
      table.createdAt.desc(),
    ),
  }),
);
