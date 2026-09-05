import { pgTable, uuid, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const supplements = pgTable(
  "supplements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    dose: text("dose").notNull(),
    unit: text("unit").notNull().default("mg"),
    scheduledTime: text("scheduled_time").notNull().default("08:00"),
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("supplements_company_user_idx").on(table.companyId, table.userId),
  }),
);

export const supplementIntakes = pgTable(
  "supplement_intakes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplementId: uuid("supplement_id")
      .notNull()
      .references(() => supplements.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: text("user_id").notNull(),
    intakeDate: text("intake_date").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    supplementDateIdx: index("supplement_intakes_supplement_date_idx").on(
      table.supplementId,
      table.intakeDate,
    ),
    companyUserDateIdx: index("supplement_intakes_company_user_date_idx").on(
      table.companyId,
      table.userId,
      table.intakeDate,
    ),
  }),
);
