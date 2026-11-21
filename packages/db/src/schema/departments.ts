import { sql } from "drizzle-orm";
import { foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

// A department is a label, not a manager. Reporting stays on `agents.reports_to`.
// An agent may belong to several departments, or to none. None is the absence of
// membership rows, not a stored "unassigned" department.
export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Stored already trimmed and collapsed. The unique index folds case with
    // Postgres `lower()`, so "Accounting" and "accounting" are one department.
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("departments_company_idx").on(table.companyId),
    companyIdUq: unique("departments_company_id_uq").on(table.companyId, table.id),
    companyNameKeyUq: uniqueIndex("departments_company_name_key_uq").on(
      table.companyId,
      sql`lower(${table.name})`,
    ),
  }),
);

export const agentDepartments = pgTable(
  "agent_departments",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    departmentId: uuid("department_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.departmentId], name: "agent_departments_pk" }),
    companyIdx: index("agent_departments_company_idx").on(table.companyId),
    agentIdx: index("agent_departments_agent_idx").on(table.agentId),
    departmentIdx: index("agent_departments_department_idx").on(table.departmentId),
    // Both parents carry the company. These composite keys reject a membership
    // that pairs an agent from one company with a department from another.
    agentCompanyFk: foreignKey({
      name: "agent_departments_agent_company_fk",
      columns: [table.companyId, table.agentId],
      foreignColumns: [agents.companyId, agents.id],
    }).onDelete("cascade"),
    departmentCompanyFk: foreignKey({
      name: "agent_departments_department_company_fk",
      columns: [table.companyId, table.departmentId],
      foreignColumns: [departments.companyId, departments.id],
    }).onDelete("cascade"),
  }),
);
