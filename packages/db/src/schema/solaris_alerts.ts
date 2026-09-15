import { boolean, doublePrecision, index, jsonb, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";


export const responderStatusEnum = pgEnum("responder_status", ["acknowledged", "en_route", "on_scene", "cleared"]);


export const alertSeverityEnum = pgEnum("alert_severity", ["critical", "warning", "info"]);
export const alertDispatchStatusEnum = pgEnum("alert_dispatch_status", ["pending", "translating", "ready", "failed"]);

export const solarisOrgs = pgTable(
  "solaris_orgs",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    preferredLanguage: varchar("preferred_language", { length: 10 }).notNull().default("en"),
    contactEmail: text("contact_email"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("solaris_orgs_company_idx").on(t.companyId, t.isActive),
  }),
);

export const solarisAlerts = pgTable(
  "solaris_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => solarisOrgs.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    severity: alertSeverityEnum("severity").notNull().default("info"),
    translatedBodies: jsonb("translated_bodies"),
    dispatchStatus: alertDispatchStatusEnum("dispatch_status").notNull().default("pending"),
    capIdentifier: text("cap_identifier"),
    incidentArea: text("incident_area"),
    createdBy: text("created_by"),
    // CAD dispatch fields (IUN-2751)
    incidentId: text("incident_id").unique(),
    incidentName: text("incident_name"),
    incidentType: text("incident_type"),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    source: text("source").notNull().default("solaris"),
    // Alert triage fields (IUN-2885)
    assigneeId: text("assignee_id"),
    assigneeName: text("assignee_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyCreatedIdx: index("solaris_alerts_company_created_idx").on(t.companyId, t.createdAt),
    orgIdx: index("solaris_alerts_org_idx").on(t.orgId),
  }),
);

export const alertNotes = pgTable(
  "alert_notes",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => solarisAlerts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorId: text("author_id"),
    authorName: text("author_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    alertCreatedIdx: index("alert_notes_alert_idx").on(t.alertId, t.createdAt),
  }),
);

export const incidentChatMessages = pgTable(
  "incident_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => solarisAlerts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorId: text("author_id"),
    authorName: text("author_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    alertCreatedIdx: index("incident_chat_messages_alert_idx").on(t.alertId, t.createdAt),
  }),
);

export const incidentActivityLog = pgTable(
  "incident_activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => solarisAlerts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    alertCreatedIdx: index("incident_activity_log_alert_idx").on(t.alertId, t.createdAt),
  }),
);

export const responderStatusUpdates = pgTable(
  "responder_status_updates",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => solarisAlerts.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    status: responderStatusEnum("status").notNull(),
    responderId: text("responder_id"),
    responderName: text("responder_name"),
    note: text("note"),
    eta: text("eta"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    alertCreatedIdx: index("responder_status_alert_idx").on(t.alertId, t.createdAt),
  }),
);

export const webPushSubscriptions = pgTable(
  "web_push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    responderId: text("responder_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("web_push_subscriptions_company_idx").on(t.companyId),
  }),
);
