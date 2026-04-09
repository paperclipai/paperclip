import type { FeedbackDataSharingPreference } from "./feedback.js";
import type { SsoProviderType } from "../config-schema.js";

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
}

export interface InstanceExperimentalSettings {
  enableIsolatedWorkspaces: boolean;
  autoRestartDevServerWhenIdle: boolean;
}

export interface InstanceSsoProviderEntry {
  providerId: string;
  type: SsoProviderType;
  clientId: string;
  clientSecret: string;
  issuer?: string;
  discoveryUrl?: string;
  tenantId?: string;
  domain?: string;
  displayName?: string;
  scopes?: string[];
  requiredRoles?: { claimPath: string; roles: string[] };
}

export interface InstanceSsoSettings {
  enabled: boolean;
  providers: InstanceSsoProviderEntry[];
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettings;
  sso: InstanceSsoSettings;
  createdAt: Date;
  updatedAt: Date;
}
