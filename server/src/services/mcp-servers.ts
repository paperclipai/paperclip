import { and, eq, desc, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mcpServers, agentMcpServers } from "@paperclipai/db";
import type { CreateMcpServer, UpdateMcpServer } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";

export function mcpServerService(db: Db) {
  async function getById(id: string) {
    return db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, id))
      .then((rows) => rows[0] ?? null);
  }

  return {
    getById,

    list: async (companyId: string) => {
      return db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.companyId, companyId))
        .orderBy(desc(mcpServers.createdAt));
    },

    create: async (companyId: string, input: CreateMcpServer) => {
      const existing = await db
        .select()
        .from(mcpServers)
        .where(and(eq(mcpServers.companyId, companyId), eq(mcpServers.name, input.name)))
        .then((rows) => rows[0] ?? null);
      if (existing) throw conflict(`MCP server with name "${input.name}" already exists`);

      const [created] = await db
        .insert(mcpServers)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          transportType: input.transportType,
          command: input.command ?? null,
          args: input.args ?? [],
          url: input.url ?? null,
          headers: (input.headers ?? {}) as Record<string, unknown>,
          env: (input.env ?? {}) as Record<string, unknown>,
          enabled: input.enabled ?? true,
        })
        .returning();
      return created;
    },

    update: async (id: string, patch: UpdateMcpServer) => {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) updates.name = patch.name;
      if (patch.description !== undefined) updates.description = patch.description;
      if (patch.transportType !== undefined) updates.transportType = patch.transportType;
      if (patch.command !== undefined) updates.command = patch.command;
      if (patch.args !== undefined) updates.args = patch.args;
      if (patch.url !== undefined) updates.url = patch.url;
      if (patch.headers !== undefined) updates.headers = patch.headers;
      if (patch.env !== undefined) updates.env = patch.env;
      if (patch.enabled !== undefined) updates.enabled = patch.enabled;

      const [updated] = await db
        .update(mcpServers)
        .set(updates)
        .where(eq(mcpServers.id, id))
        .returning();
      return updated ?? null;
    },

    remove: async (id: string) => {
      const [deleted] = await db.delete(mcpServers).where(eq(mcpServers.id, id)).returning();
      return deleted ?? null;
    },

    /** Returns all assigned MCP servers (including disabled) for UI display. */
    listForAgent: async (agentId: string) => {
      const rows = await db
        .select({
          mcpServer: mcpServers,
        })
        .from(agentMcpServers)
        .innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
        .where(eq(agentMcpServers.agentId, agentId));
      return rows.map((r) => r.mcpServer);
    },

    /** Returns only enabled assigned MCP servers for runtime injection. */
    listEnabledForAgent: async (agentId: string) => {
      const rows = await db
        .select({
          mcpServer: mcpServers,
        })
        .from(agentMcpServers)
        .innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
        .where(and(eq(agentMcpServers.agentId, agentId), eq(mcpServers.enabled, true)));
      return rows.map((r) => r.mcpServer);
    },

    setAgentMcpServers: async (agentId: string, companyId: string, mcpServerIds: string[]) => {
      return db.transaction(async (tx) => {
        // Verify ownership before deleting
        let servers: (typeof mcpServers.$inferSelect)[] = [];
        if (mcpServerIds.length > 0) {
          servers = await tx
            .select()
            .from(mcpServers)
            .where(and(eq(mcpServers.companyId, companyId), inArray(mcpServers.id, mcpServerIds)));
          if (servers.length !== mcpServerIds.length) {
            throw notFound("One or more MCP servers not found in this company");
          }
        }

        await tx.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId));

        if (mcpServerIds.length > 0) {
          await tx.insert(agentMcpServers).values(
            mcpServerIds.map((mcpServerId) => ({
              agentId,
              mcpServerId,
              companyId,
            })),
          );
        }

        return servers;
      });
    },

    listAgentMcpServerIds: async (agentId: string) => {
      const rows = await db
        .select({ mcpServerId: agentMcpServers.mcpServerId })
        .from(agentMcpServers)
        .where(eq(agentMcpServers.agentId, agentId));
      return rows.map((r) => r.mcpServerId);
    },
  };
}
