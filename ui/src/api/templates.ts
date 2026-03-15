import type { CompanyTemplateCatalogEntry, CompanyTemplateDetail } from "@paperclipai/shared";
import { api } from "./client";

export const templatesApi = {
  list: () => api.get<CompanyTemplateCatalogEntry[]>("/templates"),
  get: (templateId: string) =>
    api.get<CompanyTemplateDetail>(`/templates/${encodeURIComponent(templateId)}`),
};
