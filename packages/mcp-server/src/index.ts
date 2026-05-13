import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OdysseusApiClient } from "./client.js";
import { readConfigFromEnv, type OdysseusMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createOdysseusMcpServer(config: OdysseusMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "odysseus",
    version: "0.1.0",
  });

  const client = new OdysseusApiClient(config);
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

export async function runServer(config: OdysseusMcpConfig = readConfigFromEnv()) {
  const { server } = createOdysseusMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
