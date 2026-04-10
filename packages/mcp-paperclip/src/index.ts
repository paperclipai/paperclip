/**
 * @lucitra/mcp-paperclip
 *
 * Stdio MCP server that exposes every plugin-contributed tool in a running
 * Paperclip host as a native MCP tool. Bridges to the host's REST API:
 *
 *   GET  /api/plugins/tools            → tool catalog
 *   POST /api/plugins/tools/execute    → tool dispatch
 *
 * Environment:
 *   PAPERCLIP_API_URL   required, e.g. http://localhost:3100
 *   PAPERCLIP_API_KEY   required, agent JWT or board token (bearer)
 *
 * Tool naming: Paperclip plugin tools are namespaced with a colon
 * (e.g. `paperclip-plugin-kalshi:kalshi-portfolio-balance`). MCP tool names
 * may not contain colons in all clients, so we convert colons → double
 * underscores on the way out, and back on the way in.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface PluginToolDescriptor {
  name: string;
  displayName?: string;
  description?: string;
  parametersSchema?: Record<string, unknown>;
  pluginId?: string;
}

interface PluginToolExecuteResult {
  content?: string;
  data?: unknown;
  error?: string;
}

const MCP_SERVER_NAME = "lucitra-paperclip";
const MCP_SERVER_VERSION = "0.1.0";

// MCP clients vary on whether ":" is allowed in tool names. Normalize.
const PLUGIN_SEP = ":";
const MCP_SEP = "__";
const toMcpName = (pluginToolName: string) =>
  pluginToolName.replaceAll(PLUGIN_SEP, MCP_SEP);
const fromMcpName = (mcpName: string) =>
  mcpName.replaceAll(MCP_SEP, PLUGIN_SEP);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[mcp-paperclip] FATAL: ${name} is not set`);
    process.exit(1);
  }
  return v;
}

function authHeaders(apiKey: string | null): Record<string, string> {
  // Accept both raw JWTs and already-prefixed "Bearer ..." tokens.
  // When no key is set, return empty headers — the host accepts board-implicit
  // auth on localhost in local_trusted mode.
  if (!apiKey) return {};
  const value = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
  return { Authorization: value };
}

async function listPluginTools(
  apiUrl: string,
  apiKey: string | null,
): Promise<PluginToolDescriptor[]> {
  const res = await fetch(`${apiUrl}/api/plugins/tools`, {
    headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[mcp-paperclip] list tools failed (${res.status}): ${body.slice(0, 500)}`,
    );
  }
  return (await res.json()) as PluginToolDescriptor[];
}

async function executePluginTool(
  apiUrl: string,
  apiKey: string | null,
  pluginToolName: string,
  parameters: unknown,
): Promise<PluginToolExecuteResult> {
  // runContext is filled in server-side from the JWT for agent callers,
  // but we still include a shape the host will accept if we're on a board
  // token. The host overrides agentId/runId/companyId from the actor.
  const res = await fetch(`${apiUrl}/api/plugins/tools/execute`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({
      tool: pluginToolName,
      parameters: parameters ?? {},
      runContext: {
        agentId: process.env.PAPERCLIP_AGENT_ID ?? "mcp-paperclip",
        runId: process.env.PAPERCLIP_RUN_ID ?? "mcp-paperclip",
        companyId: process.env.PAPERCLIP_COMPANY_ID ?? "mcp-paperclip",
        projectId: process.env.PAPERCLIP_PROJECT_ID ?? "",
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) {
    return { error: `HTTP ${res.status}: ${text.slice(0, 2000)}` };
  }
  try {
    const parsed = JSON.parse(text) as {
      result?: PluginToolExecuteResult;
    } & PluginToolExecuteResult;
    // Some routes wrap result, some don't — handle both shapes.
    return parsed.result ?? parsed;
  } catch {
    return { content: text };
  }
}

function toJsonSchemaObject(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (schema && typeof schema === "object" && schema.type === "object") {
    return schema;
  }
  return { type: "object", properties: {} };
}

// ---------------------------------------------------------------------------
// Core Paperclip tools — thin wrappers over the host REST API.
// These are NOT plugin tools — they're the first-party agent / issue / project
// endpoints that every Paperclip host exposes. Exposing them as native MCP
// tools means chat (and any MCP client) can do agent orchestration without
// reasoning about URL shapes.
// ---------------------------------------------------------------------------

type CoreMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface CoreToolSpec {
  /** Tool name as shown to the LLM (without the mcp__paperclip__ prefix). */
  name: string;
  description: string;
  /** Parameter schema — the LLM fills these. */
  params: Record<string, { type: string; description: string; required?: boolean }>;
  /** HTTP method. */
  method: CoreMethod;
  /** Path template with {param} placeholders filled from args. */
  pathTemplate: string;
  /** Param names that flow into the URL path (removed from body/query). */
  pathParams?: string[];
  /** Param names that flow into the query string (only used for GET). */
  queryParams?: string[];
  /** Param names that flow into the JSON body (POST/PATCH). */
  bodyParams?: string[];
}

