import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";

export const crewbriefWaitlistEntries = pgTable(
  "crewbrief_waitlist_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull(),
    organization: text("organization"),
    source: text("source").notNull().default("direct"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmTerm: text("utm_term"),
    utmContent: text("utm_content"),
    referralCode: text("referral_code").notNull().unique(),
    queuePosition: integer("queue_position").notNull(),
    referralCount: integer("referral_count").notNull().default(0),
    tier: text("tier").notNull().default("standard"),
    status: text("status").notNull().default("waitlisted"),
    hubspotContactId: text("hubspot_contact_id"),
    lastActiveDate: timestamp("last_active_date", { withTimezone: true }),
    betaActivatedAt: timestamp("beta_activated_at", { withTimezone: true }),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: uniqueIndex("cb_waitlist_email_idx").on(table.email),
    statusIdx: index("cb_waitlist_status_idx").on(table.status),
    referralCodeIdx: uniqueIndex("cb_waitlist_ref_code_idx").on(table.referralCode),
  }),
);

export const crewbriefReferrals = pgTable(
  "crewbrief_referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerId: uuid("referrer_id").notNull().references(() => crewbriefWaitlistEntries.id),
    refereeEmail: text("referee_email").notNull(),
    refereeId: uuid("referee_id").references(() => crewbriefWaitlistEntries.id),
    referralCode: text("referral_code").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
  },
  (table) => ({
    referrerIdx: index("cb_ref_referrer_idx").on(table.referrerId),
    refereeEmailIdx: index("cb_ref_referee_email_idx").on(table.refereeEmail),
  }),
);

export const crewbriefEmailLog = pgTable(
"crewbrief_email_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    waitlistEntryId: uuid("waitlist_entry_id").references(() => crewbriefWaitlistEntries.id),
    email: text("email").notNull(),
    templateName: text("template_name").notNull(),
    subject: text("subject").notNull(),
    status: text("status").notNull().default("sent"),
    providerMessageId: text("provider_message_id"),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailIdx: index("cb_email_email_idx").on(table.email),
    templateIdx: index("cb_email_template_idx").on(table.templateName, table.email),
  }),
);

export const crewbriefHubspotSync = pgTable(
  "crewbrief_hubspot_sync",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    hubspotId: text("hubspot_id").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    syncStatus: text("sync_status").notNull().default("synced"),
    syncPayload: text("sync_payload"),
  },
  (table) => ({
    entityIdx: index("cb_hs_entity_idx").on(table.entityType, table.entityId),
    hubspotIdx: index("cb_hs_hubspot_idx").on(table.hubspotId),
  }),
);
