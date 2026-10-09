import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  unique,
  foreignKey,
  jsonb,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** Append-only content. Base64 preserves every UTF-8 byte, including NUL and BOM. */
export const agentInstructionRevisions = pgTable(
  "agent_instruction_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    entryFile: text("entry_file").notNull(),
    contentBase64: text("content_base64").notNull(),
    contentHash: text("content_hash").notNull(),
    byteLength: integer("byte_length").notNull(),
    parentRevisionId: uuid("parent_revision_id"),
    baseRevisionId: uuid("base_revision_id"),
    restoredFromRevisionId: uuid("restored_from_revision_id"),
    actorAgentId: uuid("actor_agent_id"),
    actorUserId: text("actor_user_id"),
    responsibleUserId: text("responsible_user_id"),
    sourceRunId: uuid("source_run_id"),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    owner: foreignKey({
      columns: [t.companyId, t.agentId],
      foreignColumns: [agents.companyId, agents.id],
    }).onDelete("cascade"),
    identity: unique("agent_instruction_revisions_identity_uq").on(
      t.companyId,
      t.agentId,
      t.entryFile,
      t.id,
    ),
    history: index("agent_instruction_revisions_history_idx").on(
      t.companyId,
      t.agentId,
      t.entryFile,
      t.createdAt,
      t.id,
    ),
  }),
);

export const agentInstructionHeads = pgTable(
  "agent_instruction_heads",
  {
    companyId: uuid("company_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    entryFile: text("entry_file").notNull(),
    revisionId: uuid("revision_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    identity: unique("agent_instruction_heads_identity_uq").on(
      t.companyId,
      t.agentId,
      t.entryFile,
    ),
    revision: foreignKey({
      columns: [t.companyId, t.agentId, t.entryFile, t.revisionId],
      foreignColumns: [
        agentInstructionRevisions.companyId,
        agentInstructionRevisions.agentId,
        agentInstructionRevisions.entryFile,
        agentInstructionRevisions.id,
      ],
    }).onDelete("cascade"),
  }),
);

/** A server-owned collection receipt, retained even when canonical CAS rejects an edit. */
export const agentInstructionWorkingCopies = pgTable(
  "agent_instruction_working_copies",
  {
    runId: uuid("run_id").primaryKey().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    responsibleUserId: text("responsible_user_id").notNull(),
    entryFile: text("entry_file").notNull(),
    baseRevisionId: uuid("base_revision_id"),
    baseHash: text("base_hash").notNull(),
    localRoot: text("local_root").notNull(),
    executionRoot: text("execution_root").notNull(),
    location: text("location").notNull(),
    state: text("state").notNull().default("prepared"),
    candidateBase64: text("candidate_base64"),
    candidateHash: text("candidate_hash"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    receipt: jsonb("receipt").$type<Record<string, unknown>>(),
    processStoppedAt: timestamp("process_stopped_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    owner: foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [agents.companyId, agents.id] }).onDelete("cascade"),
    pending: index("agent_instruction_copies_pending_idx").on(t.state, t.nextAttemptAt),
    history: index("agent_instruction_copies_agent_idx").on(t.companyId, t.agentId, t.createdAt),
  }),
);
