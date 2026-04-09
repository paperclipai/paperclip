import type {
  InstanceExperimentalSettings,
  InstanceGeneralSettings,
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
  getBackup: () =>
    api.get<InstanceBackupSettingsResponse>("/instance/settings/backup"),
  updateBackup: (patch: PatchInstanceBackupSettings) =>
    api.patch<InstanceBackupSettingsResponse>("/instance/settings/backup", patch),
};
