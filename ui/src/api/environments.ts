import type {
  CancelEnvironmentCustomImageSetupSession,
  Environment,
  EnvironmentCapabilities,
  EnvironmentLease,
  EnvironmentProbeResult,
  EnvironmentCustomImageSetupSession,
  EnvironmentCustomImageTemplate,
  EnvironmentCustomImageTerminalSessionToken,
  FinishEnvironmentCustomImageSetupSession,
  StartEnvironmentCustomImageSetupSession,
  CreateEnvironmentCustomImageTerminalSessionToken,
} from "@paperclipai/shared";
import { api } from "./client";

export interface EnvironmentCustomImageOverview {
  activeTemplate: EnvironmentCustomImageTemplate | null;
  /**
   * `false` means the environment config changed since capture and runs fall
   * back to the base image until a new image is captured. `null` when unknown.
   */
  activeTemplateMatchesConfig?: boolean | null;
  activeSession: EnvironmentCustomImageSetupSession | null;
  latestSession: EnvironmentCustomImageSetupSession | null;
}

export type EnvironmentCustomImageReconciliation =
  | { action: "relinked"; template: EnvironmentCustomImageTemplate }
  | { action: "detached"; template: EnvironmentCustomImageTemplate };

export type EnvironmentUpdateResult = Environment & {
  customImageReconciliation?: EnvironmentCustomImageReconciliation;
};

export interface EnvironmentCustomImageConnectionPayload {
  type: string;
  command?: string | null;
  token?: string | null;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface EnvironmentCustomImageSetupSessionResult {
  session: EnvironmentCustomImageSetupSession;
  connectionPayload: EnvironmentCustomImageConnectionPayload | null;
}

export interface EnvironmentCustomImageFinishResult extends EnvironmentCustomImageSetupSessionResult {
  template: EnvironmentCustomImageTemplate;
}

export interface EnvironmentCustomImageRollbackResult {
  activeTemplate: EnvironmentCustomImageTemplate;
  supersededTemplate: EnvironmentCustomImageTemplate;
}

function companyIdQuery(companyId: string): string {
  return `companyId=${encodeURIComponent(companyId)}`;
}

export interface EnvironmentSecretRefDescriptor {
  configPath: string;
  secretId: string;
  name: string;
  status: string;
  companyId: string;
  companyName: string | null;
}

export const environmentsApi = {
  list: (companyId: string) => api.get<Environment[]>(`/companies/${companyId}/environments`),
  capabilities: (companyId: string) =>
    api.get<EnvironmentCapabilities>(`/companies/${companyId}/environments/capabilities`),
  lease: (leaseId: string) => api.get<EnvironmentLease>(`/environment-leases/${leaseId}`),
  secretRefs: (environmentId: string) =>
    api.get<{ refs: EnvironmentSecretRefDescriptor[] }>(`/environments/${environmentId}/secret-refs`),
  create: (companyId: string, body: {
    name: string;
    description?: string | null;
    driver: "local" | "ssh" | "sandbox" | "plugin";
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  }) => api.post<Environment>(`/companies/${companyId}/environments`, body),
  update: (environmentId: string, body: {
    name?: string;
    description?: string | null;
    driver?: "local" | "ssh" | "sandbox" | "plugin";
    status?: "active" | "archived";
    config?: Record<string, unknown>;
    // The only field accepted on platform-managed environments (the server
    // write floor admits envVars-only patches there).
    envVars?: Environment["envVars"];
    metadata?: Record<string, unknown> | null;
    // Secret-context company for env var / config writes. Without it the
    // server can only infer a company from existing bindings or a
    // single-membership actor, and fails closed otherwise — a fresh
    // environment with no bindings needs the explicit context.
  }, companyId?: string | null) =>
    api.patch<EnvironmentUpdateResult>(
      companyId
        ? `/environments/${environmentId}?${companyIdQuery(companyId)}`
        : `/environments/${environmentId}`,
      body,
    ),
  probe: (environmentId: string, companyId?: string | null) =>
    api.post<EnvironmentProbeResult>(
      companyId
        ? `/environments/${environmentId}/probe?${companyIdQuery(companyId)}`
        : `/environments/${environmentId}/probe`,
      {},
    ),
  probeConfig: (companyId: string, body: {
    name?: string;
    driver: "local" | "ssh" | "sandbox" | "plugin";
    description?: string | null;
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown> | null;
  }) => api.post<EnvironmentProbeResult>(`/companies/${companyId}/environments/probe-config`, body),
  customImageTemplate: (environmentId: string, companyId: string) =>
    api.get<EnvironmentCustomImageOverview>(
      `/environments/${environmentId}/custom-image-template?${companyIdQuery(companyId)}`,
    ),
  startCustomImageSetupSession: (
    environmentId: string,
    companyId: string,
    body: StartEnvironmentCustomImageSetupSession = {},
  ) =>
    api.post<EnvironmentCustomImageSetupSessionResult>(
      `/environments/${environmentId}/custom-image-setup-sessions?${companyIdQuery(companyId)}`,
      body,
    ),
  customImageSetupSession: (sessionId: string) =>
    api.get<EnvironmentCustomImageSetupSessionResult>(
      `/environment-custom-image-setup-sessions/${sessionId}`,
    ),
  createCustomImageTerminalSessionToken: (
    sessionId: string,
    body: CreateEnvironmentCustomImageTerminalSessionToken = {},
  ) =>
    api.post<EnvironmentCustomImageTerminalSessionToken>(
      `/environment-custom-image-setup-sessions/${sessionId}/terminal-session-token`,
      body,
    ),
  finishCustomImageSetupSession: (
    sessionId: string,
    body: FinishEnvironmentCustomImageSetupSession = {},
  ) =>
    api.post<EnvironmentCustomImageFinishResult>(
      `/environment-custom-image-setup-sessions/${sessionId}/finish`,
      body,
    ),
  cancelCustomImageSetupSession: (
    sessionId: string,
    body: CancelEnvironmentCustomImageSetupSession = {},
  ) =>
    api.post<EnvironmentCustomImageSetupSession>(
      `/environment-custom-image-setup-sessions/${sessionId}/cancel`,
      body,
    ),
  rollbackCustomImageTemplate: (environmentId: string, companyId: string) =>
    api.post<EnvironmentCustomImageRollbackResult>(
      `/environments/${environmentId}/custom-image-template/rollback?${companyIdQuery(companyId)}`,
      {},
    ),
  disableCustomImageTemplate: (
    environmentId: string,
    companyId: string,
    options: { deleteProviderTemplate?: boolean } = {},
  ) =>
    api.delete<EnvironmentCustomImageTemplate>(
      `/environments/${environmentId}/custom-image-template?${companyIdQuery(companyId)}&deleteProviderTemplate=${options.deleteProviderTemplate === true ? "true" : "false"}`,
    ),
};
