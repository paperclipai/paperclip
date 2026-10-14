import type { AiConnectionPool, AiConnectionPoolConfig, AiConnectionUsage } from "@paperclipai/shared";
import { api } from "./client";
export type PoolInspection = Record<string, { reason: string; checkedAt: string | null; usage?: AiConnectionUsage }>;
export const aiConnectionPoolsApi = {
  list: (companyId: string) => api.get<AiConnectionPool[]>(`/companies/${companyId}/ai-connection-pools`),
  save: (companyId: string, body: { pluginKey: string; id?: string; expectedRevision?: number; config: AiConnectionPoolConfig }) => api.post<AiConnectionPool>(`/companies/${companyId}/ai-connection-pools`, body),
  inspect: (companyId: string, id: string) => api.get<PoolInspection>(`/companies/${companyId}/ai-connection-pools/${id}/inspection`),
  remove: (companyId: string, id: string, expectedRevision: number) => api.delete(`/companies/${companyId}/ai-connection-pools/${id}`, { expectedRevision }),
};
