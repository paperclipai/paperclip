import type {
  InstanceExperimentalSettings,
  InstanceGeneralSettings,
  InstanceSsoSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
  PatchInstanceSsoSettings,
} from "@paperclipai/shared";
import { api } from "./client";

export const instanceSettingsApi = {
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
  getExperimental: () =>
    api.get<InstanceExperimentalSettings>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettings>("/instance/settings/experimental", patch),
  getSso: () =>
    api.get<InstanceSsoSettings>("/instance/settings/sso"),
  updateSso: (patch: PatchInstanceSsoSettings) =>
    api.patch<InstanceSsoSettings>("/instance/settings/sso", patch),
};
