import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";
import { loadPluginToolDefinitions } from "./plugin-tools.js";

export function createPaperclipMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
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

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server, client } = createPaperclipMcpServer(config);

  // Plugin tools are discovered at startup. They're folded in alongside the
  // built-in `paperclip*` tools so a single MCP server gives the agent
  // access to both paperclip's first-class entities and the live plugin
  // tool registry (Linear, Slack, Alertmanager, future GitHub/Figma).
  // If the registry is unreachable we still serve built-ins (load function
  // logs to stderr and returns []).
  const pluginTools = await loadPluginToolDefinitions(client);
  for (const tool of pluginTools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
