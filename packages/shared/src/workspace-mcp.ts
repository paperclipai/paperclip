import type { WorkspaceMcpRuntimeConfig, WorkspaceMcpServerConfig } from "./types/mcp-runtime.js";
import { workspaceMcpRuntimeConfigSchema } from "./validators/mcp-runtime.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneServer(server: WorkspaceMcpServerConfig): WorkspaceMcpServerConfig {
  return {
    ...server,
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.headers ? { headers: { ...server.headers } } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(server.includeTools ? { includeTools: [...server.includeTools] } : {}),
    ...(server.excludeTools ? { excludeTools: [...server.excludeTools] } : {}),
    ...(server.metadata && isRecord(server.metadata) ? { metadata: { ...server.metadata } } : {}),
  };
}

export function readWorkspaceMcpRuntimeConfig(
  workspaceRuntime: Record<string, unknown> | null | undefined,
): WorkspaceMcpRuntimeConfig | null {
  if (!isRecord(workspaceRuntime)) return null;
  const parsed = workspaceMcpRuntimeConfigSchema.safeParse({
    mcpServers: workspaceRuntime.mcpServers,
  });
  if (!parsed.success || parsed.data.mcpServers.length === 0) return null;
  return {
    mcpServers: parsed.data.mcpServers.map(cloneServer),
  };
}

export function listWorkspaceMcpServers(
  workspaceRuntime: Record<string, unknown> | null | undefined,
  options?: { includeDisabled?: boolean },
): WorkspaceMcpServerConfig[] {
  const config = readWorkspaceMcpRuntimeConfig(workspaceRuntime);
  if (!config) return [];
  if (options?.includeDisabled) return config.mcpServers.map(cloneServer);
  return config.mcpServers.filter((server) => server.enabled !== false).map(cloneServer);
}
