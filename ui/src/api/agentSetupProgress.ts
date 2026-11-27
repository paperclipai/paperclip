import type { AgentSetupProgress, AgentSetupProgressHandoff, CreateAgentSetupProgress } from "@paperclipai/shared";
import { api } from "./client";

/** Checklists a person's own agent fills in while it sets something up (see AgentSetupProgressPanel). */
export const agentSetupProgressApi = {
  create: (companyId: string, input: CreateAgentSetupProgress) =>
    api.post<AgentSetupProgressHandoff>(`/companies/${companyId}/agent-setup-progress`, input),
  get: (id: string) => api.get<AgentSetupProgress>(`/agent-setup-progress/${id}`),
};
