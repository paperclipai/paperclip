import type { FeedbackDataSharingPreference } from "./feedback.js";

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

/**
 * Instance-wide execution policy.
 *
 * - `"any"` (default / absent): unrestricted — any environment driver (local,
 *   ssh, sandbox) may run agents. Preserves single-tenant / local-trusted
 *   behavior.
 * - `"kubernetes"`: force ALL agent execution onto the Kubernetes
 *   sandbox-provider environment and REFUSE local/in-process execution. Used by
 *   shared cloud (cloud_tenant) instances so untrusted tenant agents can never
 *   run in the server process or on an unsandboxed local/ssh adapter.
 */
export type InstanceExecutionMode = "kubernetes" | "any";

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
  /**
   * Execution policy. Absent/`"any"` = unrestricted; `"kubernetes"` forces the
   * Kubernetes sandbox provider and denies local/ssh execution.
   */
  executionMode?: InstanceExecutionMode;
}

export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  /**
   * Exposes the experimental Paperclip Runner adapter for new selections.
   * Existing native runs ignore later flag changes so they remain recoverable.
   */
  enableNativeRunner: boolean;
  /**
   * Hide the local environment and run all agents in the platform-managed
   * sandbox environment. Run selection refuses local while this is on.
   */
  enableManagedSandboxOnly: boolean;
  enableIsolatedWorkspaces: boolean;
  enableStreamlinedLeftNavigation: boolean;
  enableApps: boolean;
  enablePipelines: boolean;
  enableCases: boolean;
  enableConferenceRoomChat: boolean;
  enableClassicTaskInterface: boolean;
  enableTaskWatchdogs: boolean;
  enableIssuePlanDecompositions: boolean;
  enableExperimentalFileViewer: boolean;
  enableExternalObjects: boolean;
  enableSmokeLab: boolean;
  enableBuiltInAgents: boolean;
  enableBetaSkills: boolean;
  enableSummaries: boolean;
  enableStatusCards: boolean;
  enableDecisions: boolean;
  enableGoalsSidebarLink: boolean;
  enableServerInfoDebugView: boolean;
  /**
   * Instructs agents to write user-interaction content (confirmations,
   * questions, suggested tasks, checkbox prompts) in ASD-STE100 Simplified
   * Technical English with brief decision context. Prompt-side only; no
   * behavior change outside interaction wording.
   */
  enableSimplifiedEnglishInteractions: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableIssueGraphLivenessAutoRecovery: boolean;
  enableWorkspaceBranchReconcileForward: boolean;
  enableWorkspaceDirtyQuarantineRepair: boolean;
  /**
   * On cloud-managed instances, grant the stack owner instance-admin access
   * to their own dedicated instance. Elevation is computed per request at the
   * trusted-header auth boundary (owner stack role + this flag); no
   * `instance_user_roles` row is ever written. Inert on self-hosted
   * instances, which have no trusted cloud tenant path.
   */
  enableOwnerInstanceAdmin: boolean;
  /**
   * Kill switch for the sandbox duplex command-stream bridge. Default off. The
   * host reads this per run before it selects the callback bridge transport.
   * Off forces the file bridge for every run with no manifest change and no
   * redeploy.
   */
  enableSandboxDuplexBridge: boolean;
  /** Default-off rollout gate for paperclip_runner provider WebSocket ingress. */
  enableRunnerPreviewIngress: boolean;
  /**
   * Worktree preview instances (`PAPERCLIP_IN_WORKTREE=true`) suppress the
   * heartbeat run engine by default so previews never self-execute tasks. When
   * this is enabled the worktree-instance scheduling suppression is lifted so
   * runs actually execute inside the preview. Ignored outside a worktree.
   */
  enableWorktreeRunExecution: boolean;
  /**
   * Server-managed cutoff recorded when worktree run execution is enabled in
   * this instance. Client PATCH payloads must not control this value.
   */
  worktreeRunExecutionActivatedAt: string | null;
  /**
   * Server-managed instance id captured with the cutoff so copied settings rows
   * from another instance fail closed.
   */
  worktreeRunExecutionActivationInstanceId: string | null;
  issueGraphLivenessAutoRecoveryLookbackHours: number;
}

/**
 * Boolean feature-flag keys of the experimental settings — the only keys a
 * cloud managed-config overlay may target. Server-managed bookkeeping fields
 * (activation cutoffs, lookback hours) are excluded by construction.
 */
export type ManagedExperimentalFeatureKey = {
  [K in keyof InstanceExperimentalSettings]-?: InstanceExperimentalSettings[K] extends boolean
    ? K
    : never;
}[keyof InstanceExperimentalSettings];

export const PAPERCLIP_CLOUD_MANAGED_BY = "paperclip-cloud" as const;

/** Per-key metadata attached to settings responses for cloud-overlaid keys. */
export interface ManagedSettingMetadata {
  managed: true;
  managedBy: typeof PAPERCLIP_CLOUD_MANAGED_BY;
}

/**
 * Experimental settings as returned by the settings API. On cloud-managed
 * instances (`PAPERCLIP_MANAGED_CONFIG` present) `managedKeys` lists every key
 * whose value is overlaid by the harness; self-hosted responses omit it.
 */
export interface InstanceExperimentalSettingsWithManaged extends InstanceExperimentalSettings {
  managedKeys?: Partial<Record<ManagedExperimentalFeatureKey, ManagedSettingMetadata>>;
}

export interface InstanceSettings {
  id: string;
  defaultEnvironmentId: string | null;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettingsWithManaged;
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
