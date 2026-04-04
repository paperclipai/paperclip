import { definePlugin, runWorker, type PluginContext, type ToolResult, type ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  PLUGIN_ID,
  PLUGIN_VERSION,
  TOOL_NAMES,
} from "./constants.js";
import { callDarwinTool } from "./darwin-mcp-client.js";
import {
  buildDarwinEnv,
  getDarwinServerCommand,
  getSharedNamespace,
  getTimeoutMs,
  parseDarwinServerArgs,
  resolvePolicy,
} from "./policy.js";
import type { DarwinBridgeConfig, DarwinStoreParams } from "./types.js";

type DarwinInvoker = typeof callDarwinTool;

let darwinInvoker: DarwinInvoker = callDarwinTool;

export function __setDarwinInvokerForTests(invoker: DarwinInvoker): void {
  darwinInvoker = invoker;
}

async function getConfig(ctx: PluginContext): Promise<DarwinBridgeConfig> {
  return await ctx.config.get() as DarwinBridgeConfig;
}

async function resolveSecrets(ctx: PluginContext, config: DarwinBridgeConfig): Promise<{ upstashUrl?: string; upstashToken?: string }> {
  const secrets: { upstashUrl?: string; upstashToken?: string } = {};
  if (typeof config.upstashUrlSecretRef === "string" && config.upstashUrlSecretRef.trim() !== "") {
    secrets.upstashUrl = await ctx.secrets.resolve(config.upstashUrlSecretRef);
  }
  if (typeof config.upstashTokenSecretRef === "string" && config.upstashTokenSecretRef.trim() !== "") {
    secrets.upstashToken = await ctx.secrets.resolve(config.upstashTokenSecretRef);
  }
  return secrets;
}

async function invokeDarwin(
  ctx: PluginContext,
  config: DarwinBridgeConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const secrets = await resolveSecrets(ctx, config);
  const result = await darwinInvoker(
    {
      command: getDarwinServerCommand(config),
      args: parseDarwinServerArgs(config),
      env: buildDarwinEnv(config, secrets),
      timeoutMs: getTimeoutMs(config),
    },
    toolName,
    args,
  );

  const content = result.content
    ?.map((entry) => (typeof entry.text === "string" ? entry.text : ""))
    .filter((entry) => entry !== "")
    .join("\n\n");

  return result.isError
    ? { error: content || "Darwin MCP returned an error", data: result }
    : { content: content || "Darwin call completed", data: result };
}

function ensurePolicy(config: DarwinBridgeConfig, runCtx: ToolRunContext) {
  const policy = resolvePolicy(config, runCtx);
  if (!policy) {
    throw new Error("No Darwin namespace policy configured for this company or agent");
  }
  return policy;
}

async function registerToolHandlers(ctx: PluginContext): Promise<void> {
  ctx.tools.register(
    TOOL_NAMES.search,
    {
      displayName: "Darwin Search",
      description: "Search Darwin Brain globally, optionally filtered by content type.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          topK: { type: "number" },
          type: { type: "string" },
          filter: { type: "string" },
        },
        required: ["query"],
      },
    },
    async (params): Promise<ToolResult> => {
      const payload = params as { query?: string; topK?: number; type?: string; filter?: string };
      if (!payload.query) return { error: "query is required" };
      const config = await getConfig(ctx);
      if (payload.type) {
        return await invokeDarwin(ctx, config, "darwin_search_by_type", {
          query: payload.query,
          type: payload.type,
          top_k: payload.topK,
        });
      }
      return await invokeDarwin(ctx, config, "darwin_search", {
        query: payload.query,
        top_k: payload.topK,
        filter: payload.filter,
      });
    },
  );

  ctx.tools.register(
    TOOL_NAMES.searchTenant,
    {
      displayName: "Darwin Tenant Search",
      description: "Search Darwin Brain inside the caller's configured tenant namespace.",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          topK: { type: "number" },
          filter: { type: "string" },
        },
        required: ["query"],
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      const payload = params as { query?: string; topK?: number; filter?: string };
      if (!payload.query) return { error: "query is required" };
      const config = await getConfig(ctx);
      const policy = ensurePolicy(config, runCtx);
      return await invokeDarwin(ctx, config, "darwin_search_tenant", {
        query: payload.query,
        tenant: policy.namespace,
        top_k: payload.topK,
        filter: payload.filter,
      });
    },
  );

  ctx.tools.register(
    TOOL_NAMES.store,
    {
      displayName: "Darwin Store",
      description: "Store knowledge in the caller's tenant namespace or promote to shared memory when allowed.",
      parametersSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          category: { type: "string" },
          topic: { type: "string" },
          industry: { type: "string" },
          promote: { type: "boolean" },
        },
        required: ["id", "text"],
      },
    },
    async (params, runCtx): Promise<ToolResult> => {
      const payload = params as DarwinStoreParams;
      if (!payload.id || !payload.text) {
        return { error: "id and text are required" };
      }
      const config = await getConfig(ctx);
      const policy = ensurePolicy(config, runCtx);
      const targetNamespace = payload.promote ? getSharedNamespace(config) : policy.namespace;

      if (payload.promote) {
        if (policy.accessMode !== "promote") {
          return { error: "This agent is not allowed to promote knowledge to shared Darwin memory" };
        }
      } else if (policy.accessMode === "read") {
        return { error: "This agent is not allowed to write to Darwin Brain" };
      }

      const result = await invokeDarwin(ctx, config, "darwin_store", {
        id: payload.id,
        text: payload.text,
        category: payload.category,
        topic: payload.topic,
        industry: payload.industry,
        tenant: targetNamespace,
      });

      if (!result.error) {
        await ctx.activity.log({
          companyId: runCtx.companyId,
          message: payload.promote
            ? `Promoted Darwin knowledge ${payload.id} to shared namespace`
            : `Stored Darwin knowledge ${payload.id} in ${targetNamespace}`,
          entityType: "agent",
          entityId: runCtx.agentId,
          metadata: {
            namespace: targetNamespace,
            promote: Boolean(payload.promote),
          },
        });
      }
      return result;
    },
  );

  ctx.tools.register(
    TOOL_NAMES.info,
    {
      displayName: "Darwin Info",
      description: "Check Darwin Brain health and namespace diagnostics.",
      parametersSchema: {
        type: "object",
        properties: {
          namespace: { type: "string" },
        },
      },
    },
    async (params): Promise<ToolResult> => {
      const payload = params as { namespace?: string };
      const config = await getConfig(ctx);
      return await invokeDarwin(ctx, config, "darwin_info", {
        namespace: payload.namespace,
      });
    },
  );
}

const plugin = definePlugin({
  async setup(ctx) {
    await registerToolHandlers(ctx);
    ctx.logger.info("Darwin Brain bridge plugin setup complete", {
      pluginId: PLUGIN_ID,
      version: PLUGIN_VERSION,
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Darwin Brain bridge plugin ready",
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
