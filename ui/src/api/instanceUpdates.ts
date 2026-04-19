import type {
  InstancePreUpdateBackupStatus,
  InstancePreUpdateBackupSummary,
  InstanceUpdateStatus,
} from "@paperclipai/shared";
import { api } from "./client";

export const instanceUpdatesApi = {
  getStatus: () => api.get<InstanceUpdateStatus>("/instance/update-status"),
  checkNow: () => api.post<InstanceUpdateStatus>("/instance/update-status/check", {}),
  dismiss: (version?: string | null) =>
    api.patch<InstanceUpdateStatus>("/instance/update-status/dismiss", version ? { version } : {}),
  getPreUpdateBackupStatus: (targetVersion?: string | null) => {
    const query = targetVersion ? `?targetVersion=${encodeURIComponent(targetVersion)}` : "";
    return api.get<InstancePreUpdateBackupStatus>(`/instance/backups/pre-update${query}`);
  },
  createPreUpdateBackup: (input: {
    targetVersion?: string | null;
    acknowledgeExternalStorage?: boolean;
  }) => api.post<InstancePreUpdateBackupSummary>("/instance/backups/pre-update", input),
};
