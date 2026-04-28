import type { Db } from "@paperclipai/db";
import { agentBlueprints } from "@paperclipai/db";
import { and, asc, eq, ilike, or } from "drizzle-orm";
import type { CreateAgentBlueprint, UpdateAgentBlueprint } from "@paperclipai/shared";

export function agentBlueprintService(db: Db) {
  return {
    async list(opts?: { search?: string; role?: string }) {
      const conditions = [];
      if (opts?.role) {
        conditions.push(eq(agentBlueprints.role, opts.role));
      }
      if (opts?.search) {
        const q = `%${opts.search}%`;
        conditions.push(
          or(
            ilike(agentBlueprints.name, q),
            ilike(agentBlueprints.description, q),
            ilike(agentBlueprints.capabilities, q),
          ),
        );
      }
      return db
        .select()
        .from(agentBlueprints)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(agentBlueprints.name));
    },

    async get(id: string) {
      const [row] = await db
        .select()
        .from(agentBlueprints)
        .where(eq(agentBlueprints.id, id));
      return row ?? null;
    },

    async create(input: CreateAgentBlueprint) {
      const [row] = await db
        .insert(agentBlueprints)
        .values({
          name: input.name,
          description: input.description ?? null,
          role: input.role ?? "general",
          title: input.title ?? null,
          icon: input.icon ?? null,
          capabilities: input.capabilities ?? null,
          tags: input.tags ?? [],
          adapterType: input.adapterType,
          adapterConfig: input.adapterConfig ?? {},
          runtimeConfig: input.runtimeConfig ?? {},
          budgetMonthlyCents: input.budgetMonthlyCents ?? 0,
          permissions: input.permissions ?? {},
          instructionsContent: input.instructionsContent ?? null,
          metadata: input.metadata ?? null,
          sourceAgentId: input.sourceAgentId ?? null,
          sourceBlueprintId: input.sourceBlueprintId ?? null,
        })
        .returning();
      return row!;
    },

    async update(id: string, input: UpdateAgentBlueprint) {
      const patch: Partial<typeof agentBlueprints.$inferInsert> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description ?? null;
      if (input.role !== undefined) patch.role = input.role;
      if (input.title !== undefined) patch.title = input.title ?? null;
      if (input.icon !== undefined) patch.icon = input.icon ?? null;
      if (input.capabilities !== undefined) patch.capabilities = input.capabilities ?? null;
      if (input.tags !== undefined) patch.tags = input.tags;
      if (input.adapterType !== undefined) patch.adapterType = input.adapterType;
      if (input.adapterConfig !== undefined) patch.adapterConfig = input.adapterConfig;
      if (input.runtimeConfig !== undefined) patch.runtimeConfig = input.runtimeConfig;
      if (input.budgetMonthlyCents !== undefined) patch.budgetMonthlyCents = input.budgetMonthlyCents;
      if (input.permissions !== undefined) patch.permissions = input.permissions;
      if (input.instructionsContent !== undefined) patch.instructionsContent = input.instructionsContent ?? null;
      if (input.metadata !== undefined) patch.metadata = input.metadata ?? null;
      patch.updatedAt = new Date();

      const [row] = await db
        .update(agentBlueprints)
        .set(patch)
        .where(eq(agentBlueprints.id, id))
        .returning();
      return row ?? null;
    },

    async delete(id: string) {
      await db.delete(agentBlueprints).where(eq(agentBlueprints.id, id));
    },
  };
}
