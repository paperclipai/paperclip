import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { departments } from "./departments.js";

export const departmentMemberships = pgTable(
  "department_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    departmentId: uuid("department_id").notNull().references(() => departments.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deptPrincipalUq: uniqueIndex("dept_memberships_dept_principal_uq").on(
      table.departmentId,
      table.principalType,
      table.principalId,
    ),
    companyDeptIdx: index("dept_memberships_company_dept_idx").on(table.companyId, table.departmentId),
  }),
);
