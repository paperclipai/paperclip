import { tauriInvoke } from "./tauri-client";

export interface CompanySkill {
  id: string;
  company_id: string;
  skill_key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  source_type: string;
  created_at: string;
  updated_at: string;
}

export const skillsApi = {
  listCompany: (companyId: string) =>
    tauriInvoke<CompanySkill[]>("list_company_skills", { companyId }),
  create: (companyId: string, data: { name: string; slug?: string; description?: string; markdown: string }) =>
    tauriInvoke<CompanySkill>("create_company_skill", { companyId, data }),
  delete: (id: string) =>
    tauriInvoke<void>("delete_company_skill", { id }),
  listAgent: (agentId: string) =>
    tauriInvoke<CompanySkill[]>("list_agent_skills", { agentId }),
  attach: (companyId: string, agentId: string, skillId: string) =>
    tauriInvoke<void>("attach_skill_to_agent", { companyId, agentId, skillId }),
  detach: (agentId: string, skillId: string) =>
    tauriInvoke<void>("detach_skill_from_agent", { agentId, skillId }),
};
