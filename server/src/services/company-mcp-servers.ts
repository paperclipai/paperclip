import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companyMcpServers } from "@paperclipai/db";
import type {
  AgentMcpServersSnapshot,
  CompanyMcpServer,
  CompanyMcpServerDetail,
  CompanyMcpServerListItem,
  CompanyMcpServerUsageAgent,
  McpServerConfig,
} from "@paperclipai/shared";
import { MCP_SERVER_NAME_RE } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";
import { sanitizeMcpServerConfigForResponse } from "./mcp-sanitize.js";

/**
 * Company-level MCP server catalog (mirrors companySkillService). Servers are
 * defined once per company with secret values stored as secret references;
 * agents opt in by name via `adapterConfig.mcpServerRefs: string[]`. At run
 * time the heartbeat expands refs into the agent's effective mcpServers record
 * (per-agent inline definitions win on name conflicts).
 */

type CompanyMcpServerRow = typeof companyMcpServers.$inferSelect;

export const MCP_SERVER_REFS_CONFIG_KEY = "mcpServerRefs";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Read the agent's catalog refs from its adapterConfig (deduped, ordered). */
export function readAgentMcpServerRefs(adapterConfig: unknown): string[] {
  const raw = asRecord(adapterConfig)?.[MCP_SERVER_REFS_CONFIG_KEY];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    refs.push(trimmed);
  }
  return refs;
}

