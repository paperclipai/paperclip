import { api } from "./client";

export interface MaximizerConfig {
  id: string;
  maximizerEnabled: boolean;
  maximizerMaxConsecutiveFailures: number;
  maximizerMaxRunsWithoutProgress: number;
  maximizerTokenVelocityLimit: number | null;
  maximizerAutoApprove: boolean;
}

export interface RunActionResult {
  id: string;
  status: string;
  pausedAt: string | null;
  interruptedAt: string | null;
  interruptMessage: string | null;
  interruptMode: string | null;
  circuitBreakerTripped: boolean;
  circuitBreakerReason: string | null;
}

export const runsApi = {
  pause: (companyId: string, runId: string) =>
    api.post<RunActionResult>(`/companies/${companyId}/runs/${runId}/pause`, {}),

  resume: (companyId: string, runId: string) =>
    api.post<RunActionResult>(`/companies/${companyId}/runs/${runId}/resume`, {}),

  interrupt: (
    companyId: string,
    runId: string,
    body: { message: string; mode: "hint" | "correction" | "hard_override" },
  ) => api.post<RunActionResult>(`/companies/${companyId}/runs/${runId}/interrupt`, body),

  abort: (companyId: string, runId: string, reason?: string) =>
    api.post<RunActionResult>(`/companies/${companyId}/runs/${runId}/abort`, { reason }),

  updateMaximizer: (
    companyId: string,
    agentId: string,
    config: {
      enabled?: boolean;
      maxConsecutiveFailures?: number;
      maxRunsWithoutProgress?: number;
      tokenVelocityLimit?: number | null;
      autoApprove?: boolean;
    },
  ) => api.patch<MaximizerConfig>(`/companies/${companyId}/agents/${agentId}/maximizer`, config),
};
