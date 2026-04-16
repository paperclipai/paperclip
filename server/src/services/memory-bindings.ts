import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryBindings, memoryBindingTargets } from "@paperclipai/db";
import type { CreateMemoryBinding, UpdateMemoryBinding, CreateMemoryBindingTarget } from "@paperclipai/shared";

export function memoryBindingService(db: Db) {
  return {
    // ── Bindings ──────────────────────────────────────────────────────

    list: async (companyId: string) => {
      return db
        .select()
        .from(memoryBindings)
        .where(eq(memoryBindings.companyId, companyId));
    },

    getById: async (id: string) => {
      return db
        .select()
        .from(memoryBindings)
        .where(eq(memoryBindings.id, id))
        .then((rows) => rows[0] ?? null);
    },

    create: async (companyId: string, data: CreateMemoryBinding) => {
      return db
        .insert(memoryBindings)
        .values({
          companyId,
          key: data.key,
          providerKey: data.providerKey,
          pluginId: data.pluginId ?? null,
          config: data.config ?? {},
          capabilities: data.capabilities ?? {},
          enabled: data.enabled ?? true,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    update: async (id: string, data: UpdateMemoryBinding) => {
      const sets: Record<string, unknown> = { updatedAt: new Date() };
      if (data.key !== undefined) sets.key = data.key;
      if (data.providerKey !== undefined) sets.providerKey = data.providerKey;
      if (data.pluginId !== undefined) sets.pluginId = data.pluginId;
      if (data.config !== undefined) sets.config = data.config;
      if (data.capabilities !== undefined) sets.capabilities = data.capabilities;
      if (data.enabled !== undefined) sets.enabled = data.enabled;

      return db
        .update(memoryBindings)
        .set(sets)
        .where(eq(memoryBindings.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: async (id: string) => {
      return db
        .delete(memoryBindings)
        .where(eq(memoryBindings.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    // ── Binding Targets ──────────────────────────────────────────────

    listTargets: async (bindingId: string) => {
      return db
        .select()
        .from(memoryBindingTargets)
        .where(eq(memoryBindingTargets.bindingId, bindingId));
    },

    addTarget: async (bindingId: string, data: CreateMemoryBindingTarget) => {
      return db
        .insert(memoryBindingTargets)
        .values({
          bindingId,
          targetType: data.targetType,
          targetId: data.targetId,
          priority: data.priority ?? 0,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    getTargetById: async (targetId: string) => {
      return db
        .select()
        .from(memoryBindingTargets)
        .where(eq(memoryBindingTargets.id, targetId))
        .then((rows) => rows[0] ?? null);
    },

    removeTarget: async (targetId: string) => {
      return db
        .delete(memoryBindingTargets)
        .where(eq(memoryBindingTargets.id, targetId))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  };
}
