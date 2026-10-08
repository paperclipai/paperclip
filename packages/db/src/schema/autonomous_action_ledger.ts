import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Durable admission and consume-once ledger for autonomous effects. */
export const autonomousActionLedger = pgTable(
  "autonomous_action_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    executionId: text("execution_id").notNull(),
    taskId: text("task_id").notNull(),
    parentExecutionId: text("parent_execution_id"),
    workerId: text("worker_id"),
    attempt: integer("attempt").notNull(),
    kind: text("kind").notNull(),
    effectType: text("effect_type").notNull(),
    effectPayload: jsonb("effect_payload").$type<Record<string, string | number | boolean | null>>().notNull(),
    actionId: text("action_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    effectKey: text("effect_key").notNull(),
    effectFingerprint: text("effect_fingerprint").notNull(),
    status: text("status").notNull().default("accepted"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyActionIdUq: uniqueIndex("autonomous_action_ledger_company_action_id_uq").on(
      table.companyId,
      table.actionId,
    ),
    companyIdempotencyKeyUq: uniqueIndex("autonomous_action_ledger_company_idempotency_key_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    companyEffectKeyUq: uniqueIndex("autonomous_action_ledger_company_effect_key_uq").on(
      table.companyId,
      table.effectKey,
    ),
    companyStatusCreatedIdx: index("autonomous_action_ledger_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    executionIdx: index("autonomous_action_ledger_execution_idx").on(
      table.companyId,
      table.executionId,
    ),
    attemptCheck: check("autonomous_action_ledger_attempt_check", sql`${table.attempt} >= 1`),
    statusCheck: check(
      "autonomous_action_ledger_status_check",
      sql`${table.status} IN ('accepted', 'claimed', 'dispatched', 'consumed')`,
    ),
  }),
);
