import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AiTeamCorpApiClient } from "./client.js";
import { readConfigFromEnv, type AiTeamCorpMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createAiTeamCorpMcpServer(config: AiTeamCorpMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "aiteamcorp",
    version: "0.1.0",
  });

  const client = new AiTeamCorpApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: AiTeamCorpMcpConfig = readConfigFromEnv()) {
  const { server } = createAiTeamCorpMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
