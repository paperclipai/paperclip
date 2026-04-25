export type TruthDocumentIngestStatus = "pending" | "running" | "succeeded" | "failed";
export type TruthDocumentEmbeddingStatus = "not_required" | "pending" | "running" | "succeeded" | "failed";
export type TruthDocumentExclusionStatus = "included" | "excluded" | "pending_review";
export type TruthRunStatus = "pending" | "running" | "needs_review" | "accepted" | "failed" | "superseded";
export type TruthAtomLedgerSection = "truth" | "context" | "noise" | "open_question" | "risk";
export type TruthAtomStatus = "needs_review" | "accepted" | "rejected" | "superseded";
export type TruthRunAuditType = "hallucination" | "omission" | "coverage" | "integrity";
export type TruthRunAuditStatus = "pending" | "running" | "succeeded" | "failed";
export type TruthBriefStatus = "draft" | "needs_review" | "accepted" | "rejected" | "superseded";
export type TruthDossierStatus = "draft" | "ready" | "published" | "superseded" | "failed";
export type TruthPromotionRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "completed"
  | "failed"
  | "expired";

export interface TruthBriefCanonicalInput {
  atomIds: string[];
  auditIds: string[];
  promptInputs: Record<string, unknown>;
  templateVariables: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TruthDocument {
  id: string;
  companyId: string;
  companySlug: string;
  title: string | null;
  sourceType: string;
  sourceUri: string | null;
  sourceSha256: string | null;
  ingestStatus: TruthDocumentIngestStatus;
  embeddingStatus: TruthDocumentEmbeddingStatus;
  exclusionStatus: TruthDocumentExclusionStatus;
  mappingConfidence: string | null;
  mappingReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TruthDocumentChunk {
  id: string;
  companyId: string;
  truthDocumentId: string;
  sourceChunkKey: string;
  deterministicKey: string;
  chunkIndex: number;
  chunkKind: string;
  contentText: string;
  contentSha256: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TruthRun {
  id: string;
  companyId: string;
  companySlug: string;
  truthDocumentId: string;
  status: TruthRunStatus;
  title: string | null;
  extractionVersion: string;
  promptVersion: string;
  model: string | null;
  sourceCounts: Record<string, unknown>;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TruthAtom {
  id: string;
  companyId: string;
  truthRunId: string;
  truthDocumentId: string;
  truthDocumentChunkId: string | null;
  rawAtomId: string | null;
  atomIndex: number;
  ledgerSection: TruthAtomLedgerSection;
  atomType: string;
  atomText: string;
  durabilityScore: number;
  confidenceScore: string;
  evidenceMode: string;
  speakerName: string | null;
  speakerId: string | null;
  startTime: string | null;
  endTime: string | null;
  sourceUtteranceIds: string[];
  evidenceQuote: string;
  planningRelevance: string | null;
  status: TruthAtomStatus;
  auditFlags: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TruthRunAudit {
  id: string;
  companyId: string;
  truthRunId: string;
  auditType: TruthRunAuditType;
  status: TruthRunAuditStatus;
  auditorModel: string | null;
  promptVersion: string;
  templateVersion: string | null;
  findingCount: number;
  summary: string | null;
  findings: Array<Record<string, unknown>>;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TruthBrief {
  id: string;
  companyId: string;
  truthRunId: string;
  title: string;
  status: TruthBriefStatus;
  briefKind: string;
  contentMarkdown: string | null;
  contentJson: Record<string, unknown> | null;
  canonicalInput: TruthBriefCanonicalInput;
  promptVersion: string;
  templateVersion: string;
  model: string | null;
  inputHash: string;
  payloadHash: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TruthDossier {
  id: string;
  companyId: string;
  truthRunId: string;
  briefId: string;
  title: string;
  status: TruthDossierStatus;
  htmlContent: string | null;
  filePath: string | null;
  contentSha256: string | null;
  briefInputHash: string;
  briefPayloadHash: string;
  promptVersion: string;
  templateVersion: string;
  generatedAt: Date;
  generatedByAgentId: string | null;
  generatedByUserId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TruthPromotionRequest {
  id: string;
  companyId: string;
  companySlug: string;
  truthRunId: string | null;
  briefId: string | null;
  dossierId: string | null;
  requestedBy: string;
  requestReason: string | null;
  status: TruthPromotionRequestStatus;
  expiresAt: Date | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
