import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TeamsClient } from "./client.js";
import { readConfigFromEnv, type TeamsMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export { readConfigFromEnv } from "./config.js";
export type { TeamsMcpConfig } from "./config.js";
export { TeamsClient } from "./client.js";

export function createTeamsMcpServer(config: TeamsMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "teams",
    version: "0.1.0",
  });

  const client = new TeamsClient(config);
  const tools = createToolDefinitions(client);

  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return { server, tools, client };
}

export async function runServer(config: TeamsMcpConfig = readConfigFromEnv()) {
  const { server } = createTeamsMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
