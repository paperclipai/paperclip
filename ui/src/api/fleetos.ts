/**
 * FleetOS API client and React Query hooks (RAA-292).
 *
 * All calls go through the dashboard server's proxy layer at /api/fleetos/*
 * so the FleetOS API key never leaves the server.
 */

import { api } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FleetContainer {
  id: string;
  name: string;
  status: "running" | "stopped" | "frozen" | "error" | "provisioning";
  tenant_id: string;
  image: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  ip_address: string | null;
  labels: Record<string, string>;
  health: FleetHealth | null;
}

export interface FleetHealth {
  cpu_percent: number;
  mem_percent: number;
  disk_percent: number;
  agent_status: "idle" | "busy" | "error" | "offline";
  uptime_seconds: number;
  uptime_display: string;
  last_heartbeat: string;
}

export interface FleetAgentProcess {
  pid: number | null;
  status: "running" | "stopped" | "crashed";
  uptime_seconds: number;
  last_error: string | null;
}

export type FleetAction = "start" | "stop" | "restart";

// ---------------------------------------------------------------------------
// Provision types (RAA-294)
// ---------------------------------------------------------------------------

export interface FleetTemplate {
  name: string;
  label: string;
  description?: string;
}

export interface FleetTemplateField {
  name: string;
  label: string;
  type: "string" | "select" | "boolean" | "number" | "text";
  required: boolean;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  description?: string;
  group?: string;
}

export interface FleetTemplateDetail extends FleetTemplate {
  fields: FleetTemplateField[];
  default_memory?: string;
  default_cpu?: string;
  default_disk?: string;
}

export interface ProvisionValidateRequest {
  template: string;
  tenant_id?: string;
  agent_name: string;
  agent_role: string;
  model?: string;
  memory?: string;
  cpu?: string;
  disk?: string;
  secrets_mode?: string;
  extra_fields?: Record<string, string>;
}

export interface ProvisionValidateResponse {
  valid: boolean;
  container_name?: string;
  checks?: { name: string; status: string; detail?: string }[];
  errors?: string[];
  warnings?: string[];
}

export interface ProvisionRequest {
  template: string;
  tenant_id?: string;
  agent_name: string;
  agent_role: string;
  model?: string;
  memory?: string;
  cpu?: string;
  disk?: string;
  secrets_mode?: string;
  extra_fields?: Record<string, string>;
}

export interface ProvisionStartResponse {
  job_id: string;
  status: string;
  message: string;
}

export interface ProvisionJob {
  id: string;
  status: "running" | "complete" | "failed" | "cancelled" | "timeout";
  template: string;
  tenant_id: string;
  agent_name: string;
  container_name?: string;
  steps?: ProvisionStep[];
  result?: Record<string, unknown>;
  error?: string;
  created_at?: string;
  completed_at?: string;
}

export interface ProvisionStep {
  name: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  detail?: string;
  started_at?: string;
  completed_at?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Auth types
// ---------------------------------------------------------------------------

export interface FleetosLoginResponse {
  tenantId: string;
  tenantName: string;
  companyId: string;
}

export interface FleetosMeResponse {
  tenantId: string;
  companyId: string;
  userId: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export const fleetosAuthApi = {
  /** Log in with a FleetOS API key. Returns tenant info on success. */
  login: (apiKey: string) =>
    api.post<FleetosLoginResponse>("/fleetos/login", { apiKey }),

  /** Log out of the FleetOS session. */
  logout: () => api.post<{ ok: boolean }>("/fleetos/logout", {}),

  /** Get current FleetOS session info. */
  me: () => api.get<FleetosMeResponse>("/fleetos/me"),
};

export const fleetosApi = {
  /** List all containers (with best-effort health merged). */
  listContainers: () =>
    api.get<{ containers: FleetContainer[] }>("/fleetos/containers").then((r) => r.containers),

  /** Get a single container detail (with health merged). */
  getContainer: (id: string) =>
    api.get<FleetContainer>(`/fleetos/containers/${encodeURIComponent(id)}`),

  /** Get health metrics for a container. */
  getHealth: (id: string) =>
    api.get<FleetHealth>(`/fleetos/containers/${encodeURIComponent(id)}/health`),

  /** Get agent process status. */
  getAgentProcess: (id: string) =>
    api.get<FleetAgentProcess>(`/fleetos/containers/${encodeURIComponent(id)}/agent`),

  /** Perform a lifecycle action (start / stop / restart). */
  containerAction: (id: string, action: FleetAction) =>
    api.post<FleetContainer>(`/fleetos/containers/${encodeURIComponent(id)}/${action}`, {}),

  // -------------------------------------------------------------------------
  // Provision endpoints (RAA-294)
  // -------------------------------------------------------------------------

  /** List available provision templates. */
  listTemplates: () =>
    api.get<FleetTemplate[]>("/fleetos/templates"),

  /** Get a single template with its field definitions. */
  getTemplate: (name: string) =>
    api.get<FleetTemplateDetail>(`/fleetos/templates/${encodeURIComponent(name)}`),

  /** Validate a provision request without starting it. */
  validateProvision: (body: ProvisionValidateRequest) =>
    api.post<ProvisionValidateResponse>("/fleetos/provision/validate", body),

  /** Start a provision job. */
  startProvision: (body: ProvisionRequest) =>
    api.post<ProvisionStartResponse>("/fleetos/provision", body),

  /** Get provision job status / progress. */
  getProvisionJob: (jobId: string) =>
    api.get<ProvisionJob>(`/fleetos/provision/${encodeURIComponent(jobId)}`),
};
