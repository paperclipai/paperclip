import type { FeedbackDataSharingPreference } from "./feedback.js";

// --- Platform guard config ---

export const DEFAULT_GUARD_COMPANY_MONTHLY_TOKENS = 40_000_000;
export const DEFAULT_GUARD_AGENT_MONTHLY_TOKENS = 8_000_000;
export const DEFAULT_GUARD_WARN_PERCENT = 80;
export const DEFAULT_GUARD_MAX_TURNS_PER_RUN = 120;
export const DEFAULT_GUARD_MAX_TOKENS_PER_RUN = 1_000_000;
export const DEFAULT_GUARD_MAX_RUNS_PER_AGENT_PER_HOUR = 15;
export const DEFAULT_GUARD_MAX_CONSECUTIVE_SAME_ISSUE_RUNS = 6;
export const DEFAULT_GUARD_SKIP_IDLE_TIMER_WAKES = true;
export const DEFAULT_GUARD_PAUSE_ON_EMPTY_INSTRUCTIONS = true;

export interface InstanceGuardsBudgetConfig {
  metric: "total_tokens";
  windowKind: "calendar_month_utc";
  companyMonthlyTokens: number;
  agentMonthlyTokens: number;
  warnPercent: number;
  hardStop: boolean;
}

export interface InstanceGuardsPerRunConfig {
  maxTurnsPerRun: number;
  maxTokensPerRun: number;
}

export interface InstanceGuardsBreakerConfig {
  maxRunsPerAgentPerHour: number;
  maxConsecutiveSameIssueRuns: number;
}

export interface InstanceGuardsWakeConfig {
  // Skip timer-source heartbeat wakes for agents with no actionable work (W2).
  skipIdleTimerWakes: boolean;
  // Refuse to invoke a managed-bundle agent whose instruction bundle is empty (W1).
  pauseOnEmptyInstructions: boolean;
}

export interface InstanceGuardsConfig {
  enabled: boolean;
  budget: InstanceGuardsBudgetConfig;
  perRun: InstanceGuardsPerRunConfig;
  breaker: InstanceGuardsBreakerConfig;
  wake: InstanceGuardsWakeConfig;
}

export type PatchInstanceGuardsConfig = Partial<{
  enabled: boolean;
  budget: Partial<InstanceGuardsBudgetConfig>;
  perRun: Partial<InstanceGuardsPerRunConfig>;
  breaker: Partial<InstanceGuardsBreakerConfig>;
  wake: Partial<InstanceGuardsWakeConfig>;
}>;

// ------------------------------------

export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;
export const DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS = 24;
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
  soloMode: boolean;
  strictBoardTransitions: boolean;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  guards: InstanceGuardsConfig;
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
