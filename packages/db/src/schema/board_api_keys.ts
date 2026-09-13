import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { BoardApiKeyScopeConfig } from "@paperclipai/shared";
import { authUsers } from "./auth.js";

export const boardApiKeys = pgTable(
  "board_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    scopeConfig: jsonb("scope_config").$type<BoardApiKeyScopeConfig | null>(),
    tokenPrefix: text("token_prefix"),
    legacyUnrestricted: boolean("legacy_unrestricted").notNull().default(false),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyHashIdx: uniqueIndex("board_api_keys_key_hash_idx").on(table.keyHash),
    userIdx: index("board_api_keys_user_idx").on(table.userId),
    scopeLegacyInvariant: check(
      "board_api_keys_scope_legacy_check",
      sql`(${table.legacyUnrestricted} = true and ${table.scopeConfig} is null) or (${table.legacyUnrestricted} = false and ${table.scopeConfig} is not null)`,
    ),
  }),
);
