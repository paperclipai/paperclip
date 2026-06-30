import type {
  AgentWorkflow,
  AgentWorkflowRun,
  CompanyIntegrator,
  ConnectorDefinition,
  FactoryAgentCreateInput,
  FactoryAgentSummary,
  WorkflowCreateInput,
  WorkflowStep,
  WorkflowTemplate,
} from "@paperclipai/shared";
import { api } from "./client";

export interface IntegratorRunResult {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  method: string;
  durationMs: number;
  data: unknown;
  error?: string;
}

export const agentsStudioApi = {
  listConnectors: () => api.get<{ connectors: ConnectorDefinition[] }>(`/agents-studio/connectors`),

  listTemplates: () => api.get<{ templates: WorkflowTemplate[] }>(`/agents-studio/templates`),

  list: (companyId: string) =>
    api.get<{ workflows: AgentWorkflow[] }>(`/companies/${companyId}/workflows`),

  get: (companyId: string, id: string) =>
    api.get<{ workflow: AgentWorkflow }>(`/companies/${companyId}/workflows/${id}`),

  create: (companyId: string, data: WorkflowCreateInput) =>
    api.post<{ workflow: AgentWorkflow }>(`/companies/${companyId}/workflows`, data),

  update: (
    companyId: string,
    id: string,
    data: Partial<Pick<AgentWorkflow, "name" | "description" | "status"> & { steps: WorkflowStep[] }>,
  ) => api.patch<{ workflow: AgentWorkflow }>(`/companies/${companyId}/workflows/${id}`, data),

  remove: (companyId: string, id: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/workflows/${id}`),

  deployTemplate: (companyId: string, templateKey: string, name?: string) =>
    api.post<{ workflow: AgentWorkflow }>(`/companies/${companyId}/workflows/deploy`, {
      templateKey,
      ...(name ? { name } : {}),
    }),

  listRuns: (companyId: string, id: string) =>
    api.get<{ runs: AgentWorkflowRun[] }>(`/companies/${companyId}/workflows/${id}/runs`),

  run: (companyId: string, id: string, trigger = "manual") =>
    api.post<{ run: AgentWorkflowRun }>(`/companies/${companyId}/workflows/${id}/run`, { trigger }),

  deployChannel: (companyId: string, id: string) =>
    api.post<{ token: string; workflowId: string; path: string }>(
      `/companies/${companyId}/workflows/${id}/deploy-channel`,
      {},
    ),

  listAgents: (companyId: string) =>
    api.get<{ agents: FactoryAgentSummary[] }>(`/companies/${companyId}/agents-studio/agents`),

  createAgent: (companyId: string, data: FactoryAgentCreateInput) =>
    api.post<{ agent: { id: string; name: string } }>(`/companies/${companyId}/agents-studio/agents`, data),

  listIntegrators: (companyId: string) =>
    api.get<{ integrators: CompanyIntegrator[] }>(`/companies/${companyId}/integrators`),

  connectIntegrator: (companyId: string, key: string, config: Record<string, unknown>) =>
    api.post<{ integrator: CompanyIntegrator }>(`/companies/${companyId}/integrators/${key}/connect`, { config }),

  disconnectIntegrator: (companyId: string, key: string) =>
    api.post<{ integrator: CompanyIntegrator }>(`/companies/${companyId}/integrators/${key}/disconnect`, {}),

  runIntegratorAction: (companyId: string, key: string, action: string, inputs: Record<string, unknown>) =>
    api.post<{ result: IntegratorRunResult }>(`/companies/${companyId}/integrators/${key}/run-action`, { action, inputs }),

  provisionOrg: (companyId: string) =>
    api.post<{ created: { key: string; id: string; name: string }[]; createdCount: number; skippedCount: number; totalMembers: number }>(
      `/companies/${companyId}/agents-studio/provision-org`,
      {},
    ),
};
