export const DELIVERY_STAGES = [
  "implementation",
  "ci",
  "deployment",
  "smoke",
  "functional_qa",
  "technical_acceptance",
  "business_acceptance",
] as const;

export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

export const DELIVERY_EVENT_STATES = [
  "unknown",
  "pending",
  "succeeded",
  "failed",
  "rolled_back",
  "accepted",
  "rejected",
  "skipped",
] as const;

export type DeliveryEventState = (typeof DELIVERY_EVENT_STATES)[number];

export const DELIVERY_EVENT_SOURCE_KINDS = [
  "provider_observation",
  "paperclip_action",
  "user_submission",
  "agent_submission",
  "legacy_backfill",
] as const;

export type DeliveryEventSourceKind = (typeof DELIVERY_EVENT_SOURCE_KINDS)[number];

export const DELIVERY_EVENT_AUTHORITIES = [
  "provider_verified",
  "paperclip_verified",
  "user_asserted",
  "agent_claim",
  "legacy_unverified",
] as const;

export type DeliveryEventAuthority = (typeof DELIVERY_EVENT_AUTHORITIES)[number];

export interface DeliveryFactoryParticipantV1 {
  type: "agent" | "user";
  agentId: string | null;
  userId: string | null;
}

/**
 * Server-stamped workflow identity for evidence produced inside a typed AI
 * Factory execution lane. Clients cannot supply or rewrite this object.
 */
export interface DeliveryFactoryProvenanceV1 {
  version: 1;
  stageId: string;
  stageKey: string | null;
  stageRevision: number;
  stageActivatedAt: string | null;
  participant: DeliveryFactoryParticipantV1;
}

/**
 * A factual observation in the delivery ledger. Events are append-only. A
 * correction points at an older event through `supersedesEventId`; it never
 * rewrites or deletes the historical observation.
 */
export interface DeliveryEventV1 {
  version: 1;
  id: string;
  companyId: string;
  issueId: string;
  stage: DeliveryStage;
  state: DeliveryEventState;
  candidateSha: string | null;
  environment: string | null;
  provider: string | null;
  providerExternalId: string | null;
  providerUrl: string | null;
  sourceKind: DeliveryEventSourceKind;
  authority: DeliveryEventAuthority;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  sourceFingerprint: string | null;
  sourceWorkProductId: string | null;
  supersedesEventId: string | null;
  observedAt: Date;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  createdAt: Date;
}

export interface DeliveryStageSnapshotV1 {
  stage: DeliveryStage;
  state: DeliveryEventState;
  eventId: string | null;
  authority: DeliveryEventAuthority | null;
  candidateSha: string | null;
  environment: string | null;
  provider: string | null;
  providerExternalId: string | null;
  providerUrl: string | null;
  observedAt: Date | null;
  stale: boolean;
  paperclipFactory: DeliveryFactoryProvenanceV1 | null;
}

/** Deterministic projection of all active ledger events for one issue. */
export interface DeliverySnapshotV1 {
  version: 1;
  companyId: string;
  issueId: string;
  revision: string;
  watermark: {
    eventId: string | null;
    createdAt: Date | null;
    eventCount: number;
  };
  candidateSha: string | null;
  environment: string | null;
  stages: Record<DeliveryStage, DeliveryStageSnapshotV1>;
  activeEventIds: string[];
  supersededEventIds: string[];
}

/** Optional lineage assertions applied when a workflow evaluates one gate. */
export interface DeliveryEvidenceExpectationsV1 {
  candidateSha?: string | null;
  stageId?: string | null;
  stageRevision?: number | null;
  participant?: DeliveryFactoryParticipantV1 | null;
}

export const EXTERNAL_OPERATION_KINDS = [
  "github_actions_workflow_run",
  "cloudflare_pages_deployment",
  "custom",
] as const;

export type ExternalOperationKind = (typeof EXTERNAL_OPERATION_KINDS)[number];

export const EXTERNAL_OPERATION_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "unknown",
] as const;

export type ExternalOperationState = (typeof EXTERNAL_OPERATION_STATES)[number];

export const EXTERNAL_OPERATION_VERIFICATION_STATUSES = [
  "unverified",
  "verified",
  "mismatch",
  "error",
] as const;

export type ExternalOperationVerificationStatus =
  (typeof EXTERNAL_OPERATION_VERIFICATION_STATUSES)[number];

export interface ExternalOperationV1 {
  version: 1;
  id: string;
  companyId: string;
  issueId: string;
  kind: ExternalOperationKind;
  provider: string;
  stage: DeliveryStage;
  externalId: string;
  /** Prior canonical operation replaced by this append-only retry, if any. */
  supersedesOperationId: string | null;
  candidateSha: string | null;
  environment: string | null;
  url: string | null;
  state: ExternalOperationState;
  verificationStatus: ExternalOperationVerificationStatus;
  credentialSecretId: string | null;
  nextCheckAt: Date | null;
  timeoutAt: Date | null;
  terminalAt: Date | null;
  lastVerifiedAt: Date | null;
  lastVerificationError: string | null;
  metadata: Record<string, unknown> | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
