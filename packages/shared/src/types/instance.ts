export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
  staleIssueMonitorEnabled: boolean;
  staleIssueIdleHoursCritical: number;
  staleIssueIdleHoursHigh: number;
  staleIssueIdleHoursMedium: number;
  staleIssueIdleHoursLow: number;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
