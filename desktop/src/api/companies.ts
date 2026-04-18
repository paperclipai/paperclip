import { tauriInvoke } from "./tauri-client";

export interface Company {
  id: string;
  name: string;
  issue_prefix: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CreateCompanyInput {
  name: string;
  issue_prefix: string;
}

export const companiesApi = {
  list: () => tauriInvoke<Company[]>("list_companies"),

  get: (id: string) => tauriInvoke<Company>("get_company", { id }),

  create: (data: CreateCompanyInput) =>
    tauriInvoke<Company>("create_company", { data }),

  importBundled: (templateName: string, adapterType?: string, adapterConfig?: string) =>
    tauriInvoke<Company>("import_bundled_company", { templateName, adapterType, adapterConfig }),

  importFromGithub: (githubUrl: string) =>
    tauriInvoke<Company>("import_github_company", { githubUrl }),

  importJson: (jsonData: string) =>
    tauriInvoke<Company>("import_company", { jsonData }),

  export: (companyId: string) =>
    tauriInvoke<string>("export_company", { companyId }),
};
