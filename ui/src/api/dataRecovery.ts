import type {
  DataRecoveryDeleteResponse,
  DataRecoveryDetailResponse,
  DataRecoveryItemType,
  DataRecoveryListResponse,
  DataRecoveryRenameResponse,
  DataRecoveryRestoreResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const dataRecoveryApi = {
  list: () => api.get<DataRecoveryListResponse>("/instance/settings/data-recovery"),
  details: (type: DataRecoveryItemType, id: string) =>
    api.get<DataRecoveryDetailResponse>(
      `/instance/settings/data-recovery/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    ),
  restore: (type: DataRecoveryItemType, id: string) =>
    api.post<DataRecoveryRestoreResponse>(
      `/instance/settings/data-recovery/${encodeURIComponent(type)}/${encodeURIComponent(id)}/restore`,
      {},
    ),
  renameAgent: (id: string, name: string) =>
    api.post<DataRecoveryRenameResponse>(
      `/instance/settings/data-recovery/agent/${encodeURIComponent(id)}/rename`,
      { name },
    ),
  deletePermanent: (type: DataRecoveryItemType, id: string) =>
    api.delete<DataRecoveryDeleteResponse>(
      `/instance/settings/data-recovery/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    ),
};
