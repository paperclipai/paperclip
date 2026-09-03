import { pgEnum, pgTable, uuid, text, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estates } from "./estates.js";

export const designationTypeEnum = pgEnum("designation_type", [
  "primary",
  "contingent",
  "per_stirpes",
]);

export const estateBeneficiaries = pgTable(
  "estate_beneficiaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    estateId: uuid("estate_id").notNull().references(() => estates.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    relationship: text("relationship"),
    email: text("email"),
    phone: text("phone"),
    allocationPercentage: numeric("allocation_percentage", { precision: 5, scale: 2 }),
    designationType: designationTypeEnum("designation_type").notNull().default("primary"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    estateIdx: index("estate_beneficiaries_estate_idx").on(table.estateId),
  }),
);
