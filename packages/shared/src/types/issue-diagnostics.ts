import type { IssuePriority, IssueStatus } from "../constants.js";

export type IssueBlockerDiagnosticFlag =
  | "done_but_blocking"
  | "cancelled_blocker_in_set"
  | "workspace_finalize_pending";

export interface IssueBlockerDiagnosticIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface IssueBlockerDiagnosticNode extends IssueBlockerDiagnosticIssueSummary {
  isUnresolved: boolean;
  isDependencyReady: boolean;
  isPendingFinalize: boolean;
  flags: IssueBlockerDiagnosticFlag[];
}

export interface IssueBlockerDiagnosticsReadiness {
  allBlockersDone: boolean;
  isDependencyReady: boolean;
  unresolvedBlockerCount: number;
  pendingFinalizeBlockerCount: number;
}

export interface IssueBlockerDiagnosticsResponse {
  issue: IssueBlockerDiagnosticIssueSummary;
  diagnosis: string | null;
  readiness: IssueBlockerDiagnosticsReadiness | null;
  blockers: IssueBlockerDiagnosticNode[];
  omittedUnauthorizedBlockerCount: number | null;
  truncated: boolean;
  caps: {
    maxBlockers: number;
  };
}

export type IssueWakeDiagnosticWakeFailureClass = "failed" | "cancelled" | "skipped";

export interface IssueWakeDiagnosticWakeRequest {
  kind: "wake_request";
  agentId: string | null;
  source: string;
  reason: string | null;
  status: string;
  coalescedCount: number;
  runId: string | null;
  requestedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  failureClass: IssueWakeDiagnosticWakeFailureClass | null;
}

export interface IssueWakeDiagnosticActivityRecord {
  kind: "activity";
  action: string;
  entityType: string;
  agentId: string | null;
  runId: string | null;
  createdAt: string;
  source: string | null;
  requestedReason: string | null;
  previousReason: string | null;
  rootIssueId: string | null;
  holdId: string | null;
  summary: string;
}

export type IssueWakeDiagnosticEvent =
  | IssueWakeDiagnosticWakeRequest
  | IssueWakeDiagnosticActivityRecord;

export interface IssueWakeDiagnosticsResponse {
  issue: IssueBlockerDiagnosticIssueSummary;
  diagnosis: string | null;
  likelyReason: string | null;
  events: IssueWakeDiagnosticEvent[];
  wakeRequestCount: number;
  activityRecordCount: number;
  truncated: boolean;
  truncatedSections: {
    wakeRequests: boolean;
    activityRecords: boolean;
  };
  caps: {
    maxWakeRequests: number;
    maxActivityRecords: number;
    lookbackDays: number;
  };
}

export interface IssueSubtreeDiagnosticNode {
  issue: IssueBlockerDiagnosticIssueSummary;
  parentId: string | null;
  depth: number;
  diagnosis: string | null;
  likelyReason: string | null;
  blockers: IssueBlockerDiagnosticNode[];
  blockerReadiness: IssueBlockerDiagnosticsReadiness | null;
  omittedUnauthorizedBlockerCount: number | null;
  wakeEvents: IssueWakeDiagnosticEvent[];
  wakeRequestCount: number;
  activityRecordCount: number;
  truncated: boolean;
  truncatedSections: {
    blockers: boolean;
    wakeRequests: boolean;
    activityRecords: boolean;
  };
}

export type IssueSubtreeDiagnosticEdge =
  | {
    kind: "parent";
    fromIssueId: string;
    toIssueId: string;
    timestamp: string | null;
  }
  | {
    kind: "blocks";
    fromIssueId: string;
    toIssueId: string;
    timestamp: string | null;
  }
  | {
    kind: "wake_request";
    issueId: string;
    agentId: string | null;
    reason: string | null;
    status: string;
    timestamp: string;
  }
  | {
    kind: "activity";
    issueId: string;
    action: string;
    timestamp: string;
  };

export interface IssueSubtreeDiagnosticsResponse {
  issue: IssueBlockerDiagnosticIssueSummary;
  diagnosis: string | null;
  likelyReason: string | null;
  nodes: IssueSubtreeDiagnosticNode[];
  edges: IssueSubtreeDiagnosticEdge[];
  nodeCount: number;
  omittedUnauthorizedNodeCount: number | null;
  truncated: boolean;
  truncatedSections: {
    nodes: boolean;
    depth: boolean;
    blockers: boolean;
    wakeRequests: boolean;
    activityRecords: boolean;
  };
  caps: {
    maxDepth: number;
    maxNodes: number;
    maxBlockersPerNode: number;
    maxWakeRequestsPerNode: number;
    maxActivityRecordsPerNode: number;
    lookbackDays: number;
  };
}
