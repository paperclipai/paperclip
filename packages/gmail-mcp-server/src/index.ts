import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readConfigFromEnv, type GmailMcpConfig } from "./config.js";
import { createGmailClient, type GmailClient } from "./google-client.js";
import { createToolDefinitions } from "./tools.js";

export interface CreateGmailMcpServerOptions {
  client?: GmailClient;
}

export function createGmailMcpServer(
  config: GmailMcpConfig = readConfigFromEnv(),
  options: CreateGmailMcpServerOptions = {},
) {
  const server = new McpServer({
    name: "paperclip-gmail",
    version: "0.1.0",
  });

  const client = options.client ?? createGmailClient(config.credentials);
  const tools = createToolDefinitions({
    client,
    secretRedactions: config.secretRedactions,
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema.shape,
        annotations: tool.annotations,
      },
      tool.execute,
    );
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: GmailMcpConfig = readConfigFromEnv()) {
  const { server } = createGmailMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { createGmailClient } from "./google-client.js";
export { createToolDefinitions } from "./tools.js";
export type { GmailMcpConfig } from "./config.js";
export type { GmailClient } from "./google-client.js";
