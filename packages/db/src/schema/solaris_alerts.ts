import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyCreatedIdx: index("solaris_alerts_company_created_idx").on(t.companyId, t.createdAt),
    orgIdx: index("solaris_alerts_org_idx").on(t.orgId),
  }),
);
