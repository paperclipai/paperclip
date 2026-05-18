import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentToolGrants, agents, companyTools, toolAccessPolicies, toolAccessPresets } from "@paperclipai/db";
import type { ToolAccessMode } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

type ToolAccessAgent = Pick<typeof agents.$inferSelect, "id" | "adapterType" | "adapterConfig" | "metadata">;
type ToolAccessMatrix = {
  tools: Array<typeof companyTools.$inferSelect>;
  grants: Array<typeof agentToolGrants.$inferSelect>;
};
type GrantChangePreview = {
  previousMode: ToolAccessMode;
  tool: typeof companyTools.$inferSelect;
};
type ToolAccessGrantRequest = { agentId: string; toolId: string; mode: ToolAccessMode };

interface ToolAccessRenderState {
  version: 1;
  toolsets: string[];
  mcpServers: Record<string, {
    include: string[];
    created: boolean;
  }>;
}

const TOOL_ACCESS_RENDER_METADATA_KEY = "toolAccessRender";

const RISK_RANK = { read: 1, write: 2, admin: 3, secret: 4 } as const;
const MODE_RANK = { off: 0, read: 1, write: 2, admin: 3 } as const;

export function riskMeetsThreshold(risk: string, threshold: string | null | undefined): boolean {
  if (!threshold) return false;
  const riskRank = RISK_RANK[risk as keyof typeof RISK_RANK] ?? 0;
  const thresholdRank = RISK_RANK[threshold as keyof typeof RISK_RANK] ?? 99;
  return riskRank >= thresholdRank;
}

export function modeIncreases(previousMode: string, newMode: string): boolean {
  const previousRank = MODE_RANK[previousMode as keyof typeof MODE_RANK] ?? 0;
  const newRank = MODE_RANK[newMode as keyof typeof MODE_RANK] ?? 0;
  return newRank > previousRank;
}

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

function normalizePresetGrants(value: unknown): Array<{ toolKey: string; mode: ToolAccessMode }> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is { toolKey: string; mode: ToolAccessMode } => {
    if (!isRecord(entry)) return false;
    return typeof entry.toolKey === "string" && normalizeModes([entry.mode]).length === 1;
  });
}

function parseToolsets(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function sortedStrings(values: Iterable<string>) {
  return [...new Set(values)].sort();
}

function hermesRenderSpec(render: unknown): Record<string, unknown> | null {
  if (!isRecord(render) || !isRecord(render.hermes)) return null;
  return render.hermes;
}

function readToolAccessRenderState(metadata: unknown): ToolAccessRenderState {
  const raw = isRecord(metadata) ? metadata[TOOL_ACCESS_RENDER_METADATA_KEY] : null;
  if (!isRecord(raw)) {
    return { version: 1, toolsets: [], mcpServers: {} };
  }

  const mcpServers: ToolAccessRenderState["mcpServers"] = {};
  if (isRecord(raw.mcpServers)) {
    for (const [serverKey, value] of Object.entries(raw.mcpServers)) {
      const spec = isRecord(value) ? value : {};
      const include = sortedStrings(stringList(spec.include));
      if (include.length === 0) continue;
      mcpServers[serverKey] = {
        include,
        created: spec.created === true,
      };
    }
  }

  return {
    version: 1,
    toolsets: sortedStrings(stringList(raw.toolsets)),
    mcpServers,
  };
}

function hasToolAccessRenderState(state: ToolAccessRenderState) {
  return state.toolsets.length > 0 || Object.keys(state.mcpServers).length > 0;
}

function metadataWithToolAccessRenderState(metadata: unknown, state: ToolAccessRenderState) {
  const next = isRecord(metadata) ? { ...metadata } : {};
  if (hasToolAccessRenderState(state)) {
    next[TOOL_ACCESS_RENDER_METADATA_KEY] = {
      version: 1,
      toolsets: sortedStrings(state.toolsets),
      mcpServers: Object.fromEntries(
        Object.entries(state.mcpServers)
          .filter(([, spec]) => spec.include.length > 0)
          .map(([serverKey, spec]) => [
            serverKey,
            {
              include: sortedStrings(spec.include),
              created: spec.created,
            },
          ]),
      ),
    };
  } else {
    delete next[TOOL_ACCESS_RENDER_METADATA_KEY];
  }
  return Object.keys(next).length > 0 ? next : null;
}

function copyMcpServers(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([serverKey, server]) => [
      serverKey,
      isRecord(server)
        ? {
          ...server,
          tools: isRecord(server.tools) ? { ...server.tools } : server.tools,
        }
        : server,
    ]),
  );
}

function isGeneratedMcpServerShell(server: Record<string, unknown>) {
  if (server.enabled !== true) return false;
  if (!Object.keys(server).every((key) => key === "enabled" || key === "tools")) return false;
  const tools = isRecord(server.tools) ? server.tools : {};
  return Object.entries(tools).every(([key, value]) =>
    (key === "resources" || key === "prompts") && value === false
  );
}

