import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ResendClient } from "./client.js";
import { readConfigFromEnv, type ResendMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export { readConfigFromEnv } from "./config.js";
export type { ResendMcpConfig } from "./config.js";
export { ResendClient } from "./client.js";

export function createResendMcpServer(config: ResendMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({ name: "resend", version: "0.1.0" });
  const client = new ResendClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }
  return { server, tools, client };
}

export async function runServer(config: ResendMcpConfig = readConfigFromEnv()) {
  const { server } = createResendMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
