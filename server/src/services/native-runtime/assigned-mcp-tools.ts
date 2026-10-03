import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { ToolGatewayHttpError, type ToolGatewayDescriptor, type ToolGatewayService } from "../tool-gateway.js";

type WorkMode = "standard" | "planning" | "ask";
type ToolDefinition = Record<string, unknown>;

const SEARCH_TOOL = "paperclip_search_assigned_tools";
const CALL_TOOL = "paperclip_call_assigned_tool";
// A single valid runner schema can be 512 KiB. Leave room for its description
// while keeping the complete result below the 768 KiB provider-result bound.
const SEARCH_PAGE_BYTES = 640 * 1024;
const SCHEMA_CHUNK_CHARACTERS = 64 * 1024;
const ON_DEMAND_TOOLS: ToolDefinition[] = [
  {
    name: SEARCH_TOOL,
    description: "Search your assigned app tools by name or description and read their input schemas. Use an empty query to browse. Pass nextOffset to fetch the next page. A large definition returns inputSchemaRef: set schemaTool to that name with an empty query, then pass nextSchemaOffset until null. Concatenate schemaJson chunks and parse JSON. Use paperclip_call_assigned_tool with a returned name and arguments matching its inputSchema.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 200 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        schemaTool: { type: "string", description: "Exact inputSchemaRef from a search result." },
        schemaOffset: { type: "integer", minimum: 0 },
      },
      required: ["query"],
    },
  },
  {
    name: CALL_TOOL,
    description: "Call an assigned app tool discovered with paperclip_search_assigned_tools. Use its exact returned name and arguments matching its inputSchema. The same permissions, approvals, and audit rules apply as for direct app tools.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } },
      required: ["name", "arguments"],
    },
  },
];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("assigned_mcp_tool_invalid_arguments");
  }
  return value as Record<string, unknown>;
}

function definition(name: string, tool: ToolGatewayDescriptor): ToolDefinition {
  return { name, description: `${tool.displayName}: ${tool.description}`, inputSchema: structuredClone(tool.parametersSchema) };
}

// Execution must use the app's configured gateway, including deployment
// restrictions, OAuth refresh, and approval delivery. Never fall back to an
// isolated gateway whose defaults differ from the running instance.
const assignedMcpGateways = new WeakMap<Db, ToolGatewayService>();

export function registerAssignedMcpGateway(db: Db, gateway: ToolGatewayService): void {
  assignedMcpGateways.set(db, gateway);
}

export function getAssignedMcpGateway(db: Db): ToolGatewayService {
  const gateway = assignedMcpGateways.get(db);
  if (!gateway) throw new Error("assigned_mcp_gateway_unavailable");
  return gateway;
}

function assignedToolName(name: string): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const separator = name.lastIndexOf(":");
  const readable = separator >= 0
    ? `${sanitize(name.slice(0, separator)).slice(0, 20) || "tool"}_${sanitize(name.slice(separator + 1)).slice(-26) || "action"}`
    : sanitize(name).slice(0, 47) || "tool";
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `app_${readable}_${digest}`;
}