const CORE_TOOLS: CoreToolSpec[] = [
  {
    name: "paperclip-list-companies",
    description: "List all companies in this Paperclip instance.",
    params: {},
    method: "GET",
    pathTemplate: "/api/companies",
  },
  {
    name: "paperclip-list-agents",
    description:
      "List all agents in a company. Returns id, name, title, role, status, reports-to, and adapterType for each.",
    params: {
      companyId: { type: "string", description: "Company UUID", required: true },
    },
    method: "GET",
    pathTemplate: "/api/companies/{companyId}/agents",
    pathParams: ["companyId"],
  },
  {
    name: "paperclip-get-agent",
    description: "Fetch a single agent by UUID.",
    params: {
      id: { type: "string", description: "Agent UUID", required: true },
    },
    method: "GET",
    pathTemplate: "/api/agents/{id}",
    pathParams: ["id"],
  },
  {
    name: "paperclip-list-issues",
    description:
      "List issues in a company, optionally filtered by status, assignee agent, or project.",
    params: {
      companyId: { type: "string", description: "Company UUID", required: true },
      status: {
        type: "string",
        description: "Filter by status: todo | in_progress | in_review | done | cancelled | blocked",
      },
      assigneeAgentId: { type: "string", description: "Filter by assignee agent UUID" },
      projectId: { type: "string", description: "Filter by project UUID" },
      limit: { type: "number", description: "Max rows (default 50, cap 200)" },
    },
    method: "GET",
    pathTemplate: "/api/companies/{companyId}/issues",
    pathParams: ["companyId"],
    queryParams: ["status", "assigneeAgentId", "projectId", "limit"],
  },
  {
    name: "paperclip-get-issue",
    description: "Fetch a single issue by UUID or identifier (e.g. LUC-123).",
    params: {
      id: { type: "string", description: "Issue UUID or identifier", required: true },
    },
    method: "GET",
    pathTemplate: "/api/issues/{id}",
    pathParams: ["id"],
  },
  {
    name: "paperclip-create-issue",
    description: "Create a new issue in a company.",
    params: {
      companyId: { type: "string", description: "Company UUID", required: true },
      title: { type: "string", description: "Issue title", required: true },
      description: { type: "string", description: "Issue description (markdown)" },
      status: { type: "string", description: "Initial status (default: todo)" },
      priority: { type: "string", description: "critical | high | medium | low" },
      assigneeAgentId: { type: "string", description: "Assignee agent UUID" },
      projectId: { type: "string", description: "Project UUID" },
      parentId: { type: "string", description: "Parent issue UUID for sub-issues" },
    },
    method: "POST",
    pathTemplate: "/api/companies/{companyId}/issues",
    pathParams: ["companyId"],
    bodyParams: [
      "title",
      "description",
      "status",
      "priority",
      "assigneeAgentId",
      "projectId",
      "parentId",
    ],
  },
  {
    name: "paperclip-update-issue",
    description:
      "Update an existing issue. Pass only the fields you want to change.",
    params: {
      id: { type: "string", description: "Issue UUID", required: true },
      title: { type: "string", description: "New title" },
      description: { type: "string", description: "New description" },
      status: { type: "string", description: "New status" },
      priority: { type: "string", description: "New priority" },
      assigneeAgentId: { type: "string", description: "New assignee agent UUID" },
    },
    method: "PATCH",
    pathTemplate: "/api/issues/{id}",
    pathParams: ["id"],
    bodyParams: ["title", "description", "status", "priority", "assigneeAgentId"],
  },
  {
    name: "paperclip-list-projects",
    description: "List projects in a company.",
    params: {
      companyId: { type: "string", description: "Company UUID", required: true },
    },
    method: "GET",
    pathTemplate: "/api/companies/{companyId}/projects",
    pathParams: ["companyId"],
  },
  // NOTE: paperclip-spawn-agent was removed. Agent creation is a board
  // decision and must go through the UI hire-agent approval flow. Chat
  // can still *propose* a new agent by describing it to the user; the
  // user then spawns it manually from Settings → Agents → New Agent.
  {
    name: "paperclip-ask-board",
    description:
      "Ask the board (the human user) a question or request approval for a non-tool-use decision. Use this when you need clarification, a strategic decision, or authorization that can't be expressed as a single tool call. The request lands in the same approvals inbox the board already reviews (alongside tool_use, hire_agent, and budget approvals). Wait for the response before continuing work. Examples: 'Should we proceed with the v2 migration?', 'Approve this refactor plan?', 'Which approach should I take: A or B?'.",
    params: {
      companyId: { type: "string", description: "Company UUID", required: true },
      title: {
        type: "string",
        description: "Short title for the board to see in the inbox (e.g. 'Approve v2 migration plan')",
        required: true,
      },
      question: {
        type: "string",
        description: "The full question or proposal in markdown. Include context, options, and what you need decided.",
        required: true,
      },
      nextStepsIfApproved: {
        type: "string",
        description: "What you will do if the board approves — helps them evaluate the request.",
      },
      nextStepsIfRejected: {
        type: "string",
        description: "What you will do if the board rejects — usually 'hold and wait for guidance'.",
      },
      issueIds: {
        type: "string",
        description:
          "Comma-separated Paperclip issue UUIDs to link this approval to. The board will see the linked issues alongside the approval.",
      },
    },
    method: "POST",
    pathTemplate: "/api/companies/{companyId}/approvals",
    pathParams: ["companyId"],
    // Custom body shape — approvals use a typed payload wrapper. We
    // remap the flat params to the nested shape in a pre-dispatch hook
    // (see executeCoreTool for the `ask-board` special case).
    bodyParams: ["title", "question", "nextStepsIfApproved", "nextStepsIfRejected", "issueIds"],
  },
  {
    name: "paperclip-list-issue-comments",
    description: "List comments on an issue.",
    params: {
      id: { type: "string", description: "Issue UUID", required: true },
    },
    method: "GET",
    pathTemplate: "/api/issues/{id}/comments",
    pathParams: ["id"],
  },
  {
    name: "paperclip-add-issue-comment",
    description: "Add a comment to an issue.",
    params: {
      id: { type: "string", description: "Issue UUID", required: true },
      body: { type: "string", description: "Comment body (markdown)", required: true },
    },
    method: "POST",
    pathTemplate: "/api/issues/{id}/comments",
    pathParams: ["id"],
    bodyParams: ["body"],
  },
];

