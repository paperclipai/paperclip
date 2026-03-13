import { pgTable, uuid, text, timestamp, jsonb, index, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // --- AllCare: HIPAA Audit Extensions ---
    phiAccessed: boolean("phi_accessed").notNull().default(false),
    patientId: text("patient_id"),
    accessJustification: text("access_justification"),
    delegationChain: jsonb("delegation_chain").$type<string[]>(),
    retentionPolicy: text("retention_policy").notNull().default("hipaa_6yr"),
    dpopJkt: text("dpop_jkt"),
  },
  (table) => ({
    companyCreatedIdx: index("activity_log_company_created_idx").on(table.companyId, table.createdAt),
    runIdIdx: index("activity_log_run_id_idx").on(table.runId),
    entityIdx: index("activity_log_entity_type_id_idx").on(table.entityType, table.entityId),
    phiAccessedIdx: index("activity_log_phi_accessed_idx").on(table.phiAccessed, table.createdAt),
    patientIdIdx: index("activity_log_patient_id_idx").on(table.patientId),
  }),
);
