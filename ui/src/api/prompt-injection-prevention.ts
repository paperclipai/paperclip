import type { PromptInjectionPreventionSettings, PromptInjectionPreventionSettingsResponse, PromptInjectionTestResult, UpdatePromptInjectionPrevention } from "@paperclipai/shared";
import { api } from "./client";
const path = (companyId: string) => `/companies/${companyId}/prompt-injection-prevention`;
export const promptInjectionPreventionApi = {
  settings: (companyId: string) => api.get<PromptInjectionPreventionSettingsResponse>(path(companyId)),
  update: (companyId: string, data: UpdatePromptInjectionPrevention) => api.put<PromptInjectionPreventionSettings>(path(companyId), data),
  models: (companyId: string, connectionId: string) => api.get<Array<{ id: string; label?: string }>>(`${path(companyId)}/models?connectionId=${encodeURIComponent(connectionId)}`),
  test: (companyId: string) => api.post<PromptInjectionTestResult>(`${path(companyId)}/test`, {}),
};
