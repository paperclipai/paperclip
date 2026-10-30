import { createHash } from "node:crypto";
import { isToolConnectionAttentionHealth, type ToolConnection } from "@paperclipai/shared";
import { isBrowserUseConnection } from "./browser-use-client.js";
import { restConnectorFor } from "./connectors/rest-registry.js";

type AssignedTool = { id: string; applicationId: string | null; connectionId: string; toolName: string };

export function projectRuntimeMcpAssignment(input: {
  agentId: string;
  connections: ToolConnection[];
  allowedTools: AssignedTool[];
  permittedConnectionIds: ReadonlySet<string>;
  identityContextActive: boolean;
  githubBotConnectionIds: ReadonlySet<string>;
  spekoConnectionIds: ReadonlySet<string | null | undefined>;
}) {
  const connections = input.connections.filter(connection => input.permittedConnectionIds.has(connection.id)
    && connection.status === "active" && connection.enabled
    && (input.identityContextActive && (connection.config?.sourceTemplateKey === "github" || connection.transportConfig?.sourceTemplateKey === "github")
      || connection.credentialPolicy === "per_user" || !isToolConnectionAttentionHealth(connection.healthStatus))
    && (["mcp_remote", "local_stdio"].includes(connection.transport) || isBrowserUseConnection(connection)
      || restConnectorFor(connection) || input.githubBotConnectionIds.has(connection.id) || input.spekoConnectionIds.has(connection.id)));
  const connectionIds = new Set(connections.map(connection => connection.id));
  const tools = input.allowedTools.filter(tool => connectionIds.has(tool.connectionId));
  const assignment = { version: 1, agentId: input.agentId,
    connections: [...connectionIds].sort(), tools: tools.map(tool => tool.id).sort() };
  const digest = createHash("sha256").update(JSON.stringify(assignment)).digest("hex");
  return { connections, tools, digest };
}
