import { tauriInvoke } from "./tauri-client";

export interface CostSummary {
  total_cost_cents: number;
  total_input_tokens: number;
  total_output_tokens: number;
  event_count: number;
}

export interface CostByAgent {
  agent_id: string;
  total_cost_cents: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

export interface CostByModel {
  model: string;
  total_cost_cents: number;
  event_count: number;
}

export const costsApi = {
  getSummary: (companyId: string) =>
    tauriInvoke<CostSummary>("get_cost_summary", { companyId }),
  byAgent: (companyId: string) =>
    tauriInvoke<CostByAgent[]>("get_costs_by_agent", { companyId }),
  byModel: (companyId: string) =>
    tauriInvoke<CostByModel[]>("get_costs_by_model", { companyId }),
};
