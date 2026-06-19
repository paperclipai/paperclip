import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  timestamp,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Mirrors prompt_versions in
// services/oracle-dispatcher/migrations/0001_learning.sql (authoritative).
// The canonical, versioned agent prompt bodies.
// status lifecycle: candidate -> active -> retired (and -> rolled_back).
export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agent: text("agent").notNull(),
    taskClass: text("task_class").notNull(),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull(),
    parentVersion: bigint("parent_version", { mode: "number" }).references(
      (): AnyPgColumn => promptVersions.id,
    ),
    createdBy: text("created_by"),
    geminiVerdict: text("gemini_verdict"),
    humanApprover: text("human_approver"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: check(
      "prompt_versions_status_check",
      sql`${table.status} IN ('active', 'candidate', 'retired', 'rolled_back')`,
    ),
    // At most ONE active and ONE candidate per (agent, task_class); retired /
    // rolled_back rows accumulate freely (partial unique indexes).
    oneActiveIdx: uniqueIndex("uq_prompt_versions_one_active")
      .on(table.agent, table.taskClass)
      .where(sql`${table.status} = 'active'`),
    oneCandidateIdx: uniqueIndex("uq_prompt_versions_one_candidate")
      .on(table.agent, table.taskClass)
      .where(sql`${table.status} = 'candidate'`),
    classVersionIdx: uniqueIndex("uq_prompt_versions_class_version").on(
      table.agent,
      table.taskClass,
      table.version,
    ),
  }),
);
