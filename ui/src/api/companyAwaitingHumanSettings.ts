import type {
  ClickUpAwaitingHumanConnectionTestResult,
  CompanyAwaitingHumanSettings,
  UpdateCompanyAwaitingHumanSettingsRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export const companyAwaitingHumanSettingsApi = {
  get: (companyId: string) =>
    api.get<CompanyAwaitingHumanSettings>(`/companies/${companyId}/awaiting-human-settings`),
  update: (companyId: string, data: UpdateCompanyAwaitingHumanSettingsRequest) =>
    api.patch<CompanyAwaitingHumanSettings>(`/companies/${companyId}/awaiting-human-settings`, data),
  testConnection: (companyId: string, data: UpdateCompanyAwaitingHumanSettingsRequest) =>
    api.post<ClickUpAwaitingHumanConnectionTestResult>(
      `/companies/${companyId}/awaiting-human-settings/connection-test`,
      data,
    ),
};
