import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// Provider-generated evidence that a resolved workspace target received the
// declared delivery for a specific run. Append-only: a retry or later
// delivery attempt produces a new row rather than rewriting failed evidence.
// See doc/execution-semantics.md, "Authoritative workspace intent and
// completion attestation" -> "Durable target and attestation schema".
export const deliveryAttestations = pgTable(
  "delivery_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    declarationId: text("declaration_id").notNull(),
    declarationRevision: integer("declaration_revision").notNull(),
    targetKind: text("target_kind").notNull(),
    targetFingerprint: text("target_fingerprint").notNull(),
    providerKey: text("provider_key").notNull(),
    outcome: text("outcome").notNull(),
    deliveryMethod: text("delivery_method").notNull(),
    sourceRevision: text("source_revision"),
    deliveredRevision: text("delivered_revision"),
    destinationRefFingerprint: text("destination_ref_fingerprint"),
    workspaceDirty: boolean("workspace_dirty"),
    // Normalized to "" when the provider has no natural operation id, so the
    // dedup constraint below still applies to single-shot delivery methods.
    operationId: text("operation_id").notNull().default(""),
    artifactIds: jsonb("artifact_ids").$type<string[]>().notNull().default([]),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    providerSignature: text("provider_signature").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dedupIdx: uniqueIndex("delivery_attestations_dedup_idx").on(
      table.runId,
      table.declarationId,
      table.declarationRevision,
      table.deliveryMethod,
      table.operationId,
    ),
    companyIssueIdx: index("delivery_attestations_company_issue_idx").on(
      table.companyId,
      table.issueId,
      table.generatedAt,
    ),
    runIdx: index("delivery_attestations_run_idx").on(table.runId, table.generatedAt),
  }),
);
