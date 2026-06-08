import type { FeedbackDataSharingPreference } from "./feedback.js";

export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;
export const DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24;
export const MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 1;
export const MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24 * 30;
export const MASTER_RUNTIME_FAILOVER_MODES = ["auto", "force_claude", "force_codex"] as const;

export type MasterRuntimeFailoverMode = (typeof MASTER_RUNTIME_FAILOVER_MODES)[number];
export type MasterRuntimeKey = "claude" | "codex";

export interface MasterRuntimeFailoverSettings {
  mode: MasterRuntimeFailoverMode;
  claudeLimitedUntil: string | null;
  codexLimitedUntil: string | null;
  activeRuntime: MasterRuntimeKey | null;
  reason: string | null;
  updatedAt: string | null;
}

export const DEFAULT_MASTER_RUNTIME_FAILOVER: MasterRuntimeFailoverSettings = {
  mode: "auto",
  claudeLimitedUntil: null,
  codexLimitedUntil: null,
  activeRuntime: null,
  reason: null,
  updatedAt: null,
};

// TWB-305: bounded auto-clear of transient agent errors so crashed agents
// self-recover to a schedulable state instead of needing a manual board reset.
export const DEFAULT_TRANSIENT_AGENT_ERROR_AUTO_CLEAR_MAX_ATTEMPTS = 4;
export const MIN_TRANSIENT_AGENT_ERROR_AUTO_CLEAR_MAX_ATTEMPTS = 1;
export const MAX_TRANSIENT_AGENT_ERROR_AUTO_CLEAR_MAX_ATTEMPTS = 20;

export interface BackupRetentionPolicy {
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
}

export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  enableIsolatedWorkspaces: boolean;
  enableStreamlinedLeftNavigation: boolean;
  enableIssuePlanDecompositions: boolean;
  enableCloudSync: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableIssueGraphLivenessAutoRecovery: boolean;
  issueGraphLivenessAutoRecoveryLookbackHours: number;
  masterRuntimeFailover: MasterRuntimeFailoverSettings;
  // TWB-305: when enabled, the scheduler tick auto-clears transient agent
  // errors (adapter process exit, upstream API hiccup, timeout) back to a
  // schedulable state after a bounded backoff. Hard failures stay `error`.
  enableTransientAgentErrorAutoClear: boolean;
  // Max consecutive transient failures auto-cleared before the agent is left
  // in `error` for human attention (anti-thrash bound).
  transientAgentErrorAutoClearMaxAttempts: number;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueGraphLivenessAutoRecoveryPreviewItem {
  issueId: string;
  identifier: string | null;
  title: string;
  state: string;
  severity: string;
  reason: string;
  recoveryIssueId: string;
  recoveryIdentifier: string | null;
  recoveryTitle: string | null;
  recommendedOwnerAgentId: string | null;
  incidentKey: string;
  latestDependencyUpdatedAt: string;
  dependencyPath: Array<{
    issueId: string;
    identifier: string | null;
    title: string;
    status: string;
  }>;
}

export interface IssueGraphLivenessAutoRecoveryPreview {
  lookbackHours: number;
  cutoff: string;
  generatedAt: string;
  findings: number;
  recoverableFindings: number;
  skippedOutsideLookback: number;
  items: IssueGraphLivenessAutoRecoveryPreviewItem[];
}
