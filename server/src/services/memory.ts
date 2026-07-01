import type { Db } from "@paperclipai/db";
import type {
  IngestMemory,
  MemoryBrowseFilters as MemoryBrowseFiltersValidated,
  SearchMemory,
} from "@paperclipai/shared";
import { activityService } from "./activity.js";
import { localMemoryProvider } from "./memory-providers/local-memory-provider.js";

export interface MemoryActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
}

export interface MemoryBrowseFilters {
  companyId: string;
  projectId?: string | null;
  goalId?: string | null;
  key?: string;
  tags?: string[];
  limit?: number;
}

export function memoryService(db: Db) {
  const provider = localMemoryProvider(db);
  const activity = activityService(db);

  return {
    ingest: async (companyId: string, input: IngestMemory, actor: MemoryActor) => {
      const entry = await provider.ingest({
        companyId,
        projectId: input.projectId ?? null,
        goalId: input.goalId ?? null,
        key: input.key,
        title: input.title ?? null,
        body: input.body,
        tags: input.tags ?? [],
        source: input.source ?? null,
      });

      await activity.create({
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "memory.ingested",
        entityType: "memory_entry",
        entityId: entry.id,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
        details: { key: entry.key, projectId: entry.projectId, goalId: entry.goalId },
      });

      return entry;
    },

    search: (companyId: string, input: SearchMemory) =>
      provider.search({
        companyId,
        query: input.query,
        projectId: input.projectId ?? null,
        goalId: input.goalId ?? null,
        key: input.key,
        tags: input.tags,
        limit: input.limit,
      }),

    get: (companyId: string, idOrKey: string) => provider.get(companyId, idOrKey),

    browse: (filters: MemoryBrowseFiltersValidated | MemoryBrowseFilters) =>
      provider.browse({
        companyId: filters.companyId,
        projectId: filters.projectId ?? null,
        goalId: filters.goalId ?? null,
        key: filters.key,
        tags: filters.tags,
        limit: filters.limit,
      }),

    forget: async (companyId: string, id: string, actor: MemoryActor) => {
      await provider.forget(companyId, id);

      await activity.create({
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "memory.forgotten",
        entityType: "memory_entry",
        entityId: id,
        agentId: actor.agentId ?? null,
        runId: actor.runId ?? null,
        details: null,
      });
    },

    usage: (companyId: string) => provider.usage(companyId),
  };
}
