export interface BrabrixEndpointsConfig {
  projectContext: string | null;
  nextTask: string | null;
  sendRunLogs: string | null;
  completeTask: string | null;
}

export interface BrabrixConfig {
  apiUrl: string | null;
  agentToken: string | null;
  projectId: string | null;
  tenantId: string | null;
  agentId: string | null;
  provider: string | null;
  endpoints: BrabrixEndpointsConfig;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

export interface BrabrixReadyConfig {
  apiUrl: string | null;
  agentToken: string;
  projectId: string;
  tenantId: string | null;
  agentId: string | null;
  provider: string | null;
  endpoints: {
    projectContext: string;
    nextTask: string;
    sendRunLogs: string;
    completeTask: string;
  };
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

export const DEFAULT_BRABRIX_API_URL = "https://api.brabrix.com";

export const DEFAULT_BRABRIX_ENDPOINTS = {
  projectContext: "/v1/projects/{projectId}/context",
  nextTask: "/v1/projects/{projectId}/tasks/next",
  sendRunLogs: "/v1/projects/{projectId}/runs/{runId}/logs",
  completeTask: "/v1/projects/{projectId}/tasks/{taskId}/complete",
} as const;

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const raw = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return raw;
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  const raw = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return raw;
}

export function getBrabrixConfig(env: NodeJS.ProcessEnv = process.env): BrabrixConfig {
  return {
    apiUrl: nonEmpty(env.BRABRIX_API_URL) ?? DEFAULT_BRABRIX_API_URL,
    agentToken: nonEmpty(env.BRABRIX_AGENT_TOKEN),
    projectId: nonEmpty(env.BRABRIX_PROJECT_ID),
    tenantId: nonEmpty(env.BRABRIX_TENANT_ID),
    agentId: nonEmpty(env.BRABRIX_AGENT_ID),
    provider: nonEmpty(env.BRABRIX_PROVIDER),
    endpoints: {
      projectContext: nonEmpty(env.BRABRIX_PROJECT_CONTEXT_ENDPOINT) ?? DEFAULT_BRABRIX_ENDPOINTS.projectContext,
      nextTask: nonEmpty(env.BRABRIX_NEXT_TASK_ENDPOINT) ?? DEFAULT_BRABRIX_ENDPOINTS.nextTask,
      sendRunLogs: nonEmpty(env.BRABRIX_SEND_RUN_LOGS_ENDPOINT) ?? DEFAULT_BRABRIX_ENDPOINTS.sendRunLogs,
      completeTask: nonEmpty(env.BRABRIX_COMPLETE_TASK_ENDPOINT) ?? DEFAULT_BRABRIX_ENDPOINTS.completeTask,
    },
    timeoutMs: readPositiveInteger(env.BRABRIX_HTTP_TIMEOUT_MS, 10_000),
    maxRetries: readNonNegativeInteger(env.BRABRIX_HTTP_MAX_RETRIES, 2),
    retryDelayMs: readNonNegativeInteger(env.BRABRIX_HTTP_RETRY_DELAY_MS, 400),
  };
}

export function resolveBrabrixConfig(config: BrabrixConfig): BrabrixReadyConfig | null {
  if (
    !config.agentToken
    || !config.projectId
    || !config.endpoints.projectContext
    || !config.endpoints.nextTask
    || !config.endpoints.sendRunLogs
    || !config.endpoints.completeTask
  ) {
    return null;
  }

  return {
    apiUrl: config.apiUrl,
    agentToken: config.agentToken,
    projectId: config.projectId,
    tenantId: config.tenantId,
    agentId: config.agentId,
    provider: config.provider,
    endpoints: {
      projectContext: config.endpoints.projectContext,
      nextTask: config.endpoints.nextTask,
      sendRunLogs: config.endpoints.sendRunLogs,
      completeTask: config.endpoints.completeTask,
    },
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    retryDelayMs: config.retryDelayMs,
  };
}