function stripPreviousRender(
  adapterConfig: Record<string, unknown>,
  previousRender: ToolAccessRenderState,
) {
  const previousToolsets = new Set(previousRender.toolsets);
  const toolsets = new Set(parseToolsets(adapterConfig.toolsets).filter((toolset) => !previousToolsets.has(toolset)));
  const mcpServers = copyMcpServers(adapterConfig.mcp_servers);

  for (const [serverKey, spec] of Object.entries(previousRender.mcpServers)) {
    const existingServer = mcpServers[serverKey];
    if (!isRecord(existingServer)) continue;
    const server = { ...existingServer };
    const tools = isRecord(server.tools) ? { ...server.tools } : {};
    const managedIncludes = new Set(spec.include);
    const remainingIncludes = stringList(tools.include).filter((toolName) => !managedIncludes.has(toolName));
    if (remainingIncludes.length > 0) {
      tools.include = sortedStrings(remainingIncludes);
    } else {
      delete tools.include;
    }

    if (Object.keys(tools).length > 0) {
      server.tools = tools;
    } else {
      delete server.tools;
    }

    if (spec.created && isGeneratedMcpServerShell(server)) {
      delete mcpServers[serverKey];
    } else {
      mcpServers[serverKey] = server;
    }
  }

  return { toolsets, mcpServers };
}

function trackMcpInclude(
  state: ToolAccessRenderState,
  serverKey: string,
  toolName: string,
  created: boolean,
) {
  const existing = state.mcpServers[serverKey] ?? { include: [], created: false };
  state.mcpServers[serverKey] = {
    include: sortedStrings([...existing.include, toolName]),
    created: existing.created || created,
  };
}

function addMcpInclude(mcpServers: Record<string, unknown>, serverKey: string, toolName: string) {
  const existingServer = isRecord(mcpServers[serverKey]) ? mcpServers[serverKey] : {};
  const existingTools = isRecord(existingServer.tools) ? existingServer.tools : {};
  const existingInclude = new Set(stringList(existingTools.include));
  const added = !existingInclude.has(toolName);
  const include = new Set([...existingInclude, toolName]);
  mcpServers[serverKey] = {
    ...existingServer,
    enabled: true,
    tools: {
      ...existingTools,
      include: [...include].sort(),
      resources: Object.prototype.hasOwnProperty.call(existingTools, "resources") ? existingTools.resources : false,
      prompts: Object.prototype.hasOwnProperty.call(existingTools, "prompts") ? existingTools.prompts : false,
    },
  };
  return added;
}

