import type {
  AutonomyActorType,
  AutonomyEvidenceEntry,
  AutonomyEvidenceVerdict,
  AutonomyEvidenceType,
  AutonomyIncident,
  AutonomyIncidentSeverity,
  AutonomyIncidentStatus,
  AutonomyIncidentType,
  AutonomyJsonValue,
  AutonomyRunKernelState,
  AutonomyRunTransition,
  AutonomySourceType,
  AutonomyTerminalClassification,
  CompanyLaneStatus,
  AutonomyInboxItem,
} from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import type { EvidenceValidationResult, ValidatorEvidenceCandidate } from "./validators.js";

export type AutonomyKernelLogger = Pick<Console, "debug" | "info" | "warn" | "error">;

export interface AutonomyKernelOptions {
  logger?: AutonomyKernelLogger;
  preflightChecks?: Partial<Record<PreflightExternalGateKind, PreflightExternalGate>>;
  enforceAgentContracts?: boolean;
}

export interface AutonomyKernelContext {
  db: Db;
  logger: AutonomyKernelLogger;
  preflightChecks: Partial<Record<PreflightExternalGateKind, PreflightExternalGate>>;
  enforceAgentContracts: boolean;
}

export interface AutonomyRunRef {
  companyId: string;
  runId?: string | null;
  issueId?: string | null;
  agentId?: string | null;
  laneKey?: string | null;
}

export interface PreflightRunRequest extends AutonomyRunRef {
  runId: string;
  requestedByActorType?: AutonomyActorType;
  requestedByActorId?: string | null;
  governedAction?: string | null;
  requiresWorkspace?: boolean;
  metadata?: Record<string, AutonomyJsonValue> | null;
}

export interface AuthorizeRunRequest extends AutonomyRunRef {
  runId: string;
  authorizedByActorType?: AutonomyActorType;
  authorizedByActorId?: string | null;
  metadata?: Record<string, AutonomyJsonValue> | null;
}

export type KernelDecisionStatus = "allow" | "deny" | "approval_required" | "blocked";

export interface KernelDecision {
  status: KernelDecisionStatus;
  reason: string | null;
  incidentIds: string[];
  approvalGateIds: string[];
}

export type PreflightExternalGateKind = "auth" | "budget" | "workspace";

export interface PreflightExternalGateInput extends PreflightRunRequest {
  gate: PreflightExternalGateKind;
}

export interface PreflightExternalGateResult {
  status: KernelDecisionStatus;
  reason?: string | null;
  incidentType?: AutonomyIncidentType;
  severity?: AutonomyIncidentSeverity;
  remediation?: string | null;
}

export type PreflightExternalGate = (input: PreflightExternalGateInput) => Promise<PreflightExternalGateResult> | PreflightExternalGateResult;

export interface RecordTransitionInput extends AutonomyRunRef {
  runId: string;
  fromState: AutonomyRunKernelState | null;
  toState: AutonomyRunKernelState;
  terminalClassification?: AutonomyTerminalClassification | null;
  reason?: string | null;
  actorType?: AutonomyActorType;
  actorId?: string | null;
  evidenceEntryIds?: string[];
  incidentIds?: string[];
  metadata?: Record<string, AutonomyJsonValue> | null;
  transitionedAt?: Date;
  controllerOverride?: boolean;
}

export interface RecordEvidenceInput extends AutonomyRunRef {
  type: AutonomyEvidenceType;
  title: string;
  summary?: string | null;
  uri?: string | null;
  payload?: Record<string, AutonomyJsonValue> | null;
  sourceType?: AutonomySourceType;
  sourceId?: string | null;
}

export interface ValidateEvidenceInput {
  companyId: string;
  evidenceEntryId: string;
  verdict?: AutonomyEvidenceVerdict;
  validatorName?: string | null;
  validatorVersion?: string | null;
  validatorMessage?: string | null;
  validatorPayload?: Record<string, AutonomyJsonValue> | null;
}

export interface CreateIncidentInput extends AutonomyRunRef {
  type: AutonomyIncidentType;
  severity: AutonomyIncidentSeverity;
  status?: AutonomyIncidentStatus;
  title: string;
  message: string;
  remediation?: string | null;
  stopsLane?: boolean;
  sourceType?: AutonomySourceType;
  sourceId?: string | null;
  idempotent?: boolean;
  idempotencyKey?: string | null;
  metadata?: Record<string, AutonomyJsonValue> | null;
}

export interface ResolveIncidentInput {
  companyId: string;
  incidentId: string;
  resolvedByUserId?: string | null;
  resolutionNote?: string | null;
}

export interface EvaluateContinuationInput extends AutonomyRunRef {
  terminalClassification?: AutonomyTerminalClassification | null;
  evidenceEntryIds?: string[];
  incidentIds?: string[];
}

export interface AutonomyKernelService {
  preflightRun(request: PreflightRunRequest): Promise<KernelDecision>;
  authorizeRun(request: AuthorizeRunRequest): Promise<KernelDecision>;
  recordTransition(input: RecordTransitionInput): Promise<AutonomyRunTransition>;
  recordEvidence(input: RecordEvidenceInput): Promise<AutonomyEvidenceEntry>;
  validateEvidence(input: ValidateEvidenceInput): Promise<AutonomyEvidenceEntry>;
  validateEvidenceCandidate(candidate: ValidatorEvidenceCandidate): Promise<EvidenceValidationResult>;
  createIncident(input: CreateIncidentInput): Promise<AutonomyIncident>;
  resolveIncident(input: ResolveIncidentInput): Promise<AutonomyIncident>;
  evaluateContinuation(input: EvaluateContinuationInput): Promise<KernelDecision>;
  getCompanyLaneStatus(companyId: string): Promise<CompanyLaneStatus[]>;
  getAutonomyInbox(companyId: string): Promise<AutonomyInboxItem[]>;
}
