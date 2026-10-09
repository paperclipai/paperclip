import type { DecisionConnectionChoice, DecisionHistoryEntry, DecisionModelSettings, DecisionResult, UpdateDecisionModel } from "@paperclipai/shared";
import { api } from "./client";
export interface DecisionSettingsResponse { canManage: boolean; settings: DecisionModelSettings | null; choices: DecisionConnectionChoice[] }
export const decisionModelsApi = {
  settings: (companyId: string) => api.get<DecisionSettingsResponse>(`/companies/${companyId}/decision-model`),
  update: (companyId: string, settings: UpdateDecisionModel) => api.put<DecisionModelSettings>(`/companies/${companyId}/decision-model`, settings),
  test: (companyId: string) => api.post<DecisionResult>(`/companies/${companyId}/decision-model/test`, {}),
  history: (companyId: string, from?: string | null, to?: string | null) => {
    const params = new URLSearchParams({ limit: "100" });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return api.get<DecisionHistoryEntry[]>(`/companies/${companyId}/decision-model/history?${params}`);
  },
};
