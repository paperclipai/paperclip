import type {
  BackgroundJobBackendKind,
  BackgroundJobEventLevel,
  BackgroundJobEventType,
  BackgroundJobRunStatus,
  BackgroundJobRunTrigger,
  BackgroundJobStatus,
} from "../constants.js";

export interface BackgroundJob {
  id: string;
  companyId: string;
  key: string;
  jobType: string;
  displayName: string;
  description: string | null;
  backendKind: BackgroundJobBackendKind;
  status: BackgroundJobStatus;
  config: Record<string, unknown>;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  sourceIssueId: string | null;
  sourceProjectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BackgroundJobRun {
  id: string;
  companyId: string;
  jobId: string | null;
  jobKey: string;
  jobType: string;
  trigger: BackgroundJobRunTrigger;
  status: BackgroundJobRunStatus;
  requestedByActorType: "agent" | "user" | "system";
  requestedByActorId: string;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  sourceIssueId: string | null;
  sourceProjectId: string | null;
  sourceAgentId: string | null;
  heartbeatRunId: string | null;
  totalItems: number | null;
  processedItems: number;
  succeededItems: number;
  failedItems: number;
  skippedItems: number;
  progressPercent: number | null;
  currentItem: string | null;
  cancellationRequestedAt: Date | null;
  cancelledAt: Date | null;
  error: string | null;
  result: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BackgroundJobEvent {
  id: string;
  companyId: string;
  runId: string;
  eventType: BackgroundJobEventType;
  level: BackgroundJobEventLevel;
  message: string | null;
  progressPercent: number | null;
  totalItems: number | null;
  processedItems: number | null;
  succeededItems: number | null;
  failedItems: number | null;
  skippedItems: number | null;
  currentItem: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export interface BackgroundJobCostEvent {
  id: string;
  companyId: string;
  runId: string;
  costEventId: string;
  createdAt: Date;
}
