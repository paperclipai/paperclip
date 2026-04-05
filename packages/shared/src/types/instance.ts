import type { FeedbackDataSharingPreference } from "./feedback.js";

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
}

export interface CrashMonitoringSettings {
  enabled: boolean;
  monitoringAgentId: string | null;
  failureThreshold: number;
  timeWindowMs: number;
  cooldownMs: number;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enforceBlockedOnValidation: boolean;
  autoLabelRulesEngine: boolean;
  crashMonitoring: CrashMonitoringSettings;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