export function toolAccessService(db: Db) {
  async function listMatrix(companyId: string) {
    const [tools, grants] = await Promise.all([
      db.select().from(companyTools).where(eq(companyTools.companyId, companyId)).orderBy(asc(companyTools.label)),
      db.select().from(agentToolGrants).where(eq(agentToolGrants.companyId, companyId)),
    ]);
    return { tools, grants };
  }

  async function previewGrantChange(
    companyId: string,
    agentId: string,
    toolId: string,
    mode: ToolAccessMode,
  ): Promise<GrantChangePreview> {
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
      .where(and(
        eq(agentToolGrants.companyId, companyId),
        eq(agentToolGrants.agentId, agentId),
        eq(agentToolGrants.toolId, toolId),
      ))
      .then((rows) => rows[0] ?? null);
    return { previousMode: (existing?.mode ?? "off") as ToolAccessMode, tool };
  }

  async function setGrant(
    companyId: string,
    agentId: string,
    toolId: string,
    mode: ToolAccessMode,
    grantedByUserId: string | null,
  ) {
    const preview = await previewGrantChange(companyId, agentId, toolId, mode);
    const existing = await db
      .select()
      .from(agentToolGrants)
      .where(and(
        eq(agentToolGrants.companyId, companyId),
        eq(agentToolGrants.agentId, agentId),
        eq(agentToolGrants.toolId, toolId),
      ))
      .then((rows) => rows[0] ?? null);
    if (existing) {
      const [updated] = await db.update(agentToolGrants)
        .set({ mode, grantedByUserId, updatedAt: new Date() })
        .where(and(eq(agentToolGrants.id, existing.id), eq(agentToolGrants.companyId, companyId)))
        .returning();
      return { previousMode: preview.previousMode, grant: updated, tool: preview.tool };
    }
    const [created] = await db.insert(agentToolGrants).values({
      companyId,
      agentId,
      toolId,
      mode,
      grantedByUserId,
    }).returning();
    return { previousMode: preview.previousMode, grant: created, tool: preview.tool };
  }

  async function presetGrantRequests(
    companyId: string,
    agentId: string,
    presetId: string,
  ): Promise<ToolAccessGrantRequest[]> {
    const [preset] = await db.select().from(toolAccessPresets).where(and(eq(toolAccessPresets.companyId, companyId), eq(toolAccessPresets.id, presetId)));
    if (!preset) throw notFound("Preset not found");
    const tools = await db.select().from(companyTools).where(eq(companyTools.companyId, companyId));
    const byKey = new Map(tools.map((tool) => [tool.key, tool]));
    const requests: ToolAccessGrantRequest[] = [];
    for (const item of normalizePresetGrants(preset.grants)) {
      const tool = byKey.get(item.toolKey);
      if (!tool) continue;
      requests.push({ agentId, toolId: tool.id, mode: item.mode });
    }
    return requests;
  }

  return {
    listMatrix,

    createTool: async (companyId: string, input: Omit<typeof companyTools.$inferInsert, "companyId">) => {
      const [created] = await db.insert(companyTools).values({ ...input, companyId }).returning();
      return created;
    },

    getPolicy: async (companyId: string) => {
      const [policy] = await db.select().from(toolAccessPolicies).where(eq(toolAccessPolicies.companyId, companyId));
      return policy ?? null;
    },

    getTool: async (companyId: string, toolId: string) => {
      const [tool] = await db.select().from(companyTools).where(and(eq(companyTools.companyId, companyId), eq(companyTools.id, toolId)));
      if (!tool) throw notFound("Tool not found");
      return tool;
    },

    upsertPolicy: async (companyId: string, input: { approvalRequiredAtRisk?: string | null }) => {
      const existing = await db.select().from(toolAccessPolicies).where(eq(toolAccessPolicies.companyId, companyId)).then((rows) => rows[0] ?? null);
      if (existing) {
        const [updated] = await db.update(toolAccessPolicies)
          .set({ approvalRequiredAtRisk: input.approvalRequiredAtRisk ?? null, updatedAt: new Date() })
          .where(eq(toolAccessPolicies.id, existing.id))
          .returning();
        return updated;
      }
      const [created] = await db.insert(toolAccessPolicies).values({
        companyId,
        approvalRequiredAtRisk: input.approvalRequiredAtRisk ?? null,
      }).returning();
      return created;
    },

    previewGrantChange,

    listPresets: async (companyId: string) =>
      db.select().from(toolAccessPresets).where(eq(toolAccessPresets.companyId, companyId)).orderBy(asc(toolAccessPresets.label)),

    createPreset: async (companyId: string, input: Omit<typeof toolAccessPresets.$inferInsert, "companyId">) => {
      const [created] = await db.insert(toolAccessPresets).values({ ...input, companyId }).returning();
      return created;
    },

    presetGrantRequests,

    renderHermesAgentConfig: async (
      companyId: string,
      agent: ToolAccessAgent,
      preloadedMatrix?: ToolAccessMatrix,
    ) => {
      const adapterConfig = isRecord(agent.adapterConfig) ? { ...agent.adapterConfig } : {};
      if (agent.adapterType !== "hermes_local") {
        return { adapterConfig, metadata: agent.metadata ?? null };
      }

      const { tools, grants } = preloadedMatrix ?? await listMatrix(companyId);
      const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
      const previousRender = readToolAccessRenderState(agent.metadata);
      const { toolsets, mcpServers } = stripPreviousRender(adapterConfig, previousRender);
      const nextRenderState: ToolAccessRenderState = { version: 1, toolsets: [], mcpServers: {} };

      for (const grant of grants) {
        if (grant.agentId !== agent.id || grant.mode === "off") continue;
        const tool = toolsById.get(grant.toolId);
        if (!tool) continue;
        const hermes = hermesRenderSpec(tool.render);
        if (!hermes) continue;

        if (typeof hermes.toolset === "string" && hermes.toolset.length > 0) {
          if (!toolsets.has(hermes.toolset)) {
            toolsets.add(hermes.toolset);
            nextRenderState.toolsets.push(hermes.toolset);
          }
        }
        if (
          typeof hermes.mcpServer === "string"
          && hermes.mcpServer.length > 0
          && typeof hermes.includeTool === "string"
          && hermes.includeTool.length > 0
        ) {
          const serverWasCreated = !isRecord(mcpServers[hermes.mcpServer]);
          if (addMcpInclude(mcpServers, hermes.mcpServer, hermes.includeTool)) {
            trackMcpInclude(nextRenderState, hermes.mcpServer, hermes.includeTool, serverWasCreated);
          }
        }
      }

      return {
        adapterConfig: {
          ...adapterConfig,
          toolsets: [...toolsets].sort().join(","),
          mcp_servers: mcpServers,
        },
        metadata: metadataWithToolAccessRenderState(agent.metadata, nextRenderState),
      };
    },

    setGrant,
  };
}
