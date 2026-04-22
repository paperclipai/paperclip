export type WorkspaceMcpServerTransport = "stdio" | "http";

export interface WorkspaceMcpServerEnvValue {
  type: "plain" | "secret_ref";
  value?: string;
  secretId?: string;
  version?: number | "latest";
}

export type WorkspaceMcpServerEnv = Record<string, WorkspaceMcpServerEnvValue>;

export interface WorkspaceMcpServerConfig {
  name: string;
  transport: WorkspaceMcpServerTransport;
  enabled?: boolean;
  description?: string | null;
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  url?: string | null;
  headers?: Record<string, string> | null;
  env?: WorkspaceMcpServerEnv | null;
  timeoutSec?: number | null;
  includeTools?: string[] | null;
  excludeTools?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

export interface WorkspaceMcpRuntimeConfig {
  mcpServers: WorkspaceMcpServerConfig[];
}
