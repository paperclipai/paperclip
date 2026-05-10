import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginHealthDiagnostics,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, TOOL_NAMES, type OpenCrabToolKey } from "./constants.js";
import manifest from "./manifest.js";

type OpenCrabConfig = {
  endpoint?: string;
  endpointRef?: string;
  workspaceId?: string;
  defaultLimit?: number;
  maxLimit?: number;
  ingestEnabled?: boolean;
};

type OpenCrabRequest = {
  name: string;
  arguments: Record<string, unknown>;
};

type OpenCrabCaller = (ctx: PluginContext, request: OpenCrabRequest) => Promise<unknown>;

let currentContext: PluginContext | null = null;
let openCrabCaller: OpenCrabCaller = defaultOpenCrabCaller;

export function setOpenCrabCallerForTests(caller: OpenCrabCaller): void {
  openCrabCaller = caller;
}

export function resetOpenCrabCallerForTests(): void {
  openCrabCaller = defaultOpenCrabCaller;
}

export function redactOpenCrabEndpoint(endpoint: string | undefined): string {
  if (!endpoint) return "[not-configured]";
  try {
    const url = new URL(endpoint);
    if (url.pathname.includes("/api/mcp/")) return `${url.origin}/api/mcp/[REDACTED]`;
  } catch {
    return "[REDACTED]";
  }
  return "[REDACTED]";
}

function clampLimit(value: unknown, fallback = 10, max = 50): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function getConfig(ctx: PluginContext): Promise<OpenCrabConfig> {
  const config = await ctx.config.get();
  return asRecord(config) as OpenCrabConfig;
}

async function resolveEndpoint(ctx: PluginContext): Promise<string> {
  const config = await getConfig(ctx);
  if (typeof config.endpoint === "string" && config.endpoint.trim()) return config.endpoint;
  if (typeof config.endpointRef === "string" && config.endpointRef.trim()) {
    const resolved = await ctx.secrets.resolve(config.endpointRef);
    if (typeof resolved === "string" && resolved.trim()) return resolved;
  }
  throw new Error("OpenCrab endpoint is not configured");
}

async function defaultOpenCrabCaller(ctx: PluginContext, request: OpenCrabRequest): Promise<unknown> {
  const endpoint = await resolveEndpoint(ctx);
  const response = await ctx.http.fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: request,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenCrab HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
}

function normalizeToolResult(toolName: string, data: unknown): ToolResult {
  return {
    content: `OpenCrab ${toolName} completed.`,
    data,
  };
}

function buildArguments(toolName: OpenCrabToolKey, params: Record<string, unknown>, config: OpenCrabConfig): Record<string, unknown> {
  const maxLimit = clampLimit(config.maxLimit, 50, 50);
  const defaultLimit = clampLimit(config.defaultLimit, 10, maxLimit);
  const workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : config.workspaceId;

  if (toolName === TOOL_NAMES.status) return {};

  if (toolName === TOOL_NAMES.query) {
    return {
      query: String(params.query ?? ""),
      top_k: clampLimit(params.topK, defaultLimit, maxLimit),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    };
  }

  if (toolName === TOOL_NAMES.searchDocuments) {
    return {
      query: String(params.query ?? ""),
      limit: clampLimit(params.limit, defaultLimit, maxLimit),
      ...(typeof params.sourceType === "string" ? { source_type: params.sourceType } : {}),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    };
  }

  if (toolName === TOOL_NAMES.searchNodes) {
    return {
      query: String(params.query ?? ""),
      limit: clampLimit(params.limit, defaultLimit, maxLimit),
      ...(typeof params.nodeType === "string" ? { node_type: params.nodeType } : {}),
      ...(typeof params.sourceType === "string" ? { source_type: params.sourceType } : {}),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    };
  }

  if (toolName === TOOL_NAMES.getNodeContext) {
    return {
      node_id: String(params.nodeId ?? ""),
      limit: clampLimit(params.limit, defaultLimit, maxLimit),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    };
  }

  return {
    ...(typeof params.query === "string" ? { query: params.query } : {}),
    ...(typeof params.category === "string" ? { category: params.category } : {}),
    ...(typeof params.licenseScope === "string" ? { license_scope: params.licenseScope } : {}),
    limit: clampLimit(params.limit, defaultLimit, maxLimit),
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
  };
}

function registerTool(ctx: PluginContext, toolName: OpenCrabToolKey, openCrabName: string): void {
  const declaration = manifest.tools?.find((tool) => tool.name === toolName);
  if (!declaration) throw new Error(`Missing manifest tool declaration for ${toolName}`);
  ctx.tools.register(
    toolName,
    {
      displayName: declaration.displayName,
      description: declaration.description,
      parametersSchema: declaration.parametersSchema,
    },
    async (params): Promise<ToolResult> => {
      try {
        const config = await getConfig(ctx);
        const result = await openCrabCaller(ctx, {
          name: openCrabName,
          arguments: buildArguments(toolName, asRecord(params), config),
        });
        return normalizeToolResult(openCrabName, result);
      } catch (error) {
        const config = await getConfig(ctx).catch(() => ({}));
        const message = error instanceof Error ? error.message : String(error);
        const safeEndpoint = redactOpenCrabEndpoint((config as OpenCrabConfig).endpoint);
        return {
          error: `${message.replace(/https:\/\/opencrab\.sh\/api\/mcp\/[^\s"')]+/g, safeEndpoint)}`,
        };
      }
    },
  );
}

function registerToolHandlers(ctx: PluginContext): void {
  registerTool(ctx, TOOL_NAMES.status, "opencrab_status");
  registerTool(ctx, TOOL_NAMES.query, "opencrab_query");
  registerTool(ctx, TOOL_NAMES.searchDocuments, "opencrab_search_documents");
  registerTool(ctx, TOOL_NAMES.searchNodes, "opencrab_search_nodes");
  registerTool(ctx, TOOL_NAMES.getNodeContext, "opencrab_get_node_context");
  registerTool(ctx, TOOL_NAMES.searchPacks, "opencrab_search_packs");
}

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    registerToolHandlers(ctx);
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const config: OpenCrabConfig = currentContext ? await getConfig(currentContext).catch(() => ({})) : {};
    return {
      status: "ok",
      message: "OpenCrab ontology tools registered",
      details: {
        pluginId: PLUGIN_ID,
        endpoint: redactOpenCrabEndpoint(config.endpoint),
        tools: Object.values(TOOL_NAMES),
        ingestEnabled: config.ingestEnabled === true,
      },
    };
  },
});

export default plugin;

runWorker(plugin, import.meta.url);
