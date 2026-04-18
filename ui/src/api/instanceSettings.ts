import type {
  InstanceExperimentalSettings,
  InstanceGeneralSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { api } from "./client";

export type AutomationPreflightState = "healthy" | "degraded" | "unknown";

export interface AutomationPreflightCheck {
  id: string;
  label: string;
  state: AutomationPreflightState;
  detail: string;
  impacts: string[];
  lastUpdatedAt: string | null;
}

export interface AutomationPreflightResult {
  checkedAt: string;
  state: AutomationPreflightState;
  headline: string;
  detail: string;
  prAutomationDegraded: boolean;
  checks: AutomationPreflightCheck[];
}

export interface DashboardSyncResult {
  sourceRepo: string;
  targetRepo: string;
  sourceHead: string | null;
  targetHead: string | null;
  restartRecommended: boolean;
  syncedAt: string;
  stdout: string;
  stderr: string;
}

export const instanceSettingsApi = {
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
  getExperimental: () =>
    api.get<InstanceExperimentalSettings>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettings>("/instance/settings/experimental", patch),
  getAutomationPreflight: () =>
    api.get<AutomationPreflightResult>("/instance/settings/automation-preflight"),
  syncDashboardRepo: () =>
    api.post<DashboardSyncResult>("/instance/settings/sync-dashboard-repo", {}),
};
