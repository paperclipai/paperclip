import type {
  AgentToolGrant,
  CompanyTool,
  CompanyToolCreate,
  ToolAccessMatrix,
  ToolAccessMode,
} from "@paperclipai/shared";
import { api } from "./client";

export const toolAccessApi = {
  matrix: (companyId: string) =>
    api.get<ToolAccessMatrix>(`/companies/${encodeURIComponent(companyId)}/tools`),
  createTool: (companyId: string, data: CompanyToolCreate) =>
    api.post<CompanyTool>(`/companies/${encodeURIComponent(companyId)}/tools`, data),
  setGrants: (
    companyId: string,
    grants: Array<{ agentId: string; toolId: string; mode: ToolAccessMode }>,
  ) =>
    api.post<{ grants: AgentToolGrant[] }>(
      `/companies/${encodeURIComponent(companyId)}/tool-grants`,
      { grants },
    ),
};
