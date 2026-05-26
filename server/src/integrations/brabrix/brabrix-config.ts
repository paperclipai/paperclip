export interface BrabrixConfig {
  apiUrl: string | null;
  agentToken: string | null;
  projectId: string | null;
}

export interface BrabrixReadyConfig {
  apiUrl: string;
  agentToken: string;
  projectId: string;
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function getBrabrixConfig(env: NodeJS.ProcessEnv = process.env): BrabrixConfig {
  return {
    apiUrl: nonEmpty(env.BRABRIX_API_URL),
    agentToken: nonEmpty(env.BRABRIX_AGENT_TOKEN),
    projectId: nonEmpty(env.BRABRIX_PROJECT_ID),
  };
}

export function resolveBrabrixConfig(config: BrabrixConfig): BrabrixReadyConfig | null {
  if (!config.apiUrl || !config.agentToken || !config.projectId) return null;
  return {
    apiUrl: config.apiUrl,
    agentToken: config.agentToken,
    projectId: config.projectId,
  };
}
