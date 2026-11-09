import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Instance-wide namespace tombstone, not company content or a credential.
// The public application ID and opaque original owner IDs intentionally have
// no cascading foreign keys. Deleting a company must not erase evidence of an
// unknown Discord UPSERT and let another endpoint claim that application.
// No token, command payload, user identity or private endpoint URL is retained.
export const chatDiscordCommandOwners = pgTable(
  "chat_discord_command_owners",
  {
    applicationId: text("application_id").primaryKey(),
    companyId: uuid("company_id").notNull(),
    endpointId: uuid("endpoint_id").notNull(),
    actionId: uuid("action_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "chat_discord_command_owners_application_check",
      sql`${table.applicationId} ~ '^[1-9][0-9]{16,19}$'`,
    ),
  ],
);
