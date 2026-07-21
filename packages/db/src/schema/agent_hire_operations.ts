import {
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

export type AgentHireOperationResponse = {
  agent: Record<string, unknown>;
  approval: Record<string, unknown> | null;
};

export type AgentHireOperationError = {
  code: string;
  message: string;
  statusCode: number;
};

export const agentHireOperations = pgTable(
  "agent_hire_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("pending"),
    stage: text("stage").notNull().default("queued"),
    agentId: uuid("agent_id").notNull(),
    response: jsonb("response").$type<AgentHireOperationResponse>(),
    error: jsonb("error").$type<AgentHireOperationError>(),
    stageTimings: jsonb("stage_timings").$type<Record<string, number>>().notNull().default({}),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopedKeyIdx: uniqueIndex("agent_hire_operations_scoped_key_uq").on(
      table.companyId,
      table.principalType,
      table.principalId,
      table.idempotencyKeyHash,
    ),
    companyOperationIdx: index("agent_hire_operations_company_operation_idx").on(
      table.companyId,
      table.id,
    ),
    pendingLeaseIdx: index("agent_hire_operations_pending_lease_idx").on(
      table.status,
      table.leaseExpiresAt,
    ),
  }),
);
