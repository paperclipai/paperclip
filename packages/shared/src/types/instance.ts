import type { FeedbackDataSharingPreference } from "./feedback.js";

export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;
// Min-staleness threshold (post-2026-05-06 RCA gate inversion). The
// constant name preserves on-disk compatibility with the
// `issueGraphLivenessAutoRecoveryLookbackHours` instance setting key, but
// the semantic is now: an issue must have been silently quiet for at
// least this many hours to be eligible for auto-recovery escalation.
// Default lowered from 24h to 6h after operator feedback that 24h is too
// long to wait when an issue is genuinely stuck with no active execution
// path and no human review in flight.
export const DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 6;
export const MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 1;
export const MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24 * 30;

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
  /**
   * Shell command fired when an adapter run reports `provider_quota_exhausted`.
   * Typical use: `ccrotate next --yes` to rotate to a non-rate-limited account.
   * Reactive — runs after the failure surfaces. Debounced to once per 60s.
   */
  quotaExhaustedCmd: string | null;
  /**
   * Shell command fired before every agent run, after the run has been queued
   * but before the adapter spawns the agent process. Typical use:
   * `ccrotate snap --force; ccrotate next --yes` to refresh and rotate creds.
   * Synchronous — the run waits for this to exit (timeout 30s) before
   * proceeding. Set to null to disable.
   */
  preRunCmd: string | null;
  /**
   * Shell command fired after every agent run finishes (regardless of exit
   * status). Typical use: `ccrotate refresh-one` to keep the tier-cache warm
   * for the next run. Asynchronous — does not block run finalization.
   */
  postRunCmd: string | null;
}

export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  enableIsolatedWorkspaces: boolean;
  enableIssuePlanDecompositions: boolean;
  enableCloudSync: boolean;
  enableDoneExecutionGate: boolean;
  enableInReviewEvidenceGate: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableIssueGraphLivenessAutoRecovery: boolean;
  issueGraphLivenessAutoRecoveryLookbackHours: number;
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
  // Latest meaningful activity timestamp on the recovery issue (or oldest
  // activity in the dependency chain when the recovery issue is a self-leaf).
  // Null when no activity record is available (newly inserted issues
  // pre-`lastActivityAt` backfill, or rows not loaded from the activity map).
  latestDependencyUpdatedAt: string | null;
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
