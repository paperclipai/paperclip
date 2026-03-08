import type {
  ArchiveBackup,
  BackupHistoryActionResult,
  BackupOverview,
  BackupRestoreState,
  BackupRestorePreview,
  BackupRun,
  BackupSettings,
  DeleteBackup,
  RestoreBackup,
  UnarchiveBackup,
  UpdateBackupSettings,
} from "@paperclipai/shared";
import { api } from "./client";

export const backupsApi = {
  overview: () => api.get<BackupOverview>("/backups"),
  run: () => api.post<BackupRun>("/backups/run", {}),
  importFile: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.postForm<BackupRun>("/backups/import", form);
  },
  downloadUrl: (backupId: string) => `/api/backups/${encodeURIComponent(backupId)}/download`,
  previewRestore: (backupId: string) =>
    api.get<BackupRestorePreview>(`/backups/${encodeURIComponent(backupId)}/preview-restore`),
  restore: (backupId: string, data: RestoreBackup) =>
    api.post<BackupRestoreState>(`/backups/${encodeURIComponent(backupId)}/restore`, data),
  archive: (backupId: string, data: ArchiveBackup) =>
    api.post<BackupHistoryActionResult>(`/backups/${encodeURIComponent(backupId)}/archive`, data),
  unarchive: (backupId: string, data: UnarchiveBackup) =>
    api.post<BackupHistoryActionResult>(`/backups/${encodeURIComponent(backupId)}/unarchive`, data),
  delete: (backupId: string, data: DeleteBackup) =>
    api.post<BackupHistoryActionResult>(`/backups/${encodeURIComponent(backupId)}/delete`, data),
  updateSettings: (data: UpdateBackupSettings) =>
    api.patch<BackupSettings>("/backups/settings", data),
};
