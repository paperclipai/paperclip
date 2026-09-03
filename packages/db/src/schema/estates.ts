import { pgEnum, pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const estateTypeEnum = pgEnum("estate_type", [
  "individual",
  "joint",
  "trust",
  "estate",
]);

export const maritalStatusEnum = pgEnum("marital_status", [
  "single",
  "married",
  "divorced",
  "widowed",
  "domestic_partnership",
]);

export const estates = pgTable(
  "estates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    estateType: estateTypeEnum("estate_type").notNull().default("individual"),
    maritalStatus: maritalStatusEnum("marital_status"),
    stateOfResidence: text("state_of_residence"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOwnerIdx: index("estates_company_owner_idx").on(table.companyId, table.ownerUserId),
  }),
);