/** Server-owned MCP bindings projected into the runner's existing tool channel. */
export async function createAssignedMcpTools(input: {
  gateway: ToolGatewayService;
  gatewayPublicId: string;
  bearerToken: string;
  workMode?: WorkMode;
}) {
  const listed = await input.gateway.listToolsForNamedGateway({
    gatewayPublicId: input.gatewayPublicId,
    bearerToken: input.bearerToken,
  });
  const tools = new Map<string, ToolGatewayDescriptor>();
  for (const descriptor of listed) {
    const name = assignedToolName(descriptor.name);
    if (tools.has(name)) throw new Error("assigned_mcp_tool_name_collision");
    tools.set(name, descriptor);
  }
  const permits = (tool: ToolGatewayDescriptor, mode: WorkMode = input.workMode ?? "standard") => mode === "standard" || tool.risk === "read";

  async function search(argumentsValue: unknown, currentWorkMode?: WorkMode) {
    const args = object(argumentsValue);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 5;
    const schemaOffset = args.schemaOffset ?? 0;
    if (typeof args.query !== "string" || args.query.length > 200 ||
      typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 ||
      typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
      (args.schemaTool !== undefined && typeof args.schemaTool !== "string") ||
      typeof schemaOffset !== "number" || !Number.isSafeInteger(schemaOffset) || schemaOffset < 0 ||
      (args.schemaOffset !== undefined && args.schemaTool === undefined)) {
      throw new Error("assigned_mcp_tool_invalid_arguments");
    }
    // Intersect fresh grants with this session's pinned catalog. Revocations
    // take effect immediately; newly assigned tools require a new session.
    const current = new Map((await input.gateway.listToolsForNamedGateway({
      gatewayPublicId: input.gatewayPublicId, bearerToken: input.bearerToken,
    })).map(tool => [tool.name, tool]));
    const terms = args.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const authorized = [...tools].filter(([, tool]) => {
      const fresh = current.get(tool.name);
      return fresh && permits(tool) && permits(tool, currentWorkMode) &&
        permits(fresh) && permits(fresh, currentWorkMode);
    });
    if (typeof args.schemaTool === "string") {
      const selected = authorized.find(([name]) => name === args.schemaTool);
      if (!selected) throw new Error("assigned_mcp_tool_unknown");
      const schema = JSON.stringify(selected[1].parametersSchema);
      const end = schemaOffset + SCHEMA_CHUNK_CHARACTERS;
      return {
        name: selected[0], schemaJson: schema.slice(schemaOffset, end),
        nextSchemaOffset: end < schema.length ? end : null,
      };
    }
    // Keep offsets anchored to the pinned catalog while fresh grants only
    // decide which entries are returned from that stable sequence.
    const authorizedNames = new Set(authorized.map(([name]) => name));
    const matches = [...tools].filter(([, tool]) => permits(tool)).filter(([name, tool]) =>
      terms.every(term => `${name} ${tool.displayName} ${tool.description}`.toLowerCase().includes(term)))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const page: ToolDefinition[] = [];
    let nextOffset = offset;
    while (nextOffset < matches.length && page.length < limit) {
      const [name, tool] = matches[nextOffset]!;
      if (!authorizedNames.has(name)) {
        nextOffset += 1;
        continue;
      }
      let next = definition(name, tool);
      if (Buffer.byteLength(JSON.stringify([next]), "utf8") > SEARCH_PAGE_BYTES) {
        // One large schema must not block browsing the tools after it. Expose
        // a reference whose schema can be fetched in bounded, reauthorized
        // chunks, without weakening the gateway's argument validation.
        next = { name, description: String(next.description).slice(0, 2000), inputSchemaRef: name };
      }
      if (Buffer.byteLength(JSON.stringify([...page, next]), "utf8") > SEARCH_PAGE_BYTES) {
        break;
      }
      page.push(next);
      nextOffset += 1;
    }
    return { tools: page, nextOffset: nextOffset < matches.length ? nextOffset : null };
  }

  return {
    definitions(fits?: (definitions: ToolDefinition[]) => boolean): ToolDefinition[] {
      const direct = [...tools].filter(([, tool]) => permits(tool)).map(([name, tool]) => definition(name, tool));
      if (!fits || fits(direct)) return direct;
      const compact = structuredClone(ON_DEMAND_TOOLS);
      if (!fits(compact)) throw new Error("assigned_mcp_tool_catalog_capacity_exceeded");
      return compact;
    },
    has(name: string): boolean {
      return tools.has(name) || name === SEARCH_TOOL || name === CALL_TOOL;
    },
    async execute(call: { tool: string; arguments: unknown }, currentWorkMode?: WorkMode): Promise<unknown> {
      if (call.tool === SEARCH_TOOL) return search(call.arguments, currentWorkMode);
      let name = call.tool;
      let parameters = call.arguments;
      if (name === CALL_TOOL) {
        const args = object(parameters);
        if (typeof args.name !== "string") throw new Error("assigned_mcp_tool_invalid_arguments");
        name = args.name;
        parameters = object(args.arguments);
      }
      const descriptor = tools.get(name);
      if (!descriptor) throw new Error("assigned_mcp_tool_unknown");
      if (!permits(descriptor) || !permits(descriptor, currentWorkMode)) throw new Error("paperclip_runner_tool_mode_denied");
      // Reauthorize through the existing gateway on every call. Discovery is
      // not a grant: revocation, policy, approval, and audit remain server-owned.
      const result = await input.gateway.executeTool({
        gatewayPublicId: input.gatewayPublicId,
        sessionToken: input.bearerToken,
        tool: descriptor.name,
        parameters,
      });
      if (result.status !== "completed" && result.status !== "replayed") {
        throw new Error("assigned_mcp_tool_execution_incomplete");
      }
      // The gateway normally throws provider errors. Keep a malformed or older
      // provider response from being reported as successful through PRP.
      if (result.result && typeof result.result === "object" && "isError" in result.result && result.result.isError === true) {
        throw new ToolGatewayHttpError(502, "The assigned tool returned an error.", "tool_error");
      }
      return result.result;
    },
  };
}
