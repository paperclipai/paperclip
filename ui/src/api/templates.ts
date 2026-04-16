import type {
  TemplateCompany,
  TemplateInstallRequest,
  TemplateInstallResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const templatesApi = {
  list: () => api.get<{ companies: TemplateCompany[] }>("/templates/companies"),
  install: (body: TemplateInstallRequest) =>
    api.post<TemplateInstallResponse>("/templates/companies/install", body),
  refresh: () => api.post<{ ok: true; companies: number }>("/templates/refresh", {}),
};
