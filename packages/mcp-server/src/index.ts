import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { TransportRunner } from "@paperclipai/mcp-transport";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createPaperclipHttpAuthenticator } from "./http.js";
import { createToolDefinitions } from "./tools.js";
import { createStderrTelemetrySink, type ToolTelemetry } from "./telemetry.js";

export function createPaperclipMcpServer(
  config: PaperclipMcpConfig = readConfigFromEnv(),
  options: { telemetry?: ToolTelemetry } = {},
) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  // Every tool call emits one structured telemetry event (actor, company, tool,
  // status, duration) for audit + anomaly detection (NEO-296). The default sink
  // writes JSON lines to stderr; stdout is reserved for the MCP JSON-RPC stream.
  const telemetry = options.telemetry ?? { sink: createStderrTelemetrySink() };
  const tools = createToolDefinitions(client, telemetry);
  for (const tool of tools) {
    // The MCP SDK invokes the handler as (args, extra); we intentionally drop
    // `extra` so each tool falls back to its request-scoped default context
    // (the actor bound to this per-request client) rather than the SDK's
    // transport extra object.
    server.tool(tool.name, tool.description, tool.schema.shape, (args: Record<string, unknown>) =>
      tool.execute(args),
    );
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createPaperclipMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Build the dual-mode ({@link TransportRunner}) descriptor for the Paperclip MCP
 * server: stdio identity from the environment, http identity from a bearer token
 * resolved via SSM. Consumed by the CLI entrypoint (`main.ts`).
 */
export function buildPaperclipRunner(
  options: { env?: NodeJS.ProcessEnv } = {},
): TransportRunner<PaperclipMcpConfig> {
  const env = options.env ?? process.env;
  return {
    name: "paperclip-mcp",
    buildServer: (config) => createPaperclipMcpServer(config).server,
    configFromEnv: () => readConfigFromEnv(env),
    authenticate: createPaperclipHttpAuthenticator({ env }),
    describeConfig: (config) =>
      `company=${config.companyId ?? "-"} agent=${config.agentId ?? "-"} api=${config.apiUrl}`,
  };
}
