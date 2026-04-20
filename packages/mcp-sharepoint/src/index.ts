import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SharepointClient } from "./client.js";
import { readConfigFromEnv, type SharepointMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export { readConfigFromEnv } from "./config.js";
export type { SharepointMcpConfig } from "./config.js";
export { SharepointClient } from "./client.js";

export function createSharepointMcpServer(config: SharepointMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "sharepoint",
    version: "0.1.0",
  });

  const client = new SharepointClient(config);
  const tools = createToolDefinitions(client);

  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  return { server, tools, client };
}

export async function runServer(config: SharepointMcpConfig = readConfigFromEnv()) {
  const { server } = createSharepointMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
