import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

export const securityAuditLog = pgTable(
  "security_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: integer("seq").notNull(),
    eventType: text("event_type").notNull().default("ISSUE_FORCE_REASSIGN"),
    tenantId: text("tenant_id").notNull(),
    issueId: uuid("issue_id").references(() => issues.id),
    actorAgentId: uuid("actor_agent_id"),
    actorUserId: text("actor_user_id"),
    actorRole: text("actor_role"),
    actorScopes: jsonb("actor_scopes").$type<string[]>(),
    fromAssigneeId: uuid("from_assignee_id").references(() => agents.id),
    fromAssigneeStatus: text("from_assignee_status"),
    fromChainSnapshot: jsonb("from_chain_snapshot"),
    toAssigneeId: uuid("to_assignee_id").references(() => agents.id),
    toAssigneeStatus: text("to_assignee_status"),
    orphanEvidence: jsonb("orphan_evidence"),
    reason: text("reason").notNull(),
    leaseAction: text("lease_action"),
    issueVersionBefore: integer("issue_version_before"),
    issueVersionAfter: integer("issue_version_after"),
    idempotencyKey: text("idempotency_key"),
    requestId: text("request_id"),
    dualControlConfirmerId: uuid("dual_control_confirmer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
  },
  (table) => ({
    tenantSeqUq: uniqueIndex("security_audit_log_tenant_seq_uq").on(table.tenantId, table.seq),
    tenantCreatedIdx: index("security_audit_log_tenant_created_idx").on(table.tenantId, table.createdAt),
    issueIdx: index("security_audit_log_issue_idx").on(table.issueId),
  }),
);