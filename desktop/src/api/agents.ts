import { tauriInvoke } from "./tauri-client";

export interface Agent {
  id: string;
  company_id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reports_to: string | null;
  adapter_type: string;
  adapter_config: string;
  budget_monthly_cents: number;
  spent_monthly_cents: number;
  pause_reason: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentStatus =
  | "idle"
  | "active"
  | "running"
  | "paused"
  | "error"
  | "terminated"
  | "pending_approval";

export interface CreateAgentInput {
  name: string;
  role?: string;
  title?: string;
  icon?: string;
  adapter_type?: string;
  adapter_config?: string;
  reports_to?: string;
  budget_monthly_cents?: number;
}

export interface UpdateAgentInput {
  name?: string;
  role?: string;
  title?: string;
  icon?: string;
  adapter_type?: string;
  adapter_config?: string;
  reports_to?: string;
  budget_monthly_cents?: number;
}

export interface HeartbeatRun {
  id: string;
  company_id: string;
  agent_id: string;
  invocation_source: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  exit_code: number | null;
  usage_json: string;
  stdout_excerpt: string | null;
  created_at: string;
}

export interface OrgNode {
  id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: string;
  adapter_type: string;
  reports_to: string | null;
  children: OrgNode[];
}

export const agentsApi = {
  list: (companyId: string) =>
    tauriInvoke<Agent[]>("list_agents", { companyId }),

  get: (id: string) =>
    tauriInvoke<Agent>("get_agent", { id }),

  create: (companyId: string, data: CreateAgentInput) =>
    tauriInvoke<Agent>("create_agent", { companyId, data }),

  update: (id: string, data: UpdateAgentInput) =>
    tauriInvoke<Agent>("update_agent", { id, data }),

  delete: (id: string) =>
    tauriInvoke<void>("delete_agent", { id }),

  pause: (id: string, reason?: string) =>
    tauriInvoke<Agent>("pause_agent", { id, reason }),

  resume: (id: string) =>
    tauriInvoke<Agent>("resume_agent", { id }),

  terminate: (id: string) =>
    tauriInvoke<Agent>("terminate_agent", { id }),

  listRuns: (agentId: string) =>
    tauriInvoke<HeartbeatRun[]>("list_heartbeat_runs", { agentId }),

  getOrgTree: (companyId: string) =>
    tauriInvoke<OrgNode[]>("get_org_tree", { companyId }),
};
