import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const annotationTypeEnum = pgEnum("annotation_type", ["perimeter", "hazard", "resource", "note"]);
export const annotationSeverityEnum = pgEnum("annotation_severity", ["critical", "warning", "info"]);
export const annotationVisibilityEnum = pgEnum("annotation_visibility", ["org_wide", "admin_only"]);

export const annotations = pgTable(
  "annotations",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    authorId: text("author_id").notNull(),
    authorName: text("author_name"),
    label: text("label").notNull(),
    annotationType: annotationTypeEnum("annotation_type").notNull().default("note"),
    severity: annotationSeverityEnum("severity").notNull().default("info"),
    visibility: annotationVisibilityEnum("visibility").notNull().default("org_wide"),
    geometry: jsonb("geometry").notNull(),
    irwinIncidentId: text("irwin_incident_id"),
    isDeleted: boolean("is_deleted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("annotations_company_idx").on(t.companyId, t.isDeleted, t.createdAt),
    authorIdx: index("annotations_author_idx").on(t.authorId, t.companyId),
  }),
);
