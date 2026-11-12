import type { HarnessPool, HarnessPoolConfigV2, HarnessPoolChoice } from "@paperclipai/shared";
import { api } from "./client";
import type { PoolInspection } from "./ai-connection-pools";
const path = (companyId: string) => `/companies/${companyId}/harness-pools`;
export const harnessPoolsApi = {
  choices: (companyId: string) => api.get<HarnessPoolChoice[]>(`${path(companyId)}/choices`),
  list: (companyId: string) => api.get<HarnessPool[]>(path(companyId)),
  save: (companyId: string, body: { id?: string; expectedRevision?: number; config: HarnessPoolConfigV2 }) => api.post<HarnessPool>(path(companyId), body),
  inspect: (companyId: string, id: string) => api.get<{ members: PoolInspection; usedBy: { id: string; name: string }[] }>(`${path(companyId)}/${id}/inspection`),
  archive: (companyId: string, id: string, expectedRevision: number) => api.delete(`${path(companyId)}/${id}`, { expectedRevision }),
  convert: (companyId: string, id: string, expectedRevision: number, preview: boolean) => api.post<HarnessPool>(`${path(companyId)}/${id}/convert`, { expectedRevision, preview }),
};
