import type {
  InstanceExperimentalSettings,
  InstanceGeneralSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { api } from "./client";

export type InstanceUser = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
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
  listUsers: () =>
    api.get<InstanceUser[]>("/instance/users"),
  resetUserPassword: (userId: string, newPassword: string) =>
    api.post<{ status: boolean }>(`/instance/users/${userId}/reset-password`, { newPassword }),
};
