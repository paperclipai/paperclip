import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryBindings, memoryOperations } from "@paperclipai/db";
import type {
  MemoryAdapter,
  MemoryWriteRequest,
  MemoryQueryRequest,
  MemoryRecordHandle,
  MemoryScope,
  MemoryUsage,
  MemoryContextBundle,
} from "@paperclipai/plugin-sdk";
import { notFound, badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// In-memory adapter registry — plugins register adapters at startup, the
// operations service resolves them by providerKey at call time.
// ---------------------------------------------------------------------------

const adapterRegistry = new Map<string, MemoryAdapter>();

export function registerMemoryAdapter(adapter: MemoryAdapter) {
  adapterRegistry.set(adapter.key, adapter);
}

export function unregisterMemoryAdapter(key: string) {
  adapterRegistry.delete(key);
}

export function getRegisteredMemoryAdapters(): string[] {
  return [...adapterRegistry.keys()];
}

export function getMemoryAdapter(key: string): MemoryAdapter | undefined {
  return adapterRegistry.get(key);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function memoryOperationService(db: Db) {
  /** Look up the binding row and resolve its adapter. */
  async function resolveBinding(bindingId: string) {
    const binding = await db
      .select()
      .from(memoryBindings)
      .where(eq(memoryBindings.id, bindingId))
      .then((rows) => rows[0] ?? null);

    if (!binding) throw notFound("Memory binding not found");
    if (!binding.enabled) throw badRequest("Memory binding is disabled");

    const adapter = adapterRegistry.get(binding.providerKey);
    if (!adapter) {
      throw badRequest(
        `No memory adapter registered for provider "${binding.providerKey}"`,
      );
    }

    return { binding, adapter };
  }

  /** Persist an operation log row. */
  async function logOperation(params: {
    companyId: string;
    bindingId: string;
    operationType: string;
    scope: MemoryScope;
    usage?: MemoryUsage[];
    latencyMs: number;
    success: boolean;
    error?: string;
    sourceRef?: Record<string, unknown>;
  }) {
    await db.insert(memoryOperations).values({
      companyId: params.companyId,
      bindingId: params.bindingId,
      operationType: params.operationType,
      agentId: params.scope.agentId ?? null,
      projectId: params.scope.projectId ?? null,
      issueId: params.scope.issueId ?? null,
      runId: params.scope.runId ?? null,
      sourceRef: params.sourceRef ?? null,
      usage: params.usage ?? null,
      latencyMs: params.latencyMs,
      success: params.success,
      error: params.error ?? null,
    });
  }

  return {
    // ── Write ──────────────────────────────────────────────────────────

    write: async (
      bindingId: string,
      body: {
        scope: MemoryScope;
        source: MemoryWriteRequest["source"];
        content: string;
        metadata?: Record<string, unknown>;
        mode?: "append" | "upsert" | "summarize";
      },
    ) => {
      const { binding, adapter } = await resolveBinding(bindingId);

      const req: MemoryWriteRequest = {
        bindingKey: binding.key,
        scope: body.scope,
        source: body.source,
        content: body.content,
        metadata: body.metadata,
        mode: body.mode,
      };

      const start = Date.now();
      try {
        const result = await adapter.write(req);
        const latencyMs = Date.now() - start;

        logOperation({
          companyId: binding.companyId,
          bindingId: binding.id,
          operationType: "write",
          scope: body.scope,
          usage: result.usage,
          latencyMs,
          success: true,
          sourceRef: body.source as unknown as Record<string, unknown>,
        }).catch((err) => { logger.warn({ err }, "failed to log memory write operation"); });

        return { records: result.records ?? [], usage: result.usage ?? [], latencyMs };
      } catch (err) {
        const latencyMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);

        await logOperation({
          companyId: binding.companyId,
          bindingId: binding.id,
          operationType: "write",
          scope: body.scope,
          latencyMs,
          success: false,
          error: message,
          sourceRef: body.source as unknown as Record<string, unknown>,
        }).catch((err) => { logger.warn({ err }, "failed to log memory operation"); });

        throw err;
      }
    },

    // ── Query ─────────────────────────────────────────────────────────

    query: async (
      bindingId: string,
      body: {
        scope: MemoryScope;
        query: string;
        topK?: number;
        intent?: "agent_preamble" | "answer" | "browse";
        metadataFilter?: Record<string, unknown>;
      },
    ) => {
      const { binding, adapter } = await resolveBinding(bindingId);

      const req: MemoryQueryRequest = {
        bindingKey: binding.key,
        scope: body.scope,
        query: body.query,
        topK: body.topK,
        intent: body.intent,
        metadataFilter: body.metadataFilter,
      };

      const start = Date.now();
      try {
        const result: MemoryContextBundle = await adapter.query(req);
        const latencyMs = Date.now() - start;

        logOperation({
          companyId: binding.companyId,
          bindingId: binding.id,
          operationType: "query",
          scope: body.scope,
          usage: result.usage,
          latencyMs,
          success: true,
        }).catch((err) => { logger.warn({ err }, "failed to log memory query operation"); });

        return { ...result, latencyMs };
      } catch (err) {
        const latencyMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);

        await logOperation({
          companyId: binding.companyId,
          bindingId: binding.id,
          operationType: "query",
          scope: body.scope,
          latencyMs,
          success: false,
          error: message,
        }).catch((err2) => { logger.warn({ err: err2 }, "failed to log memory query operation"); });

        throw err;
      }
    },

    // ── Forget ────────────────────────────────────────────────────────

    forget: async (
      bindingId: string,
      body: {
        scope: MemoryScope;
        handles: MemoryRecordHandle[];
      },
    ) => {
      const { binding, adapter } = await resolveBinding(bindingId);

      const start = Date.now();
      try {
        const result = await adapter.forget(body.handles, body.scope);
        const latencyMs = Date.now() - start;

        logOperation({
          companyId: binding.companyId,
          bindingId: binding.id,
          operationType: "forget",
          scope: body.scope,
          usage: result.usage,
          latencyMs,
          success: true,
        }).catch((err) => { logger.warn({ err }, "failed to log memory forget operation"); });

        return { usage: result.usage ?? [], latencyMs };
      } catch (err) {
        const latencyMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);

        await logOperation({
          companyId: binding.companyId,
          bindingId: binding.id,
          operationType: "forget",
          scope: body.scope,
          latencyMs,
          success: false,
          error: message,
        }).catch((err2) => { logger.warn({ err: err2 }, "failed to log memory forget operation"); });

        throw err;
      }
    },
  };
}
