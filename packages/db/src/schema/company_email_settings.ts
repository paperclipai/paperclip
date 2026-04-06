import { pgTable, uuid, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Company Email Settings — stores AgentMail configuration for the
 * Company Communication Center.
 */
export const companyEmailSettings = pgTable("company_email_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id)
    .unique(),
  /** AgentMail API key (encrypted at rest) */
  agentmailApiKey: text("agentmail_api_key"),
  /** AgentMail inbox ID for the company */
  agentmailInboxId: text("agentmail_inbox_id"),
  /** The email address for the company inbox (e.g. company@agentmail.to) */
  agentmailEmail: text("agentmail_email"),
  /** Display name for the inbox */
  agentmailDisplayName: text("agentmail_display_name"),
  /** Whether the Communication Center is enabled */
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
