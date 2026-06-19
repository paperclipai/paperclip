export type CloudUpstreamStep = "connect" | "scan" | "preview" | "push" | "verify" | "activate";

export type CloudUpstreamRunStatus = "previewed" | "running" | "succeeded" | "failed" | "cancelled";

export type CloudUpstreamActivationEntityType = "agents" | "routines" | "monitors";

export interface CloudUpstreamActivationDecision {
  entityType: CloudUpstreamActivationEntityType;
  count: number;
  status: "paused" | "activated";
  activatedAt: string | null;
}

export interface CloudUpstreamTarget {
  stackId: string;
  stackSlug: string | null;
  stackDisplayName: string | null;
  companyId: string;
  primaryHost: string;
  origin: string;
  product: string;
  schemaMajor: number;
  maxChunkBytes: number;
}

export interface CloudUpstreamConnection {
  id: string;
  companyId: string;
  remoteUrl: string;
  target: CloudUpstreamTarget;
  tokenStatus: "pending" | "connected" | "expired" | "revoked";
  scopes: string[];
  authorizedGlobalUserId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunId: string | null;
}

export interface CloudUpstreamSummaryCount {
  key: string;
  label: string;
  count: number;
}

export interface CloudUpstreamWarning {
  code: string;
  severity: "warning" | "blocker";
  title: string;
  detail: string;
}

export interface CloudUpstreamConflict {
  id: string;
  entityType: string;
  sourceLabel: string;
  targetLabel: string;
  plannedAction: "create" | "update" | "skip" | "blocked";
  reason: string;
}

export interface CloudUpstreamPreview {
  connectionId: string;
  sourceCompanyId: string;
  target: CloudUpstreamTarget;
  schemaCompatible: boolean;
  summary: CloudUpstreamSummaryCount[];
  warnings: CloudUpstreamWarning[];
  conflicts: CloudUpstreamConflict[];
  generatedAt: string;
}

export interface CloudUpstreamRunEvent {
  id: string;
  at: string;
  phase: CloudUpstreamStep;
  type: "created" | "updated" | "skipped" | "conflict" | "retrying" | "failed" | "completed";
  message: string;
}

export interface CloudUpstreamRun {
  id: string;
  connectionId: string;
  companyId: string;
  status: CloudUpstreamRunStatus;
  activeStep: CloudUpstreamStep;
  progressPercent: number;
  dryRun: boolean;
  summary: CloudUpstreamSummaryCount[];
  warnings: CloudUpstreamWarning[];
  conflicts: CloudUpstreamConflict[];
  events: CloudUpstreamRunEvent[];
  targetUrl: string | null;
  report: Record<string, unknown>;
  retryOfRunId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CloudUpstreamsState {
  connections: CloudUpstreamConnection[];
  runs: CloudUpstreamRun[];
}

export interface CloudUpstreamConnectStartResponse {
  pendingConnectionId: string;
  authorizationUrl: string;
  connection: CloudUpstreamConnection;
}
