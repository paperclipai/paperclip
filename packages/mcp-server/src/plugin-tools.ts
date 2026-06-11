import { z } from "zod";
import { PaperclipApiClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";
import type { ToolDefinition } from "./tools.js";

/**
 * Plugin tool descriptor returned by `GET /api/plugins/tools`. Mirrors the
 * server-side `AgentToolDescriptor` interface in
 * `server/src/services/plugin-tool-dispatcher.ts`.
 */
interface PluginToolDescriptor {
  name: string;
  displayName?: string;
  description?: string;
  parametersSchema?: Record<string, unknown> | null;
  pluginId?: string;
}

interface PluginToolExecuteResponse {
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
}

/**
 * Convert a JSON Schema object to a zod ZodRawShape. Covers the subset that
 * paperclip plugin tools actually use: top-level objects with primitive
 * properties (string, number, boolean, array, object). Unknown shapes fall
 * back to `z.unknown()`. Required fields come from the JSON Schema's
 * `required` array; everything else becomes `.optional()`.
 *
 * The plugin worker re-validates input against the real schema, so this
 * only needs to be good enough for the MCP client to construct a call —
 * not for full validation.
 */
function jsonSchemaToZodShape(schema: unknown): z.ZodRawShape {
  if (!schema || typeof schema !== "object") return {};
  const obj = schema as Record<string, unknown>;
  if (obj.type !== "object") return {};

  const properties = (obj.properties ?? {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(obj.required) ? (obj.required as string[]) : []);

  const shape: z.ZodRawShape = {};
  for (const [key, raw] of Object.entries(properties)) {
    const propSchema = jsonSchemaPropToZod(raw);
    shape[key] = required.has(key) ? propSchema : propSchema.optional();
  }
  return shape;
}

function jsonSchemaPropToZod(raw: unknown): z.ZodTypeAny {
  if (!raw || typeof raw !== "object") return z.unknown();
  const obj = raw as Record<string, unknown>;
  const description = typeof obj.description === "string" ? obj.description : undefined;
  const enumValues = Array.isArray(obj.enum) ? (obj.enum as unknown[]) : null;

  let base: z.ZodTypeAny;
  if (enumValues && enumValues.every((v) => typeof v === "string")) {
    base = z.enum(enumValues as [string, ...string[]]);
  } else {
    switch (obj.type) {
      case "string":
        base = z.string();
        break;
      case "number":
      case "integer":
        base = z.number();
        break;
      case "boolean":
        base = z.boolean();
        break;
      case "array": {
        const items = jsonSchemaPropToZod(obj.items);
        base = z.array(items);
        break;
      }
      case "object":
        base = z.object(jsonSchemaToZodShape(obj));
        break;
      default:
        base = z.unknown();
    }
  }

  return description ? base.describe(description) : base;
}

/**
 * Build a per-call context from environment-derived defaults. The MCP server
 * does not know a Paperclip project id, so it must not pretend to provide a
 * complete in-platform agent run context.
 */
function buildRunContext(client: PaperclipApiClient): { companyId?: string } {
  const companyId = client.defaults.companyId?.trim();
  return companyId ? { companyId } : {};
}

/**
 * Fetch the live plugin-tool registry and wrap each as an MCP `ToolDefinition`.
 * Failures are non-fatal: if the registry call errors, we log to stderr and
 * return an empty list so the MCP server still serves its built-in tools.
 */
export async function loadPluginToolDefinitions(
  client: PaperclipApiClient,
): Promise<ToolDefinition[]> {
  let tools: PluginToolDescriptor[];
  try {
    tools = await client.requestJson<PluginToolDescriptor[]>("GET", "/plugins/tools");
  } catch (error) {
    process.stderr.write(
      `[paperclip-mcp] failed to load plugin tools: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return [];
  }

  if (!Array.isArray(tools) || tools.length === 0) return [];

  return tools.map((tool) => buildPluginToolDefinition(tool, client));
}

function buildPluginToolDefinition(
  tool: PluginToolDescriptor,
  client: PaperclipApiClient,
): ToolDefinition {
  const shape = jsonSchemaToZodShape(tool.parametersSchema);
  const schema = z.object(shape);
  // MCP tool names must match `^[a-zA-Z0-9_.:-]+$`. Plugin tool names already
  // use `.` and `:` as namespacing separators (e.g. `acme.linear:search-issues`)
  // so they pass through unchanged.
  const description = tool.description?.trim()
    || tool.displayName?.trim()
    || `Plugin tool ${tool.name}`;

  return {
    name: tool.name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        const result = await client.requestJson<PluginToolExecuteResponse>(
          "POST",
          "/plugins/tools/execute",
          {
            body: {
              tool: tool.name,
              parameters: parsed,
              runContext: buildRunContext(client),
            },
            includeRunId: true,
          },
        );
        if (result?.ok === false) {
          return formatErrorResponse(
            new Error(result.error?.message ?? `Plugin tool ${tool.name} failed`),
          );
        }
        return formatTextResponse(result?.result ?? result);
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}
