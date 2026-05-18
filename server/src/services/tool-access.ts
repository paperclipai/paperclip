import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentToolGrants, agents, companyTools } from "@paperclipai/db";
import type { ToolAccessMode } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

type ToolAccessAgent = Pick<typeof agents.$inferSelect, "id" | "adapterType" | "adapterConfig">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function normalizeModes(value: unknown): ToolAccessMode[] {
  const modes = Array.isArray(value) ? value : ["off", "read"];
  return modes.filter((mode): mode is ToolAccessMode =>
    mode === "off" || mode === "read" || mode === "write" || mode === "admin"
  );
}

function parseToolsets(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function hermesRenderSpec(render: unknown): Record<string, unknown> | null {
  if (!isRecord(render) || !isRecord(render.hermes)) return null;
  return render.hermes;
}

function addMcpInclude(mcpServers: Record<string, unknown>, serverKey: string, toolName: string) {
  const existingServer = isRecord(mcpServers[serverKey]) ? mcpServers[serverKey] : {};
  const existingTools = isRecord(existingServer.tools) ? existingServer.tools : {};
  const include = new Set([...stringList(existingTools.include), toolName]);
  mcpServers[serverKey] = {
    ...existingServer,
    enabled: true,
    tools: {
      ...existingTools,
      include: [...include].sort(),
      resources: false,
      prompts: false,
    },
  };
}

export function toolAccessService(db: Db) {
  async function listMatrix(companyId: string) {
    const [tools, grants] = await Promise.all([
      db.select().from(companyTools).where(eq(companyTools.companyId, companyId)).orderBy(asc(companyTools.label)),
      db.select().from(agentToolGrants).where(eq(agentToolGrants.companyId, companyId)),
    ]);
    return { tools, grants };
  }

  return {
    listMatrix,

    createTool: async (companyId: string, input: Omit<typeof companyTools.$inferInsert, "companyId">) => {
      const [created] = await db.insert(companyTools).values({ ...input, companyId }).returning();
      return created;
    },

    renderHermesAgentConfig: async (companyId: string, agent: ToolAccessAgent) => {
      const adapterConfig = isRecord(agent.adapterConfig) ? { ...agent.adapterConfig } : {};
      if (agent.adapterType !== "hermes_local") return { adapterConfig };

      const { tools, grants } = await listMatrix(companyId);
      const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
      const toolsets = new Set(parseToolsets(adapterConfig.toolsets));
      const mcpServers: Record<string, unknown> = isRecord(adapterConfig.mcp_servers)
        ? { ...adapterConfig.mcp_servers }
        : {};

      for (const grant of grants) {
        if (grant.agentId !== agent.id || grant.mode === "off") continue;
        const tool = toolsById.get(grant.toolId);
        if (!tool) continue;
        const hermes = hermesRenderSpec(tool.render);
        if (!hermes) continue;

        if (typeof hermes.toolset === "string" && hermes.toolset.length > 0) {
          toolsets.add(hermes.toolset);
        }
        if (
          typeof hermes.mcpServer === "string"
          && hermes.mcpServer.length > 0
          && typeof hermes.includeTool === "string"
          && hermes.includeTool.length > 0
        ) {
          addMcpInclude(mcpServers, hermes.mcpServer, hermes.includeTool);
        }
      }

      return {
        adapterConfig: {
          ...adapterConfig,
          toolsets: [...toolsets].sort().join(","),
          mcp_servers: mcpServers,
        },
      };
    },

    setGrant: async (
      companyId: string,
      agentId: string,
      toolId: string,
      mode: ToolAccessMode,
      grantedByUserId: string | null,
    ) => {
      const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
      if (!agent) throw notFound("Agent not found");
      const [tool] = await db.select().from(companyTools).where(and(eq(companyTools.id, toolId), eq(companyTools.companyId, companyId)));
      if (!tool) throw notFound("Tool not found");
      if (!normalizeModes(tool.supportedModes).includes(mode)) {
        throw unprocessable(`Tool ${tool.key} does not support mode ${mode}`);
      }
      const existing = await db
        .select()
        .from(agentToolGrants)
        .where(and(eq(agentToolGrants.agentId, agentId), eq(agentToolGrants.toolId, toolId)))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const [updated] = await db.update(agentToolGrants)
          .set({ mode, grantedByUserId, updatedAt: new Date() })
          .where(eq(agentToolGrants.id, existing.id))
          .returning();
        return updated;
      }
      const [created] = await db.insert(agentToolGrants).values({
        companyId,
        agentId,
        toolId,
        mode,
        grantedByUserId,
      }).returning();
      return created;
    },
  };
}