/** Return a new adapterConfig with the catalog refs replaced (removed when empty). */
export function writeAgentMcpServerRefs(
  adapterConfig: Record<string, unknown>,
  refs: string[],
): Record<string, unknown> {
  const next = { ...adapterConfig };
  const deduped = [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
  if (deduped.length > 0) {
    next[MCP_SERVER_REFS_CONFIG_KEY] = deduped;
  } else {
    delete next[MCP_SERVER_REFS_CONFIG_KEY];
  }
  return next;
}

function isOauthConnected(config: unknown): boolean {
  const auth = asRecord(asRecord(config)?.auth);
  return auth?.type === "oauth" && typeof auth.secretId === "string" && auth.secretId.length > 0;
}

export function companyMcpServerService(db: Db) {
  const secrets = secretService(db);

  function toCompanyMcpServer(row: CompanyMcpServerRow, opts?: { sanitize?: boolean }): CompanyMcpServer {
    const config = (opts?.sanitize === false
      ? (row.config as Record<string, unknown>)
      : sanitizeMcpServerConfigForResponse(row.config)) as unknown as McpServerConfig;
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      description: row.description,
      config,
      enabled: row.enabled,
      createdByAgentId: row.createdByAgentId,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function usageByServerName(companyId: string): Promise<Map<string, CompanyMcpServerUsageAgent[]>> {
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        title: agents.title,
        status: agents.status,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const usage = new Map<string, CompanyMcpServerUsageAgent[]>();
    for (const row of rows) {
      for (const ref of readAgentMcpServerRefs(row.adapterConfig)) {
        const list = usage.get(ref) ?? [];
        list.push({ id: row.id, name: row.name, title: row.title, status: row.status });
        usage.set(ref, list);
      }
    }
    return usage;
  }

  async function getRowById(companyId: string, id: string): Promise<CompanyMcpServerRow | null> {
    const [row] = await db
      .select()
      .from(companyMcpServers)
      .where(and(eq(companyMcpServers.companyId, companyId), eq(companyMcpServers.id, id)))
      .limit(1);
    return row ?? null;
  }

  async function getRowByName(companyId: string, name: string): Promise<CompanyMcpServerRow | null> {
    const [row] = await db
      .select()
      .from(companyMcpServers)
      .where(and(eq(companyMcpServers.companyId, companyId), eq(companyMcpServers.name, name)))
      .limit(1);
    return row ?? null;
  }

  async function syncCatalogSecretBindings(companyId: string, row: CompanyMcpServerRow) {
    await secrets.syncMcpBindingsForTarget(
      companyId,
      { targetType: "mcp_server", targetId: row.id },
      { [row.name]: row.config },
    );
  }

  const svc = {
    async list(companyId: string): Promise<CompanyMcpServerListItem[]> {
      const rows = await db
        .select()
        .from(companyMcpServers)
        .where(eq(companyMcpServers.companyId, companyId))
        .orderBy(companyMcpServers.name);
      const usage = await usageByServerName(companyId);
      return rows.map((row) => ({
        ...toCompanyMcpServer(row),
        attachedAgentCount: usage.get(row.name)?.length ?? 0,
        oauthConnected: isOauthConnected(row.config),
      }));
    },

    async detail(companyId: string, id: string): Promise<CompanyMcpServerDetail> {
      const row = await getRowById(companyId, id);
      if (!row) throw notFound("MCP server not found");
      const usage = await usageByServerName(companyId);
      const usedByAgents = usage.get(row.name) ?? [];
      return {
        ...toCompanyMcpServer(row),
        attachedAgentCount: usedByAgents.length,
        oauthConnected: isOauthConnected(row.config),
        usedByAgents,
      };
    },

    getRowById,
    getRowByName,

    async create(
      companyId: string,
      input: {
        name: string;
        description?: string | null;
        config: Record<string, unknown>;
        enabled?: boolean;
      },
      actor?: { userId?: string | null; agentId?: string | null },
      opts?: { strictMode?: boolean },
    ): Promise<CompanyMcpServer> {
      if (!MCP_SERVER_NAME_RE.test(input.name)) {
        throw unprocessable(`Invalid MCP server name: ${input.name}`);
      }
      const existing = await getRowByName(companyId, input.name);
      if (existing) throw conflict(`MCP server already exists: ${input.name}`);
      const normalized = await secrets.normalizeMcpServersForPersistence(
        companyId,
        { [input.name]: input.config },
        opts,
      );
      const [created] = await db
        .insert(companyMcpServers)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          config: normalized[input.name] as unknown as Record<string, unknown>,
          enabled: input.enabled ?? true,
          createdByAgentId: actor?.agentId ?? null,
          createdByUserId: actor?.userId ?? null,
        })
        .returning();
      await syncCatalogSecretBindings(companyId, created);
      return toCompanyMcpServer(created);
    },

    async update(
      companyId: string,
      id: string,
      input: {
        name?: string;
        description?: string | null;
        config?: Record<string, unknown>;
        enabled?: boolean;
      },
      opts?: { strictMode?: boolean },
    ): Promise<CompanyMcpServer> {
      const existing = await getRowById(companyId, id);
      if (!existing) throw notFound("MCP server not found");

      const nextName = input.name ?? existing.name;
      if (!MCP_SERVER_NAME_RE.test(nextName)) {
        throw unprocessable(`Invalid MCP server name: ${nextName}`);
      }
      if (nextName !== existing.name) {
        const taken = await getRowByName(companyId, nextName);
        if (taken) throw conflict(`MCP server already exists: ${nextName}`);
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name !== undefined) updates.name = nextName;
      if (input.description !== undefined) updates.description = input.description;
      if (input.enabled !== undefined) updates.enabled = input.enabled;
      if (input.config !== undefined) {
        // A brokered OAuth connection lives in config.auth.secretId server-side.
        // Stale client copies send secretId:null — carry the connected secret
        // forward (mirrors the per-agent route guard).
        const incomingAuth = asRecord(asRecord(input.config)?.auth);
        const existingAuth = asRecord(asRecord(existing.config)?.auth);
        let guardedConfig = input.config;
        if (
          incomingAuth?.type === "oauth" &&
          !incomingAuth.secretId &&
          existingAuth?.type === "oauth" &&
          typeof existingAuth.secretId === "string" &&
          existingAuth.secretId
        ) {
          guardedConfig = {
            ...input.config,
            auth: { ...incomingAuth, secretId: existingAuth.secretId },
          };
        }
        const normalized = await secrets.normalizeMcpServersForPersistence(
          companyId,
          { [nextName]: guardedConfig },
          opts,
        );
        updates.config = normalized[nextName] as unknown as Record<string, unknown>;
      }

      const [updated] = await db
        .update(companyMcpServers)
        .set(updates)
        .where(and(eq(companyMcpServers.companyId, companyId), eq(companyMcpServers.id, id)))
        .returning();
      await syncCatalogSecretBindings(companyId, updated);

      // Renames must follow through to every agent's refs so enablement
      // survives (config-only storage, no join table).
      if (nextName !== existing.name) {
        const agentRows = await db
          .select({ id: agents.id, adapterConfig: agents.adapterConfig })
          .from(agents)
          .where(eq(agents.companyId, companyId));
        for (const agentRow of agentRows) {
          const refs = readAgentMcpServerRefs(agentRow.adapterConfig);
          if (!refs.includes(existing.name)) continue;
          const nextRefs = refs.map((ref) => (ref === existing.name ? nextName : ref));
          const adapterConfig = writeAgentMcpServerRefs(
            asRecord(agentRow.adapterConfig) ?? {},
            nextRefs,
          );
          await db
            .update(agents)
            .set({ adapterConfig, updatedAt: new Date() })
            .where(eq(agents.id, agentRow.id));
        }
      }

      return toCompanyMcpServer(updated);
    },

    async remove(
      companyId: string,
      id: string,
      opts?: { force?: boolean },
    ): Promise<
      | { ok: true; removed: CompanyMcpServer }
      | { ok: false; error: "in_use"; usedByAgents: CompanyMcpServerUsageAgent[] }
    > {
      const existing = await getRowById(companyId, id);
      if (!existing) throw notFound("MCP server not found");
      const usage = await usageByServerName(companyId);
      const usedByAgents = usage.get(existing.name) ?? [];
      if (usedByAgents.length > 0 && !opts?.force) {
        return { ok: false, error: "in_use", usedByAgents };
      }
      // Drop the refs from any remaining agents so no dangling names linger.
      if (usedByAgents.length > 0) {
        for (const usageAgent of usedByAgents) {
          const [agentRow] = await db
            .select({ id: agents.id, adapterConfig: agents.adapterConfig })
            .from(agents)
            .where(eq(agents.id, usageAgent.id))
            .limit(1);
          if (!agentRow) continue;
          const refs = readAgentMcpServerRefs(agentRow.adapterConfig).filter(
            (ref) => ref !== existing.name,
          );
          await db
            .update(agents)
            .set({
              adapterConfig: writeAgentMcpServerRefs(asRecord(agentRow.adapterConfig) ?? {}, refs),
              updatedAt: new Date(),
            })
            .where(eq(agents.id, agentRow.id));
        }
      }
      await secrets.syncMcpBindingsForTarget(
        companyId,
        { targetType: "mcp_server", targetId: existing.id },
        {},
      );
      await db
        .delete(companyMcpServers)
        .where(and(eq(companyMcpServers.companyId, companyId), eq(companyMcpServers.id, id)));
      return { ok: true, removed: toCompanyMcpServer(existing) };
    },

    /** Validate requested refs against the catalog; throws on unknown names. */
    async resolveRequestedNames(companyId: string, requested: string[]): Promise<string[]> {
      const rows = await db
        .select({ name: companyMcpServers.name })
        .from(companyMcpServers)
        .where(eq(companyMcpServers.companyId, companyId));
      const known = new Set(rows.map((row) => row.name));
      const resolved: string[] = [];
      const seen = new Set<string>();
      for (const raw of requested) {
        const name = raw.trim();
        if (!name || seen.has(name)) continue;
        if (!known.has(name)) {
          throw unprocessable(`Unknown MCP server: ${name}`);
        }
        seen.add(name);
        resolved.push(name);
      }
      return resolved;
    },

    /** Per-agent enablement snapshot for the UI checkbox tab. */
    async snapshotForAgent(companyId: string, adapterConfig: unknown): Promise<AgentMcpServersSnapshot> {
      const refs = readAgentMcpServerRefs(adapterConfig);
      const rows = await db
        .select({ name: companyMcpServers.name })
        .from(companyMcpServers)
        .where(eq(companyMcpServers.companyId, companyId));
      const known = new Set(rows.map((row) => row.name));
      return {
        desiredMcpServers: refs,
        missing: refs.filter((ref) => !known.has(ref)),
      };
    },

    /**
     * Expand the agent's catalog refs into an effective mcpServers record on a
     * run config. Only enabled catalog entries expand; per-agent inline
     * definitions win on name conflicts. Returns the config unchanged when
     * there is nothing to expand.
     */
    async expandAgentMcpServers(
      companyId: string,
      runConfig: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const refs = readAgentMcpServerRefs(runConfig);
      if (refs.length === 0) return runConfig;
      const rows = await db
        .select()
        .from(companyMcpServers)
        .where(and(eq(companyMcpServers.companyId, companyId), eq(companyMcpServers.enabled, true)));
      const byName = new Map(rows.map((row) => [row.name, row.config]));
      const expanded: Record<string, unknown> = {};
      for (const ref of refs) {
        const config = byName.get(ref);
        if (config) expanded[ref] = config;
      }
      if (Object.keys(expanded).length === 0) return runConfig;
      const inline = asRecord(runConfig.mcpServers) ?? {};
      return {
        ...runConfig,
        mcpServers: { ...expanded, ...inline },
      };
    },
  };

  return svc;
}
