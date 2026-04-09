import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryBindings, memoryBindingTargets, memoryOperations } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";

export interface MemoryBindingCreateInput {
  bindingKey: string;
  providerKey: string;
  pluginId?: string | null;
  displayName?: string | null;
  configJson?: Record<string, unknown> | null;
  enabled?: boolean;
}

export interface MemoryBindingUpdateInput {
  displayName?: string | null;
  configJson?: Record<string, unknown> | null;
  enabled?: boolean;
}

export interface MemoryOperationsFilter {
  agentId?: string | null;
  bindingKey?: string | null;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export function memoryService(db: Db) {
  return {
    listBindings: async (companyId: string) => {
      return db
        .select()
        .from(memoryBindings)
        .where(eq(memoryBindings.companyId, companyId))
        .orderBy(memoryBindings.bindingKey);
    },

    getBinding: async (companyId: string, bindingKey: string) => {
      return db
        .select()
        .from(memoryBindings)
        .where(and(eq(memoryBindings.companyId, companyId), eq(memoryBindings.bindingKey, bindingKey)))
        .then((rows) => rows[0] ?? null);
    },

    createBinding: async (companyId: string, input: MemoryBindingCreateInput) => {
      const existing = await db
        .select({ id: memoryBindings.id })
        .from(memoryBindings)
        .where(and(eq(memoryBindings.companyId, companyId), eq(memoryBindings.bindingKey, input.bindingKey)))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        throw unprocessable(`Memory binding key "${input.bindingKey}" already exists in this company`);
      }

      return db
        .insert(memoryBindings)
        .values({
          companyId,
          bindingKey: input.bindingKey,
          providerKey: input.providerKey,
          pluginId: input.pluginId ?? null,
          displayName: input.displayName ?? null,
          configJson: input.configJson ?? null,
          enabled: input.enabled ?? true,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    updateBinding: async (companyId: string, bindingKey: string, input: MemoryBindingUpdateInput) => {
      const existing = await db
        .select()
        .from(memoryBindings)
        .where(and(eq(memoryBindings.companyId, companyId), eq(memoryBindings.bindingKey, bindingKey)))
        .then((rows) => rows[0] ?? null);

      if (!existing) throw notFound("Memory binding not found");

      const updates: Partial<typeof memoryBindings.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.displayName !== undefined) updates.displayName = input.displayName;
      if (input.configJson !== undefined) updates.configJson = input.configJson;
      if (input.enabled !== undefined) updates.enabled = input.enabled;

      return db
        .update(memoryBindings)
        .set(updates)
        .where(eq(memoryBindings.id, existing.id))
        .returning()
        .then((rows) => rows[0]);
    },

    listOperations: async (companyId: string, filter: MemoryOperationsFilter = {}) => {
      const conditions = [eq(memoryOperations.companyId, companyId)];
      if (filter.agentId) conditions.push(eq(memoryOperations.agentId, filter.agentId));
      if (filter.from) conditions.push(gte(memoryOperations.occurredAt, filter.from));
      if (filter.to) conditions.push(lte(memoryOperations.occurredAt, filter.to));

      if (filter.bindingKey) {
        const binding = await db
          .select({ id: memoryBindings.id })
          .from(memoryBindings)
          .where(and(eq(memoryBindings.companyId, companyId), eq(memoryBindings.bindingKey, filter.bindingKey)))
          .then((rows) => rows[0] ?? null);
        if (binding) {
          conditions.push(eq(memoryOperations.bindingId, binding.id));
        }
      }

      return db
        .select()
        .from(memoryOperations)
        .where(and(...conditions))
        .orderBy(desc(memoryOperations.occurredAt))
        .limit(filter.limit ?? 100)
        .offset(filter.offset ?? 0);
    },
  };
}
