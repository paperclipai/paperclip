import { index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const truthDocuments = pgTable(
  "truth_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    companySlug: text("company_slug").notNull(),
    title: text("title"),
    sourceType: text("source_type").notNull(),
    sourceUri: text("source_uri"),
    sourceSha256: text("source_sha256"),
    ingestStatus: text("ingest_status").notNull().default("pending"),
    embeddingStatus: text("embedding_status").notNull().default("not_required"),
    exclusionStatus: text("exclusion_status").notNull().default("included"),
    mappingConfidence: numeric("mapping_confidence"),
    mappingReason: text("mapping_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceShaUq: uniqueIndex("truth_documents_company_source_sha_uq").on(
      table.companyId,
      table.sourceSha256,
    ),
    companyIngestStatusIdx: index("truth_documents_company_ingest_status_idx").on(
      table.companyId,
      table.ingestStatus,
    ),
    companyEmbeddingStatusIdx: index("truth_documents_company_embedding_status_idx").on(
      table.companyId,
      table.embeddingStatus,
    ),
    slugMappingConfidenceIdx: index("truth_documents_slug_mapping_confidence_idx").on(
      table.companySlug,
      table.mappingConfidence,
    ),
  }),
);

export const truthDocumentChunks = pgTable(
  "truth_document_chunks",
  {
    id: uuid("id").primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    truthDocumentId: uuid("truth_document_id").notNull().references(() => truthDocuments.id),
    sourceChunkKey: text("source_chunk_key").notNull(),
    deterministicKey: text("deterministic_key").notNull(),
    chunkIndex: integer("chunk_index").notNull().default(0),
    chunkKind: text("chunk_kind").notNull().default("text"),
    contentText: text("content_text").notNull().default(""),
    contentSha256: text("content_sha256"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceKeyUq: uniqueIndex("truth_document_chunks_company_source_key_uq").on(
      table.companyId,
      table.sourceChunkKey,
    ),
    companyDeterministicKeyUq: uniqueIndex("truth_document_chunks_company_deterministic_key_uq").on(
      table.companyId,
      table.deterministicKey,
    ),
    companyDocumentIdx: index("truth_document_chunks_company_document_idx").on(
      table.companyId,
      table.truthDocumentId,
    ),
  }),
);

export const truthRuns = pgTable(
  "truth_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    companySlug: text("company_slug").notNull(),
    truthDocumentId: uuid("truth_document_id").notNull().references(() => truthDocuments.id),
    status: text("status").notNull().default("pending"),
    title: text("title"),
    extractionVersion: text("extraction_version").notNull().default("truth_atom_extractor_v1"),
    promptVersion: text("prompt_version").notNull(),
    model: text("model"),
    sourceCounts: jsonb("source_counts").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDocumentIdx: index("truth_runs_company_document_idx").on(table.companyId, table.truthDocumentId),
  }),
);

export const truthAtoms = pgTable(
  "truth_atoms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    truthRunId: uuid("truth_run_id").notNull().references(() => truthRuns.id),
    truthDocumentId: uuid("truth_document_id").notNull().references(() => truthDocuments.id),
    truthDocumentChunkId: uuid("truth_document_chunk_id").references(() => truthDocumentChunks.id),
    rawAtomId: text("raw_atom_id"),
    atomIndex: integer("atom_index").notNull(),
    ledgerSection: text("ledger_section").notNull(),
    atomType: text("atom_type").notNull(),
    atomText: text("atom_text").notNull(),
    durabilityScore: integer("durability_score").notNull(),
    confidenceScore: numeric("confidence_score").notNull(),
    evidenceMode: text("evidence_mode").notNull(),
    speakerName: text("speaker_name"),
    speakerId: text("speaker_id"),
    startTime: text("start_time"),
    endTime: text("end_time"),
    sourceUtteranceIds: jsonb("source_utterance_ids").$type<string[]>().notNull().default([]),
    evidenceQuote: text("evidence_quote").notNull(),
    planningRelevance: text("planning_relevance"),
    status: text("status").notNull().default("needs_review"),
    auditFlags: jsonb("audit_flags").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDocumentIdx: index("truth_atoms_company_document_idx").on(table.companyId, table.truthDocumentId),
    companyRunIdx: index("truth_atoms_company_run_idx").on(table.companyId, table.truthRunId),
  }),
);

export const truthRunAudits = pgTable(
  "truth_run_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    truthRunId: uuid("truth_run_id").notNull().references(() => truthRuns.id),
    auditType: text("audit_type").notNull(),
    status: text("status").notNull().default("pending"),
    auditorModel: text("auditor_model"),
    promptVersion: text("prompt_version").notNull(),
    templateVersion: text("template_version"),
    findingCount: integer("finding_count").notNull().default(0),
    summary: text("summary"),
    findings: jsonb("findings").$type<Array<Record<string, unknown>>>().notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunIdx: index("truth_run_audits_company_run_idx").on(table.companyId, table.truthRunId),
  }),
);

export const truthBriefs = pgTable(
  "truth_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    truthRunId: uuid("truth_run_id").notNull().references(() => truthRuns.id),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    briefKind: text("brief_kind").notNull(),
    contentMarkdown: text("content_markdown"),
    contentJson: jsonb("content_json").$type<Record<string, unknown>>(),
    canonicalInput: jsonb("canonical_input").$type<Record<string, unknown>>().notNull(),
    promptVersion: text("prompt_version").notNull(),
    templateVersion: text("template_version").notNull(),
    model: text("model"),
    inputHash: text("input_hash").notNull(),
    payloadHash: text("payload_hash"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunIdx: index("truth_briefs_company_run_idx").on(table.companyId, table.truthRunId),
  }),
);

export const truthDossiers = pgTable(
  "truth_dossiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    truthRunId: uuid("truth_run_id").notNull().references(() => truthRuns.id),
    briefId: uuid("brief_id").notNull().references(() => truthBriefs.id),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    htmlContent: text("html_content"),
    filePath: text("file_path"),
    contentSha256: text("content_sha256"),
    briefInputHash: text("brief_input_hash").notNull(),
    briefPayloadHash: text("brief_payload_hash").notNull(),
    promptVersion: text("prompt_version").notNull(),
    templateVersion: text("template_version").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    generatedByAgentId: uuid("generated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    generatedByUserId: text("generated_by_user_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunIdx: index("truth_dossiers_company_run_idx").on(table.companyId, table.truthRunId),
  }),
);

export const truthPromotionRequests = pgTable(
  "truth_promotion_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    companySlug: text("company_slug").notNull(),
    truthRunId: uuid("truth_run_id").references(() => truthRuns.id),
    briefId: uuid("brief_id").references(() => truthBriefs.id),
    dossierId: uuid("dossier_id").references(() => truthDossiers.id),
    requestedBy: text("requested_by").notNull(),
    requestReason: text("request_reason"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("truth_promotion_requests_company_status_idx").on(table.companyId, table.status),
  }),
);
