import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ValadrienOsApiClient } from "./client.js";
import { readConfigFromEnv, type ValadrienOsMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createValadrienOsMcpServer(config: ValadrienOsMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "valadrien-os",
    version: "0.1.0",
  });

  const client = new ValadrienOsApiClient(config);
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

export async function runServer(config: ValadrienOsMcpConfig = readConfigFromEnv()) {
  const { server } = createValadrienOsMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
