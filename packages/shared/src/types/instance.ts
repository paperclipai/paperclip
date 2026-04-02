import type { FeedbackDataSharingPreference } from "./feedback.js";

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
