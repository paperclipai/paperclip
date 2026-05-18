import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentToolGrants, agents, companyTools } from "@paperclipai/db";
import type { ToolAccessMode } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

function normalizeModes(value: unknown): ToolAccessMode[] {
  const modes = Array.isArray(value) ? value : ["off", "read"];
  return modes.filter((mode): mode is ToolAccessMode =>
    mode === "off" || mode === "read" || mode === "write" || mode === "admin"
  );
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
