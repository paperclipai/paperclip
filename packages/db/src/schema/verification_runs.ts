import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";
import { assets } from "./assets.js";

export type VerificationRunStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "unavailable"
  | "overridden";

export type VerificationRunContext = "anonymous" | "authenticated";

export const verificationRuns = pgTable(
  "verification_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    deliverableType: text("deliverable_type").notNull(),
    specPath: text("spec_path").notNull(),
    context: text("context").$type<VerificationRunContext | null>(),
    targetSha: text("target_sha"),
    deployedSha: text("deployed_sha"),
    status: text("status").notNull().$type<VerificationRunStatus>(),
    traceAssetId: uuid("trace_asset_id").references(() => assets.id),
    failureSummary: text("failure_summary"),
    unavailableReason: text("unavailable_reason"),
    attemptNumber: integer("attempt_number").notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (table) => ({
    issueIdx: index("verification_runs_issue_idx").on(table.issueId, table.startedAt),
  }),
);

export type VerificationRun = typeof verificationRuns.$inferSelect;
export type NewVerificationRun = typeof verificationRuns.$inferInsert;
