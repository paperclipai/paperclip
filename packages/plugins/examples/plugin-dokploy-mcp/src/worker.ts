import {
  definePlugin,
  runWorker,
  type PaperclipPlugin,
  type PluginContext,
  type PluginConfigValidationResult,
  type PluginHealthDiagnostics,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, PLUGIN_ID, TOOL_NAMES } from "./constants.js";

type DokployConfig = {
  dokployMcpUrl?: string;
};

let _jsonRpcId = 0;
function nextId() {
  return ++_jsonRpcId;
}

function extractText(result: { content?: Array<{ text?: string }> } | undefined | null): string {
  return (
    result?.content
      ?.map((c) => c.text ?? "")
      .join("\n")
      .trim() ?? ""
  );
}

async function getConfig(ctx: PluginContext): Promise<DokployConfig> {
  const config = await ctx.config.get();
  return { ...DEFAULT_CONFIG, ...(config as DokployConfig) };
}

async function callMcpTool(ctx: PluginContext, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const config = await getConfig(ctx);
  const url = config.dokployMcpUrl;

  if (!url) {
    throw new Error("Dokploy MCP URL is not configured. Set it in the plugin settings.");
  }

  const body = {
    jsonrpc: "2.0",
    id: nextId(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  const res = await ctx.http.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    throw new Error(`Dokploy MCP returned HTTP ${res.status}: ${text}`);
  }

  const json = (await res.json()) as {
    result?: { content?: Array<{ text?: string }> };
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw new Error(`Dokploy MCP error: ${json.error.message}`);
  }

  return json.result;
}

function registerTools(ctx: PluginContext): void {
  // dokploy-get-logs
  ctx.tools.register(
    TOOL_NAMES.getLogs,
    {
      displayName: "Dokploy: Get Application Logs",
      description: "Retrieve container logs for a Dokploy application by its application ID.",
      parametersSchema: {
        type: "object",
        properties: {
          applicationId: {
            type: "string",
            description: "The Dokploy application ID.",
          },
        },
        required: ["applicationId"],
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      const { applicationId } = params as { applicationId: string };
      if (!applicationId) return { error: "applicationId is required" };

      const result = await callMcpTool(ctx, "get-application-logs", {
        applicationId,
      });

      const logs = extractText(result as { content?: Array<{ text?: string }> });

      await ctx.activity.log({
        companyId: runCtx.companyId,
        message: `Retrieved logs for application ${applicationId}`,
        metadata: { tool: TOOL_NAMES.getLogs, applicationId },
      });

      return {
        content: logs || "(no logs returned)",
        data: { applicationId, logsLength: logs.length },
      };
    },
  );

  // dokploy-list-applications
  ctx.tools.register(
    TOOL_NAMES.listApplications,
    {
      displayName: "Dokploy: List Applications",
      description: "List all applications managed by Dokploy.",
      parametersSchema: { type: "object", properties: {} },
    },
    async (_params, runCtx): Promise<ToolResult> => {
      const result = await callMcpTool(ctx, "list-applications", {});
      const text = extractText(result as { content?: Array<{ text?: string }> });

      await ctx.activity.log({
        companyId: runCtx.companyId,
        message: "Listed all Dokploy applications",
        metadata: { tool: TOOL_NAMES.listApplications },
      });

      return { content: text || "(no applications found)", data: { raw: text } };
    },
  );

  // dokploy-get-application-status
  ctx.tools.register(
    TOOL_NAMES.getApplicationStatus,
    {
      displayName: "Dokploy: Get Application Status",
      description: "Get the current deployment status of a Dokploy application.",
      parametersSchema: {
        type: "object",
        properties: {
          applicationId: {
            type: "string",
            description: "The Dokploy application ID.",
          },
        },
        required: ["applicationId"],
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      const { applicationId } = params as { applicationId: string };
      if (!applicationId) return { error: "applicationId is required" };

      const result = await callMcpTool(ctx, "get-application-status", {
        applicationId,
      });

      const text = extractText(result as { content?: Array<{ text?: string }> });

      await ctx.activity.log({
        companyId: runCtx.companyId,
        message: `Checked status of application ${applicationId}`,
        metadata: { tool: TOOL_NAMES.getApplicationStatus, applicationId },
      });

      return {
        content: text || "(no status returned)",
        data: { applicationId },
      };
    },
  );

  // dokploy-redeploy
  ctx.tools.register(
    TOOL_NAMES.redeploy,
    {
      displayName: "Dokploy: Redeploy Application",
      description: "Trigger a redeployment of a Dokploy application. This is a mutating action.",
      parametersSchema: {
        type: "object",
        properties: {
          applicationId: {
            type: "string",
            description: "The Dokploy application ID to redeploy.",
          },
        },
        required: ["applicationId"],
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      const { applicationId } = params as { applicationId: string };
      if (!applicationId) return { error: "applicationId is required" };

      const result = await callMcpTool(ctx, "redeploy-application", {
        applicationId,
      });

      const text = extractText(result as { content?: Array<{ text?: string }> });

      await ctx.activity.log({
        companyId: runCtx.companyId,
        message: `Triggered redeployment of application ${applicationId}`,
        metadata: {
          tool: TOOL_NAMES.redeploy,
          applicationId,
          action: "redeploy",
        },
      });

      return {
        content: text || `Redeployment triggered for ${applicationId}`,
        data: { applicationId, action: "redeploy" },
      };
    },
  );

  // dokploy-get-application-stats
  ctx.tools.register(
    TOOL_NAMES.getApplicationStats,
    {
      displayName: "Dokploy: Get Application Stats",
      description: "Get resource usage statistics (CPU, memory, etc.) for a Dokploy application.",
      parametersSchema: {
        type: "object",
        properties: {
          applicationId: {
            type: "string",
            description: "The Dokploy application ID.",
          },
        },
        required: ["applicationId"],
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      const { applicationId } = params as { applicationId: string };
      if (!applicationId) return { error: "applicationId is required" };

      const result = await callMcpTool(ctx, "get-application-stats", {
        applicationId,
      });

      const text = extractText(result as { content?: Array<{ text?: string }> });

      await ctx.activity.log({
        companyId: runCtx.companyId,
        message: `Retrieved stats for application ${applicationId}`,
        metadata: { tool: TOOL_NAMES.getApplicationStats, applicationId },
      });

      return {
        content: text || "(no stats returned)",
        data: { applicationId },
      };
    },
  );
}

const plugin: PaperclipPlugin = definePlugin({
  async setup(ctx: PluginContext) {
    registerTools(ctx);
    ctx.logger.info("Dokploy MCP plugin initialized");
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok", message: "Dokploy MCP plugin ready" };
  },

  async onConfigChanged(newConfig: Record<string, unknown>): Promise<void> {
    // Config is read on each tool call, no caching needed
  },

  async onValidateConfig(config: Record<string, unknown>): Promise<PluginConfigValidationResult> {
    const url = config.dokployMcpUrl as string | undefined;
    if (url && typeof url === "string") {
      try {
        new URL(url);
      } catch {
        return {
          ok: false,
          errors: ["dokployMcpUrl: Must be a valid URL"],
        };
      }
    }
    return { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
