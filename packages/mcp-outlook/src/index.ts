import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OutlookClient } from "./client.js";
import { readConfigFromEnv, type OutlookMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export { readConfigFromEnv } from "./config.js";
export type { OutlookMcpConfig } from "./config.js";
export { OutlookClient } from "./client.js";

export function createOutlookMcpServer(config: OutlookMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({ name: "outlook", version: "0.1.0" });
  const client = new OutlookClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }
  return { server, tools, client };
}

export async function runServer(config: OutlookMcpConfig = readConfigFromEnv()) {
  const { server } = createOutlookMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