function coreSpecToMcpTool(spec: CoreToolSpec) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, v] of Object.entries(spec.params)) {
    properties[k] = { type: v.type, description: v.description };
    if (v.required) required.push(k);
  }
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: "object" as const,
      properties,
      ...(required.length ? { required } : {}),
    },
  };
}

async function executeCoreTool(
  apiUrl: string,
  apiKey: string | null,
  spec: CoreToolSpec,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; text: string }> {
  // Fill path template
  let path = spec.pathTemplate;
  for (const p of spec.pathParams ?? []) {
    const v = args[p];
    if (v === undefined || v === null || v === "") {
      return { ok: false, text: `Missing required path param "${p}"` };
    }
    path = path.replace(`{${p}}`, encodeURIComponent(String(v)));
  }

  // Query params
  if (spec.queryParams?.length && spec.method === "GET") {
    const usp = new URLSearchParams();
    for (const q of spec.queryParams) {
      const v = args[q];
      if (v !== undefined && v !== null && v !== "") {
        usp.set(q, String(v));
      }
    }
    if (usp.toString()) path += `?${usp.toString()}`;
  }

  // Body
  let body: string | undefined;
  if (spec.method !== "GET" && spec.bodyParams?.length) {
    const payload: Record<string, unknown> = {};
    for (const b of spec.bodyParams) {
      if (args[b] !== undefined) payload[b] = args[b];
    }
    // Special-case: paperclip-ask-board remaps flat fields onto the
    // approvals plugin's nested payload shape.
    if (spec.name === "paperclip-ask-board") {
      const issueIdsRaw = args.issueIds;
      const issueIds =
        typeof issueIdsRaw === "string"
          ? issueIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : Array.isArray(issueIdsRaw)
            ? (issueIdsRaw as unknown[]).filter((x): x is string => typeof x === "string")
            : undefined;
      body = JSON.stringify({
        type: "approve_ceo_strategy",
        payload: {
          title: args.title,
          question: args.question,
          plan: args.question, // alias so the existing CeoStrategyPayload renderer shows the body
          nextStepsIfApproved: args.nextStepsIfApproved,
          nextStepsIfRejected: args.nextStepsIfRejected,
          requestedAt: new Date().toISOString(),
        },
        ...(issueIds && issueIds.length > 0 ? { issueIds } : {}),
      });
    } else {
      body = JSON.stringify(payload);
    }
  }

  try {
    const res = await fetch(`${apiUrl}${path}`, {
      method: spec.method,
      headers: {
        ...authHeaders(apiKey),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, text: `HTTP ${res.status}: ${text.slice(0, 2000)}` };
    }
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      text: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const apiUrl = requireEnv("PAPERCLIP_API_URL").replace(/\/$/, "");
  // API key is optional on localhost — the host accepts board-implicit auth
  // in local_trusted mode when no Authorization header is present.
  const apiKey = process.env.PAPERCLIP_API_KEY ?? null;

  // Fetch the catalog once at startup. If the host adds/removes plugins
  // mid-session, the MCP client will only see them on the next session —
  // which matches how MCP clients like Claude CLI discover tools anyway.
  let tools: PluginToolDescriptor[] = [];
  try {
    tools = await listPluginTools(apiUrl, apiKey);
  } catch (err) {
    console.error(String(err));
    // Fail soft — still start the server so the client gets a clear "no tools"
    // rather than a hard crash.
  }

  console.error(
    `[mcp-paperclip] Loaded ${tools.length} plugin tool(s) + ${CORE_TOOLS.length} core tool(s) from ${apiUrl}`,
  );

  // Build a fast lookup for core tools (by their MCP name).
  const coreByName = new Map(CORE_TOOLS.map((t) => [t.name, t]));

  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // Core first — they're the most frequently used for orchestration.
      ...CORE_TOOLS.map(coreSpecToMcpTool),
      // Then dynamic plugin-contributed tools.
      ...tools.map((t) => ({
        name: toMcpName(t.name),
        description:
          (t.description || t.displayName || t.name).slice(0, 1024),
        inputSchema: toJsonSchemaObject(t.parametersSchema),
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const mcpName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // Core tool path — hardcoded, thin wrappers over the REST API.
    const coreSpec = coreByName.get(mcpName);
    if (coreSpec) {
      const result = await executeCoreTool(apiUrl, apiKey, coreSpec, args);
      if (!result.ok) {
        return { isError: true, content: [{ type: "text", text: result.text }] };
      }
      // Try to pretty-print JSON responses, fall back to raw text.
      let text = result.text;
      try {
        text = JSON.stringify(JSON.parse(result.text), null, 2);
      } catch {
        /* not JSON — keep raw */
      }
      return { content: [{ type: "text", text }] };
    }

    // Plugin tool path — dynamic dispatch via /api/plugins/tools/execute.
    const pluginToolName = fromMcpName(mcpName);
    const result = await executePluginTool(apiUrl, apiKey, pluginToolName, args);

    if (result.error) {
      return {
        isError: true,
        content: [{ type: "text", text: result.error }],
      };
    }

    const text =
      result.data !== undefined
        ? JSON.stringify(result.data, null, 2)
        : (result.content ?? "(no output)");

    return { content: [{ type: "text", text }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[mcp-paperclip] running on stdio");
}

main().catch((err) => {
  console.error(`[mcp-paperclip] FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
