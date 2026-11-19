import type { ApproveCompanyMcpSkillRequest, CompanyMcpSkill } from "@paperclipai/shared";
import { api } from "./client";

/** Skills that connected apps publish over MCP, for board review. */
export const mcpSkillsApi = {
  list: (companyId: string) =>
    api.get<{ skills: CompanyMcpSkill[] }>(`/companies/${companyId}/mcp-skills`, { cache: "no-store" }).then((result) => result.skills),
  content: (companyId: string, skillId: string) =>
    api.get<{ markdown: string; manifestDigest: string }>(`/companies/${companyId}/mcp-skills/${skillId}/content`, { cache: "no-store" }),
  approve: (companyId: string, skillId: string, body: ApproveCompanyMcpSkillRequest) =>
    api.post<{ skill: CompanyMcpSkill }>(`/companies/${companyId}/mcp-skills/${skillId}/approve`, body),
  decline: (companyId: string, skillId: string) =>
    api.post<{ skill: CompanyMcpSkill }>(`/companies/${companyId}/mcp-skills/${skillId}/decline`, {}),
};
