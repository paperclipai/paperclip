import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { mapAgentId } from "./agent-mapping.js";
import { createBrainMcpClient, BrainMcpError } from "./mcp-client.js";

const PLUGIN_NAME = "brain";

interface BrainConfig {
  mcpEndpoint?: string;
  bearerToken?: string;
  agentMap?: Record<string, string>;
}

function readConfig(raw: Record<string, unknown>): Required<BrainConfig> {
  const mcpEndpoint =
    typeof raw.mcpEndpoint === "string" && raw.mcpEndpoint.length > 0
      ? raw.mcpEndpoint
      : "http://localhost:7777";
  const bearerToken = typeof raw.bearerToken === "string" ? raw.bearerToken : "";
  const agentMap: Record<string, string> = {};
  if (raw.agentMap && typeof raw.agentMap === "object" && !Array.isArray(raw.agentMap)) {
    for (const [k, v] of Object.entries(raw.agentMap as Record<string, unknown>)) {
      if (typeof v === "string") agentMap[k] = v;
    }
  }
  return { mcpEndpoint, bearerToken, agentMap };
}

const plugin = definePlugin({
  async setup(ctx) {
    const raw = await ctx.config.get();
    const cfg = readConfig(raw);

    if (!cfg.bearerToken) {
      ctx.logger.warn(`${PLUGIN_NAME}: bearerToken not configured — MCP calls will be rejected`);
    }
    ctx.logger.info(
      `${PLUGIN_NAME}: routing to ${cfg.mcpEndpoint} (agent mappings: ${Object.keys(cfg.agentMap).length})`,
    );

    const client = createBrainMcpClient({
      endpoint: cfg.mcpEndpoint,
      bearerToken: cfg.bearerToken,
    });

    const wrap = (mcpTool: string) => async (params: unknown, runCtx: { agentId: string }) => {
      try {
        const aclKey = mapAgentId(runCtx.agentId, cfg.agentMap);
        const args = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
        const result = await client.call(mcpTool, { ...args, agentId: aclKey });
        return { data: result };
      } catch (err) {
        const message =
          err instanceof BrainMcpError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return { error: message };
      }
    };

    ctx.tools.register(
      "vault.search",
      {
        displayName: "Search vault",
        description: "Semantic search across the Obsidian vault (ACL-enforced).",
        parametersSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 50 },
            folderFilter: { type: "array", items: { type: "string" } },
          },
          required: ["query"],
        },
      },
      wrap("search_vault"),
    );

    ctx.tools.register(
      "vault.get_note",
      {
        displayName: "Get note",
        description: "Return full body of a vault note by path (ACL-enforced).",
        parametersSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      wrap("get_note"),
    );

    ctx.tools.register(
      "vault.list_scope",
      {
        displayName: "List scope",
        description: "List folders the current agent may access.",
        parametersSchema: { type: "object", properties: {} },
      },
      wrap("list_scope"),
    );

    ctx.logger.info(`${PLUGIN_NAME}: 3 tools registered`);
  },

  async onHealth() {
    return { status: "ok", message: "Brain plugin worker alive" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
