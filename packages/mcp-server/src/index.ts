import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createToolDefinitions } from "./tools.js";

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

async function registerPluginTools(server: McpServer, client: PaperclipApiClient, config: PaperclipMcpConfig): Promise<number> {
  let pluginTools: Awaited<ReturnType<typeof client.listPluginTools>>;
  try {
    pluginTools = await client.listPluginTools();
  } catch {
    return 0;
  }

  const agentId = config.agentId ?? "";
  const runId = config.runId ?? "";
  const companyId = config.companyId ?? "";

  for (const tool of pluginTools) {
    const inputSchema = jsonSchemaToZodShape(tool.parametersSchema);
    server.tool(tool.name, tool.description, inputSchema, async (params) => {
      try {
        const result = await client.executePluginTool({
          tool: tool.name,
          parameters: params,
          agentId,
          runId,
          companyId,
        });
        return {
          content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Plugin tool error: ${message}` }],
          isError: true,
        };
      }
    });
  }

  return pluginTools.length;
}

function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  if (!properties) return {};

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propRaw] of Object.entries(properties)) {
    const prop = propRaw as Record<string, unknown>;
    shape[key] = jsonSchemaPropertyToZod(prop, required.includes(key));
  }
  return shape;
}

function jsonSchemaPropertyToZod(prop: Record<string, unknown>, isRequired: boolean): z.ZodTypeAny {
  let type: z.ZodTypeAny;
  const description = typeof prop.description === "string" ? prop.description : undefined;

  switch (prop.type) {
    case "number":
    case "integer":
      type = description ? z.number().describe(description) : z.number();
      break;
    case "boolean":
      type = description ? z.boolean().describe(description) : z.boolean();
      break;
    case "array": {
      const items = prop.items as Record<string, unknown> | undefined;
      const itemType = items ? jsonSchemaPropertyToZod(items, true) : z.unknown();
      type = description ? z.array(itemType).describe(description) : z.array(itemType);
      break;
    }
    case "object": {
      const nested = jsonSchemaToZodShape(prop as Record<string, unknown>);
      type = description ? z.object(nested).describe(description) : z.object(nested);
      break;
    }
    default:
      type = description ? z.string().describe(description) : z.string();
  }

  return isRequired ? type : type.optional();
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server, client } = createPaperclipMcpServer(config);
  await registerPluginTools(server, client, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
