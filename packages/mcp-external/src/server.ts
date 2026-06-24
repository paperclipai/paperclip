import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipExternalConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

export function createMcpServer(config: PaperclipExternalConfig = readConfigFromEnv()) {
  const server = new McpServer({ name: "paperclip", version: "0.1.0" });
  const client = new PaperclipApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    // ToolDefinition uses loose arg types to stay transport-agnostic; the SDK's
    // typed ToolCallback is assignment-incompatible but functionally correct.
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute as never);
  }
  return { server, client, tools };
}
