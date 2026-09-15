import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agencyWebhookConfigs } from "./agency_webhook_configs.js";

export const agencyTrialStatusEnum = pgEnum("agency_trial_status", [
  "active",
  "expired",
  "converted",
  "cancelled",
]);

export const agencyTrialEmailTypeEnum = pgEnum("agency_trial_email_type", [
  "welcome",
  "day7",
  "day25",
  "upgrade_confirmation",
]);

export const agencyTrials = pgTable(
  "agency_trials",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    agencyWebhookConfigId: uuid("agency_webhook_config_id")
      .notNull()
      .references(() => agencyWebhookConfigs.id, { onDelete: "cascade" }),
    contactEmail: text("contact_email").notNull(),
    contactName: text("contact_name"),
    trialStatus: agencyTrialStatusEnum("trial_status").notNull().default("active"),
    incidentCount: integer("incident_count").notNull().default(0),
    incidentCap: integer("incident_cap").notNull().default(1000),
    trialStartedAt: timestamp("trial_started_at", { withTimezone: true }).notNull().defaultNow(),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }).notNull(),
    upgradedAt: timestamp("upgraded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusEndsIdx: index("agency_trials_status_ends_idx").on(t.trialStatus, t.trialEndsAt),
    configIdx: index("agency_trials_config_idx").on(t.agencyWebhookConfigId),
  }),
);

export const agencyTrialEmails = pgTable("agency_trial_emails", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),
  trialId: uuid("trial_id")
    .notNull()
    .references(() => agencyTrials.id, { onDelete: "cascade" }),
  emailType: agencyTrialEmailTypeEnum("email_type").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});
