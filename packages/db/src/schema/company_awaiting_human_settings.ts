import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { EnvSecretRefBinding } from "@paperclipai/shared";
import { companies } from "./companies.js";

export type AwaitingHumanProviderRecord = "clickup";

export interface ClickUpAwaitingHumanProviderConfigRecord {
  authTokenRef: EnvSecretRefBinding | null;
  workspaceId: string | null;
  channelId: string | null;
  attachmentTaskId: string | null;
  primaryReviewerUserId: string | null;
  secondaryReviewerUserId: string | null;
}

export type AwaitingHumanProviderConfigRecord = ClickUpAwaitingHumanProviderConfigRecord;

export const companyAwaitingHumanSettings = pgTable(
  "company_awaiting_human_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    provider: text("provider").$type<AwaitingHumanProviderRecord | null>(),
    providerConfigJson: jsonb("provider_config_json").$type<AwaitingHumanProviderConfigRecord | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("company_awaiting_human_settings_company_uq").on(table.companyId),
  }),
);
