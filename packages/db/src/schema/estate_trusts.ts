import { pgEnum, pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estates } from "./estates.js";

export const trustTypeEnum = pgEnum("trust_type", [
  "revocable",
  "irrevocable",
  "testamentary",
  "special_needs",
]);

export const trustFundingStatusEnum = pgEnum("trust_funding_status", [
  "unfunded",
  "partially_funded",
  "fully_funded",
]);

export const estateTrusts = pgTable(
  "estate_trusts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    estateId: uuid("estate_id").notNull().references(() => estates.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    trustName: text("trust_name").notNull(),
    trustType: trustTypeEnum("trust_type").notNull(),
    trusteeUserId: text("trustee_user_id"),
    successorTrusteeName: text("successor_trustee_name"),
    fundingStatus: trustFundingStatusEnum("funding_status").notNull().default("unfunded"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    estateIdx: index("estate_trusts_estate_idx").on(table.estateId),
  }),
);
