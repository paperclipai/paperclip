export type ProjectPortfolioState =
  | "primary"
  | "active"
  | "blocked"
  | "paused"
  | "parked"
  | "closed";

export type ProjectPhase =
  | "exploration"
  | "validation"
  | "build"
  | "distribution";

export type ProjectConstraintLane = "product" | "customer" | "distribution";

export type ProjectStaleStatus = "fresh" | "aging" | "stale" | "critical";

export interface ProjectControlPlaneLastOutput {
  kind: "issue" | "work_product" | "document" | "external_link" | "note";
  id: string | null;
  title: string;
  url: string | null;
}

export interface ProjectControlPlaneState {
  portfolioState: ProjectPortfolioState;
  currentPhase: ProjectPhase;
  constraintLane: ProjectConstraintLane | null;
  nextSmallestAction: string | null;
  blockerSummary: string | null;
  latestEvidenceChanged: string | null;
  resumeBrief: string | null;
  doNotRethink: string | null;
  killCriteria: string | null;
  lastMeaningfulOutput: ProjectControlPlaneLastOutput | null;
}

export interface ProjectControlPlaneTelemetry {
  lastTouchedAt: string | null;
  lastActivityAt: string | null;
  issueCounts: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
    total: number;
  };
  laneIssueCounts: {
    product: { open: number; inProgress: number; blocked: number; done: number; total: number };
    customer: { open: number; inProgress: number; blocked: number; done: number; total: number };
    distribution: { open: number; inProgress: number; blocked: number; done: number; total: number };
  };
  latestArtifact: {
    id: string | null;
    title: string | null;
    url: string | null;
    updatedAt: string | null;
  } | null;
  repoSnapshot: {
    workspaceId: string | null;
    sourceType: string | null;
    status: "ok" | "warning" | "unavailable";
    branch: string | null;
    headShaShort: string | null;
    dirty: boolean | null;
    dirtySummary: string | null;
    lastCommitAt: string | null;
    aheadBy: number | null;
    behindBy: number | null;
  } | null;
  runHealth: {
    status: "ok" | "warning" | "error" | "idle";
    lastRunAt: string | null;
    lastRunOutcome: "success" | "failed" | "cancelled" | "unknown";
  };
  budgetHealth: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  staleStatus: ProjectStaleStatus;
  staleReason: string | null;
  attentionScore: number;
  refreshedAt: string;
}

export interface ProjectControlPlaneResponse {
  projectId: string;
  companyId: string;
  controlPlaneState: ProjectControlPlaneState | null;
  telemetry: ProjectControlPlaneTelemetry | null;
  warnings: string[];
}

export interface ProjectPortfolioSummary {
  projectId: string;
  name: string;
  color: string | null;
  controlPlaneState: ProjectControlPlaneState | null;
  controlPlaneUpdatedAt: string | null;
  staleStatus: ProjectStaleStatus;
  attentionScore: number;
  warnings: string[];
}

export interface PortfolioResponse {
  companyId: string;
  summary: {
    primaryCount: number;
    activeCount: number;
    staleCount: number;
    blockedCount: number;
  };
  warnings: string[];
  projects: ProjectPortfolioSummary[];
}
