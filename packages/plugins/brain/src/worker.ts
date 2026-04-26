import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { mapAgentId, parseAgentMap } from "./agent-mapping.js";
import { createBrainMcpClient, BrainMcpError } from "./mcp-client.js";

const PLUGIN_NAME = "brain";

const plugin = definePlugin({
  async setup(ctx) {
    const endpoint = process.env.BRAIN_MCP_ENDPOINT ?? "http://localhost:7777";
    const token = process.env.BRAIN_PAPERCLIP_TOKEN ?? "";
    const agentMap = parseAgentMap(process.env.BRAIN_AGENT_MAP);

    if (!token) {
      ctx.logger.warn(`${PLUGIN_NAME}: BRAIN_PAPERCLIP_TOKEN not set — calls will be rejected`);
    }
    ctx.logger.info(
      `${PLUGIN_NAME}: routing tools to ${endpoint} (mappings: ${Object.keys(agentMap).length})`,
    );

    const client = createBrainMcpClient({ endpoint, bearerToken: token });

    const wrap = (mcpTool: string) => async (params: unknown, runCtx: { agentId: string }) => {
      try {
        const aclKey = mapAgentId(runCtx.agentId, agentMap);
        const args = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
        const result = await client.call(mcpTool, { ...args, agentId: aclKey });
        return { data: result };
      } catch (err) {
        const message = err instanceof BrainMcpError ? err.message : err instanceof Error ? err.message : String(err);
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
    const endpoint = process.env.BRAIN_MCP_ENDPOINT ?? "http://localhost:7777";
    try {
      const res = await fetch(endpoint, { method: "GET", signal: AbortSignal.timeout(2000) });
      // We expect 405 (POST-only) — that means server is up.
      if (res.status === 405 || res.status === 401 || res.ok) {
        return { status: "ok", message: `Brain MCP reachable at ${endpoint}` };
      }
      return { status: "degraded", message: `Brain MCP returned ${res.status}` };
    } catch (err) {
      return {
        status: "error",
        message: `Brain MCP unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
