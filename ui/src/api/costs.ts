import type { CostSummary, CostByAgent } from "@paperclipai/shared";
import { api } from "./client";

export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostDaily {
  date: string;
  costCents: number;
  heartbeats: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostVelocity {
  centsPerHour: number;
  heartbeatsPerHour: number;
  topAgentId: string;
  topAgentCents: number;
  windowMinutes: number;
}

function dateParams(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const costsApi = {
  summary: (companyId: string, from?: string, to?: string) =>
    api.get<CostSummary>(`/companies/${companyId}/costs/summary${dateParams(from, to)}`),
  byAgent: (companyId: string, from?: string, to?: string) =>
    api.get<CostByAgent[]>(`/companies/${companyId}/costs/by-agent${dateParams(from, to)}`),
  byProject: (companyId: string, from?: string, to?: string) =>
    api.get<CostByProject[]>(`/companies/${companyId}/costs/by-project${dateParams(from, to)}`),
  daily: (companyId: string, from?: string, to?: string, granularity?: "day" | "hour") => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (granularity) params.set("granularity", granularity);
    const qs = params.toString();
    return api.get<CostDaily[]>(`/companies/${companyId}/costs/daily${qs ? `?${qs}` : ""}`);
  },
  velocity: (companyId: string) =>
    api.get<CostVelocity>(`/companies/${companyId}/costs/velocity`),
};
