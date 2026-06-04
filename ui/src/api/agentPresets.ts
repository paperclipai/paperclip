import { api } from "./client";

export interface AgentPresetEntry {
  agentNameKey: string;
  agentName: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
}

export interface AgentPreset {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  snapshot: AgentPresetEntry[];
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPresetApplyResult {
  appliedAgentIds: string[];
  unmatched: Array<{ agentNameKey: string; agentName: string }>;
  total: number;
  dryRun: boolean;
}

export const agentPresetsApi = {
  list: (companyId: string) =>
    api.get<{ items: AgentPreset[] }>(`/companies/${companyId}/agent-presets`),
  create: (companyId: string, input: { name: string; description?: string }) =>
    api.post<{ preset: AgentPreset }>(`/companies/${companyId}/agent-presets`, input),
  remove: (companyId: string, presetId: string) =>
    api.delete<void>(`/companies/${companyId}/agent-presets/${presetId}`),
  apply: (companyId: string, presetId: string, options: { dryRun?: boolean } = {}) =>
    api.post<AgentPresetApplyResult>(
      `/companies/${companyId}/agent-presets/${presetId}/apply${options.dryRun ? "?dryRun=true" : ""}`,
      {},
    ),
};
