export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
}

export interface InstanceSettings {
  id: string;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
