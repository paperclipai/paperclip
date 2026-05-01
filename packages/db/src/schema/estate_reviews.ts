import { pgEnum, pgTable, uuid, text, timestamp, integer, jsonb, index, unique } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const estateReviewStatusEnum = pgEnum("estate_review_status", [
  "pending",
  "in_progress",
  "complete",
]);

export interface ReviewChecklistItem {
  id: string;
  label: string;
  completed: boolean;
  completedAt?: string;
  notes?: string;
}

export const DEFAULT_REVIEW_CHECKLIST: ReviewChecklistItem[] = [
  { id: "update_valuations", label: "Update all asset valuations", completed: false },
  { id: "review_beneficiaries", label: "Review beneficiary designations", completed: false },
  { id: "review_insurance", label: "Review insurance coverage and premiums", completed: false },
  { id: "review_trust_docs", label: "Review trust documents and trustee appointments", completed: false },
  { id: "review_estate_plan", label: "Review estate plan with attorney", completed: false },
  { id: "review_tax_situation", label: "Review estate tax situation and gifting strategy", completed: false },
  { id: "review_digital_assets", label: "Update digital asset access and wallet records", completed: false },
  { id: "review_property_tax", label: "Confirm property tax bills and exemptions", completed: false },
];

export const estateReviews = pgTable(
  "estate_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    reviewYear: integer("review_year").notNull(),
    status: estateReviewStatusEnum("status").notNull().default("pending"),
    checklist: jsonb("checklist").$type<ReviewChecklistItem[]>().notNull().default([]),
    notes: text("notes"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("estate_reviews_company_user_idx").on(table.companyId, table.userId),
    yearIdx: index("estate_reviews_year_idx").on(table.companyId, table.reviewYear),
    uniqueYearPerUser: unique("estate_reviews_company_user_year_uniq").on(table.companyId, table.userId, table.reviewYear),
  }),
);
