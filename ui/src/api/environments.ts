import type { Environment, EnvironmentCapabilities, EnvironmentLease, EnvironmentProbeResult } from "@paperclipai/shared";
import { api } from "./client";

export const environmentsApi = {
  list: (companyId: string) => api.get<Environment[]>(`/companies/${companyId}/environments`),
  capabilities: (companyId: string) =>
    api.get<EnvironmentCapabilities>(`/companies/${companyId}/environments/capabilities`),
  lease: (leaseId: string) => api.get<EnvironmentLease>(`/environment-leases/${leaseId}`),
  create: (companyId: string, body: {
    name: string;
    description?: string | null;
    driver: "local" | "ssh";
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  }) => api.post<Environment>(`/companies/${companyId}/environments`, body),
  update: (environmentId: string, body: {
    name?: string;
    description?: string | null;
    driver?: "local" | "ssh";
    status?: "active" | "archived";
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  }) => api.patch<Environment>(`/environments/${environmentId}`, body),
  probe: (environmentId: string) => api.post<EnvironmentProbeResult>(`/environments/${environmentId}/probe`, {}),
  probeConfig: (companyId: string, body: {
    name?: string;
    description?: string | null;
    driver: "local" | "ssh";
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  }) => api.post<EnvironmentProbeResult>(`/companies/${companyId}/environments/probe-config`, body),
};
