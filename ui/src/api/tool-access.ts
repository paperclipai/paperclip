import type {
  AgentToolGrant,
  Approval,
  ApplyToolAccessPreset,
  CompanyTool,
  CompanyToolCreate,
  ToolAccessMatrix,
  ToolAccessMode,
  ToolAccessPreset,
  ToolAccessPresetCreate,
} from "@paperclipai/shared";
import { api } from "./client";

type GrantChangeResult = {
  grants: AgentToolGrant[];
  approvals?: Approval[];
};

export const toolAccessApi = {
  matrix: (companyId: string) =>
    api.get<ToolAccessMatrix>(`/companies/${encodeURIComponent(companyId)}/tools`),
  createTool: (companyId: string, data: CompanyToolCreate) =>
    api.post<CompanyTool>(`/companies/${encodeURIComponent(companyId)}/tools`, data),
  setGrants: (
    companyId: string,
    grants: Array<{ agentId: string; toolId: string; mode: ToolAccessMode }>,
  ) =>
    api.post<GrantChangeResult>(
      `/companies/${encodeURIComponent(companyId)}/tool-grants`,
      { grants },
    ),
  listPresets: (companyId: string) =>
    api.get<ToolAccessPreset[]>(`/companies/${encodeURIComponent(companyId)}/tool-presets`),
  createPreset: (companyId: string, data: ToolAccessPresetCreate) =>
    api.post<ToolAccessPreset>(`/companies/${encodeURIComponent(companyId)}/tool-presets`, data),
  applyPreset: (companyId: string, data: ApplyToolAccessPreset) =>
    api.post<GrantChangeResult>(
      `/companies/${encodeURIComponent(companyId)}/tool-presets/apply`,
      data,
    ),
};
