import { type AnyPgColumn, pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    sourceProjectSlug: text("source_project_slug").notNull(),
    sourceKey: text("source_key").notNull(),
    sourceHash: text("source_hash").notNull(),
    title: text("title").notNull(),
    context: text("context"),
    decision: text("decision").notNull(),
    consequences: text("consequences"),
    status: text("status").notNull().default("accepted"),
    supersededBy: uuid("superseded_by").references((): AnyPgColumn => decisions.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceKeyUq: uniqueIndex("decisions_company_source_key_uq").on(table.companyId, table.sourceKey),
    sourceProjectSlugIdx: index("decisions_source_project_slug_idx").on(
      table.companyId,
      table.sourceProjectSlug,
    ),
    statusIdx: index("decisions_status_idx").on(table.status),
  }),
);
