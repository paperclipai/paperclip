import { pgTable, uuid, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { nativeRunResults } from "./native_run_results.js";

export const nativeRunFinalizations = pgTable("native_run_finalizations", {
  runId: uuid("run_id").primaryKey().references(() => heartbeatRuns.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  phase: text("phase").notNull(),
  attempt: integer("attempt").notNull().default(0),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  resultId: uuid("result_id").references(() => nativeRunResults.id),
  assessmentId: uuid("assessment_id"),
  decisionId: uuid("decision_id"),
  failureCode: text("failure_code"),
  failureDetail: jsonb("failure_detail").$type<Record<string, unknown>>(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
