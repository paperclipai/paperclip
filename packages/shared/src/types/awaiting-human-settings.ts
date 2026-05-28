export type AwaitingHumanProvider = "clickup";

export interface ClickUpAwaitingHumanProviderConfig {
  workspaceId: string | null;
  channelId: string | null;
}

export type AwaitingHumanProviderConfig = ClickUpAwaitingHumanProviderConfig;

export interface CompanyAwaitingHumanSettings {
  companyId: string;
  enabled: boolean;
  provider: AwaitingHumanProvider | null;
  providerConfig: AwaitingHumanProviderConfig | null;
  hasStoredAuthToken: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface UpdateCompanyAwaitingHumanSettingsRequest {
  enabled?: boolean;
  provider?: AwaitingHumanProvider | null;
  providerConfig?: AwaitingHumanProviderConfig | null;
  clickupPersonalToken?: string | null;
}
