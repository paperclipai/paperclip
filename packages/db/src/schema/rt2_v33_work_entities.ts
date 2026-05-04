import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from './companies.js';
import { issues } from './issues.js';
import { issueWorkProducts } from './issue_work_products.js';

// rt2_v33_work_entities: new RT2 work entity with correlations to Task/Deliverable
export const rt2V33WorkEntities = pgTable("rt2_v33_work_entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  taskIssueId: uuid("task_issue_id"),
  deliverableWorkProductId: uuid("deliverable_work_product_id"),
  state: text("state").notNull().default("draft"),
  archivedAt: timestamp("archived_at"),
  legacySourceId: uuid("legacy_source_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // Ensure idempotent upserts when both references exist
  companyTaskDeliveryUq: uniqueIndex("rt2_v33_work_entities_company_task_delivery_uq")
    .on(table.companyId, table.taskIssueId, table.deliverableWorkProductId)
    .where(sql`${table.taskIssueId} is not null and ${table.deliverableWorkProductId} is not null`),
  // Work entity state machine: draft -> active -> completed/cancelled
  stateCheck: check(
    "rt2_v33_work_entities_state_check",
    sql`${table.state} in ('draft', 'active', 'completed', 'cancelled')`,
  ),
}));

// Archival mirror kept for migrations; original rows archived with migration batch info
export const rt2V33WorkEntitiesArchive = pgTable("rt2_v33_work_entities_archive", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  taskIssueId: uuid("task_issue_id"),
  deliverableWorkProductId: uuid("deliverable_work_product_id"),
  state: text("state").notNull(),
  archivedAt: timestamp("archived_at"),
  legacySourceId: uuid("legacy_source_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  migrationBatchId: text("migration_batch_id").notNull(),
  migratedAt: timestamp("migrated_at").notNull(),
});
