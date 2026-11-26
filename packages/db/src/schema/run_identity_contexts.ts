import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Immutable attribution records. Only acceptance state and redacted diagnostics advance. */
export const runIdentityContexts = pgTable(
  "run_identity_contexts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Retain attribution after an agent and its runs are deleted: surviving tasks
    // and approvals still reference these contexts. The original run UUID is archival.
    runId: uuid("run_id").notNull(),
    revision: integer("revision").notNull(),
    responsibleUserId: text("responsible_user_id"),
    messageId: uuid("message_id"),
    parentContextId: uuid("parent_context_id"),
    cause: text("cause").notNull(),
    correlationId: text("correlation_id").notNull(),
    status: text("status").notNull().default("accepted"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    github: jsonb("github").$type<{
      status: "available" | "absent" | "unavailable";
      login?: string;
      source?: "personal" | "dedicated";
      reason?: string;
      connectionId?: string;
      grantId?: string;
      authenticationMode?: "managed" | "host" | "anonymous";
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    revisionIdx: uniqueIndex("run_identity_contexts_run_revision_idx").on(
      t.runId,
      t.revision,
    ),
    correlationIdx: uniqueIndex("run_identity_contexts_run_correlation_idx").on(
      t.runId,
      t.correlationId,
    ),
    companyRunIdx: index("run_identity_contexts_company_run_idx").on(
      t.companyId,
      t.runId,
    ),
  }),
);
