import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { mapAgentId } from "./agent-mapping.js";
import { createBrainMcpClient, BrainMcpError, type BrainMcpClient } from "./mcp-client.js";

const PLUGIN_NAME = "brain";

interface CompanyConfig {
  mcpEndpoint: string;
  bearerToken: string;
  agentMap: Record<string, string>;
}

interface BrainConfig {
  companies: Record<string, CompanyConfig>;
  defaultCompanyId?: string;
}

function readConfig(raw: Record<string, unknown>): BrainConfig {
  const companies: Record<string, CompanyConfig> = {};
  const rawCompanies = raw.companies;
  if (rawCompanies && typeof rawCompanies === "object" && !Array.isArray(rawCompanies)) {
    for (const [companyId, rawCompany] of Object.entries(
      rawCompanies as Record<string, unknown>,
    )) {
      if (!rawCompany || typeof rawCompany !== "object") continue;
      const c = rawCompany as Record<string, unknown>;
      const mcpEndpoint = typeof c.mcpEndpoint === "string" ? c.mcpEndpoint : "";
      const bearerToken = typeof c.bearerToken === "string" ? c.bearerToken : "";
      if (!mcpEndpoint || !bearerToken) continue;
      const agentMap: Record<string, string> = {};
      if (c.agentMap && typeof c.agentMap === "object" && !Array.isArray(c.agentMap)) {
        for (const [k, v] of Object.entries(c.agentMap as Record<string, unknown>)) {
          if (typeof v === "string") agentMap[k] = v;
        }
      }
      companies[companyId] = { mcpEndpoint, bearerToken, agentMap };
    }
  }
  const defaultCompanyId =
    typeof raw.defaultCompanyId === "string" && raw.defaultCompanyId.length > 0
      ? raw.defaultCompanyId
      : undefined;
  return { companies, defaultCompanyId };
}

interface CompanyRoute {
  client: BrainMcpClient;
  agentMap: Record<string, string>;
}

const plugin = definePlugin({
  async setup(ctx) {
    const raw = await ctx.config.get();
    const cfg = readConfig(raw);

    const routes = new Map<string, CompanyRoute>();
    for (const [companyId, c] of Object.entries(cfg.companies)) {
      routes.set(companyId, {
        client: createBrainMcpClient({ endpoint: c.mcpEndpoint, bearerToken: c.bearerToken }),
        agentMap: c.agentMap,
      });
    }

    if (routes.size === 0) {
      ctx.logger.warn(
        `${PLUGIN_NAME}: no companies configured — all tool calls will be rejected`,
      );
    } else {
      ctx.logger.info(
        `${PLUGIN_NAME}: ${routes.size} compan${routes.size === 1 ? "y" : "ies"} wired (${Array.from(
          routes.keys(),
        ).join(", ")})${cfg.defaultCompanyId ? `, default=${cfg.defaultCompanyId}` : ""}`,
      );
    }

    const pickRoute = (runCtx: { companyId?: string }): CompanyRoute | undefined => {
      const id = runCtx.companyId ?? cfg.defaultCompanyId;
      if (!id) return undefined;
      return routes.get(id);
    };

    const wrap =
      (mcpTool: string) =>
      async (
        params: unknown,
        runCtx: { agentId: string; companyId?: string },
      ): Promise<{ data?: unknown; error?: string }> => {
        const route = pickRoute(runCtx);
        if (!route) {
          return {
            error: `No Brain endpoint configured for company ${runCtx.companyId ?? "<unknown>"}`,
          };
        }
        try {
          const aclKey = mapAgentId(runCtx.agentId, route.agentMap);
          const args = (params && typeof params === "object" ? params : {}) as Record<
            string,
            unknown
          >;
          const result = await route.client.call(mcpTool, { ...args, agentId: aclKey });
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
        description: "Semantic search across the company's Obsidian vault (ACL-enforced).",
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
