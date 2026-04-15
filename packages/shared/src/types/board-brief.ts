import type {
  BoardBriefActionKind,
  BoardBriefActionSeverity,
  BoardBriefAlertEventStatus,
  BoardBriefConfidenceLevel,
  BoardBriefFreshnessStatus,
  BoardBriefHealthTone,
  BoardBriefIncidentSeverity,
  BoardBriefIncidentType,
  BoardBriefOutputKind,
  BoardBriefSnapshotSource,
} from "../constants.js";
import type { DashboardBriefMetric } from "./dashboard.js";
import type { CompanyKpi } from "./executive-summary.js";

export interface BoardBriefFreshnessEntry {
  status: BoardBriefFreshnessStatus;
  lastUpdatedAt: Date | null;
  reason: string | null;
}

export interface BoardBriefHealth {
  tone: BoardBriefHealthTone;
  reasons: string[];
}

export interface BoardBriefTotals {
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  pendingApprovals: number;
}

export interface BoardBriefFocusArea {
  key: string;
  label: string;
  tone: BoardBriefHealthTone;
  changedIssueCount: number;
  blockedCount: number;
  failedRunCount: number;
  activeAgentCount: number;
  outputCount: number;
  latestUpdate: string;
  href: string;
}

export interface BoardBriefActionItem {
  key: string;
  kind: BoardBriefActionKind;
  entityId: string;
  title: string;
  reason: string;
  severity: BoardBriefActionSeverity;
  timestamp: Date;
  href: string;
  ctaLabel: string;
}

export interface BoardBriefIncident {
  fingerprint: string;
  type: BoardBriefIncidentType;
  severity: BoardBriefIncidentSeverity;
  entityType: string | null;
  entityId: string | null;
  title: string;
  reason: string;
  openedAt: Date;
  lastSeenAt: Date;
  shouldAlert: boolean;
}

export interface BoardBriefOutput {
  id: string;
  kind: BoardBriefOutputKind;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  projectId: string | null;
  title: string;
  subtitle: string | null;
  url: string | null;
  outputType: string;
  status: string | null;
  reviewState: string | null;
  updatedAt: Date;
}

export interface BoardBrief {
  meta: {
    companyId: string;
    schemaVersion: 1;
    generatedAt: Date;
    windowStart: Date;
    windowEnd: Date;
  };
  totals: BoardBriefTotals;
  health: BoardBriefHealth;
  freshness: {
    execution: BoardBriefFreshnessEntry;
    work: BoardBriefFreshnessEntry;
    cost: BoardBriefFreshnessEntry;
    approvals: BoardBriefFreshnessEntry;
    outputs: BoardBriefFreshnessEntry;
  };
  confidence: BoardBriefConfidenceLevel;
  snapshot: {
    progress: DashboardBriefMetric;
    risk: DashboardBriefMetric;
    decisions: DashboardBriefMetric;
    spend: DashboardBriefMetric;
    outputs: DashboardBriefMetric;
  };
  focusAreas: BoardBriefFocusArea[];
  actionQueue: BoardBriefActionItem[];
  incidents: BoardBriefIncident[];
  outputs: BoardBriefOutput[];
  manualKpis: CompanyKpi[];
}

export interface BoardBriefSnapshot {
  id: string;
  companyId: string;
  source: BoardBriefSnapshotSource;
  schemaVersion: number;
  health: BoardBriefHealthTone;
  confidence: BoardBriefConfidenceLevel;
  windowStart: Date;
  windowEnd: Date;
  generatedAt: Date;
  relatedAlertEventId: string | null;
  payload: BoardBrief;
  createdAt: Date;
}

export interface BoardBriefAlertEvent {
  id: string;
  companyId: string;
  fingerprint: string;
  incidentType: BoardBriefIncidentType;
  severity: BoardBriefIncidentSeverity;
  entityType: string | null;
  entityId: string | null;
  status: BoardBriefAlertEventStatus;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  firstSentAt: Date | null;
  lastSentAt: Date | null;
  lastSnapshotId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
