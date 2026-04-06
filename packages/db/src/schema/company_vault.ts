import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Company Vault — stores secrets automatically detected from issue comments
 * (API keys, passwords, LLM keys, tokens, etc.) and masks them in the UI.
 */
export const companyVault = pgTable(
  "company_vault",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    /** Human-readable label for this secret (e.g. "OpenAI API Key", "GitHub Token") */
    label: text("label").notNull(),
    /** The category of the secret: "api_key" | "password" | "llm_key" | "token" | "other" */
    category: text("category").notNull().default("other"),
    /** The actual secret value (encrypted at rest via application-level encryption) */
    secretValue: text("secret_value").notNull(),
    /** A masked preview, e.g. "sk-...abc123" */
    maskedPreview: text("masked_preview").notNull(),
    /** Where the secret was detected: "comment", "manual" */
    source: text("source").notNull().default("comment"),
    /** The issue comment ID where the secret was detected (if source=comment) */
    sourceCommentId: uuid("source_comment_id"),
    /** The issue ID where the secret was detected */
    sourceIssueId: uuid("source_issue_id"),
    /** Who/what added the secret: agent ID or user ID */
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_vault_company_idx").on(table.companyId),
    companyCategoryIdx: index("company_vault_company_category_idx").on(
      table.companyId,
      table.category,
    ),
  }),
);
