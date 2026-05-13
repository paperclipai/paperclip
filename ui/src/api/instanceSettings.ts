import type {
  InstanceExperimentalSettings,
  InstanceGeneralSettings,
  IssueGraphLivenessAutoRecoveryPreview,
  InstanceBackupSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
  PatchInstanceBackupSettings,
} from "@paperclipai/shared";
import { api } from "./client";

export type InstanceBackupSettingsResponse = InstanceBackupSettings & {
  configFileExists: boolean;
  requiresRestart: boolean;
};

export const instanceSettingsApi = {
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
  getExperimental: () =>
    api.get<InstanceExperimentalSettings>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettings>("/instance/settings/experimental", patch),
  previewIssueGraphLivenessAutoRecovery: (input: { lookbackHours?: number }) =>
    api.post<IssueGraphLivenessAutoRecoveryPreview>(
      "/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview",
      input,
    ),
  runIssueGraphLivenessAutoRecovery: (input: { lookbackHours?: number }) =>
    api.post<{
      findings: number;
      autoRecoveryEnabled: boolean;
      lookbackHours: number;
      cutoff: string;
      escalationsCreated: number;
      existingEscalations: number;
      skipped: number;
      skippedAutoRecoveryDisabled: number;
      skippedOutsideLookback: number;
      escalationIssueIds: string[];
    }>(
      "/instance/settings/experimental/issue-graph-liveness-auto-recovery/run",
      input,
    ),
  getBackup: () =>
    api.get<InstanceBackupSettingsResponse>("/instance/settings/backup"),
  updateBackup: (patch: PatchInstanceBackupSettings) =>
    api.patch<InstanceBackupSettingsResponse>("/instance/settings/backup", patch),
};
