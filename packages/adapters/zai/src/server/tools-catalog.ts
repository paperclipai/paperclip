import { zodToJsonSchema } from "zod-to-json-schema";
import {
  PaperclipApiClient,
  createToolDefinitions,
  type PaperclipMcpConfig,
  type ToolDefinition,
} from "@paperclipai/mcp-server";
import type { ZaiToolDefinition } from "../shared/types.js";

export interface PaperclipToolsCatalog {
  /** OpenAI-format tool definitions to send to Z.AI in the chat completion request. */
  zaiToolDefinitions: ZaiToolDefinition[];
  /** Lookup table from tool name to its MCP definition (with schema + execute). */
  toolsByName: Map<string, ToolDefinition>;
  /** The api client wired with the runtime config (used by tool.execute()). */
  apiClient: PaperclipApiClient;
}

export interface BuildToolsCatalogInput {
  apiUrl: string;
  agentJwt: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
  /** Optional name allow-list. When non-empty, only tools whose name is in the set are exposed. */
  allowedToolNames?: ReadonlySet<string>;
  /** Optional name deny-list. Applied after the allow-list. */
  deniedToolNames?: ReadonlySet<string>;
}

function toolToOpenAiDefinition(tool: ToolDefinition): ZaiToolDefinition {
  // zod-to-json-schema produces a JSON Schema; OpenAI/Z.AI accept JSON Schema
  // for the tool parameters. We strip the wrapping `$schema` and `$ref` because
  // OpenAI clients sometimes choke on them.
  const raw = zodToJsonSchema(tool.schema, { target: "openApi3" }) as Record<string, unknown>;
  delete raw.$schema;
  if (typeof raw.$ref === "string") {
    // openApi3 target sometimes wraps as { $ref: "#/...", definitions: { ... } } —
    // collapse to the inlined definition when present.
    const definitions = raw.definitions as Record<string, unknown> | undefined;
    if (definitions) {
      const refKey = (raw.$ref as string).split("/").pop();
      const inlined = refKey ? (definitions[refKey] as Record<string, unknown> | undefined) : undefined;
      if (inlined) {
        delete raw.$ref;
        delete raw.definitions;
        for (const [k, v] of Object.entries(inlined)) raw[k] = v;
      }
    }
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: raw,
    },
  };
}

/**
 * Build the Paperclip tool catalog for the Z.AI adapter:
 *  - The agent JWT (ctx.authToken) authenticates calls back to the Paperclip API.
 *  - The MCP server's tool definitions are reused verbatim so Z.AI sees the
 *    exact same surface that claude_local / codex_local agents see.
 */
export function buildPaperclipToolsCatalog(input: BuildToolsCatalogInput): PaperclipToolsCatalog {
  const config: PaperclipMcpConfig = {
    apiUrl: input.apiUrl,
    apiKey: input.agentJwt,
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
  };
  const apiClient = new PaperclipApiClient(config);
  const all = createToolDefinitions(apiClient);

  const allowedSet = input.allowedToolNames && input.allowedToolNames.size > 0 ? input.allowedToolNames : null;
  const deniedSet = input.deniedToolNames && input.deniedToolNames.size > 0 ? input.deniedToolNames : null;

  const filtered = all.filter((tool) => {
    if (allowedSet && !allowedSet.has(tool.name)) return false;
    if (deniedSet && deniedSet.has(tool.name)) return false;
    return true;
  });

  const toolsByName = new Map<string, ToolDefinition>();
  for (const tool of filtered) toolsByName.set(tool.name, tool);

  const zaiToolDefinitions = filtered.map(toolToOpenAiDefinition);

  return { zaiToolDefinitions, toolsByName, apiClient };
}
