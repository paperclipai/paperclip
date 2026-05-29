import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

interface AgentToolDescriptor {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  pluginId: string;
}

async function loadPluginTools(client: PaperclipApiClient): Promise<AgentToolDescriptor[]> {
  try {
    const tools = await client.requestJson<AgentToolDescriptor[]>("GET", "/api/plugins/tools");
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

function buildZodSchemaFromJsonSchema(schema: Record<string, unknown>): z.ZodRawShape {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required as string[] : []);
  const shape: z.ZodRawShape = {};
  for (const [key, prop] of Object.entries(properties)) {
    const type = prop.type as string | undefined;
    let zodType: z.ZodTypeAny;
    if (type === "number" || type === "integer") {
      zodType = z.number();
    } else if (type === "boolean") {
      zodType = z.boolean();
    } else if (type === "array") {
      zodType = z.array(z.unknown());
    } else if (type === "object") {
      zodType = z.record(z.unknown());
    } else {
      zodType = z.string();
    }
    if (prop.description) zodType = zodType.describe(prop.description as string);
    shape[key] = required.has(key) ? zodType : zodType.optional();
  }
  return shape;
}

function registerPluginTool(
  server: McpServer,
  client: PaperclipApiClient,
  tool: AgentToolDescriptor,
  runId: string | undefined,
) {
  const shape = buildZodSchemaFromJsonSchema(tool.parametersSchema);
  server.tool(
    tool.name,
    tool.description,
    shape,
    async (params) => {
      try {
        const result = await client.requestJson<unknown>("POST", "/api/plugins/tools/execute", {
          body: {
            tool: tool.name,
            parameters: params,
            runContext: { runId: runId ?? null },
          },
          includeRunId: true,
        });
        return {
          content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Plugin tool error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}

export async function createPaperclipMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  const tools = createToolDefinitions(client);
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, tool.execute);
  }

  const pluginTools = await loadPluginTools(client);
  for (const pluginTool of pluginTools) {
    registerPluginTool(server, client, pluginTool, config.runId);
  }

  return {
    server,
    tools,
    pluginTools,
    client,
  };
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = await createPaperclipMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
