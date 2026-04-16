import { and, eq, inArray, or, asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memoryBindings, memoryBindingTargets, memoryOperations } from "@paperclipai/db";
import type {
  MemoryAdapter,
  MemoryScope,
  MemoryContextBundle,
  MemorySnippet,
  MemoryUsage,
} from "@paperclipai/plugin-sdk";
import { getMemoryAdapter } from "./memory-operations.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Hook configuration types
//
// Hook config lives inside the binding's `config` jsonb under the `hooks` key.
// Example binding config:
// {
//   "hooks": {
//     "preRunHydrate": { "enabled": true, "topK": 5 },
//     "postRunCapture": { "enabled": true, "captureDepth": "summary" }
//   }
// }
// ---------------------------------------------------------------------------

export interface PreRunHydrateHookConfig {
  enabled: boolean;
  /** Max snippets to retrieve (default: 5). */
  topK?: number;
}

export interface PostRunCaptureHookConfig {
  enabled: boolean;
  /** What to capture: "summary" (issue title + outcome) or "full" (include run result). Default: "summary". */
  captureDepth?: "summary" | "full";
}

export interface MemoryHooksConfig {
  preRunHydrate?: PreRunHydrateHookConfig;
  postRunCapture?: PostRunCaptureHookConfig;
}

/** Parsed binding with resolved hook config. */
interface ResolvedBinding {
  bindingId: string;
  bindingKey: string;
  providerKey: string;
  config: Record<string, unknown>;
  hooks: MemoryHooksConfig;
  adapter: MemoryAdapter;
  targetPriority: number;
}

// ---------------------------------------------------------------------------
// Binding resolution
// ---------------------------------------------------------------------------

/**
 * Resolve all enabled memory bindings that target a given agent or its company,
 * ordered by target priority (lower = higher priority, agent-scoped first).
 *
 * Returns only bindings whose adapter is currently registered.
 */
async function resolveBindingsForAgent(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<ResolvedBinding[]> {
  const targets = await db
    .select({
      bindingId: memoryBindingTargets.bindingId,
      targetType: memoryBindingTargets.targetType,
      targetId: memoryBindingTargets.targetId,
      priority: memoryBindingTargets.priority,
    })
    .from(memoryBindingTargets)
    .where(
      or(
        and(
          eq(memoryBindingTargets.targetType, "agent"),
          eq(memoryBindingTargets.targetId, agentId),
        ),
        and(
          eq(memoryBindingTargets.targetType, "company"),
          eq(memoryBindingTargets.targetId, companyId),
        ),
      ),
    )
    .orderBy(asc(memoryBindingTargets.priority));

  if (targets.length === 0) return [];

  const bindingIds = [...new Set(targets.map((t) => t.bindingId))];
  const bindings = await db
    .select()
    .from(memoryBindings)
    .where(
      and(
        inArray(memoryBindings.id, bindingIds),
        eq(memoryBindings.companyId, companyId),
        eq(memoryBindings.enabled, true),
      ),
    );

  const bindingMap = new Map(bindings.map((b) => [b.id, b]));

  const resolved: ResolvedBinding[] = [];
  const seenBindings = new Set<string>();

  for (const target of targets) {
    if (seenBindings.has(target.bindingId)) continue;
    seenBindings.add(target.bindingId);

    const binding = bindingMap.get(target.bindingId);
    if (!binding) continue;

    const adapter = getMemoryAdapter(binding.providerKey);
    if (!adapter) continue;

    const config = (binding.config ?? {}) as Record<string, unknown>;
    const rawHooks = config.hooks;
    const hooks: MemoryHooksConfig =
      rawHooks && typeof rawHooks === "object" && !Array.isArray(rawHooks)
        ? (rawHooks as MemoryHooksConfig)
        : {};

    resolved.push({
      bindingId: binding.id,
      bindingKey: binding.key,
      providerKey: binding.providerKey,
      config,
      hooks,
      adapter,
      targetPriority: target.priority,
    });
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Pre-run hydration
// ---------------------------------------------------------------------------

export interface HydrateRunContextParams {
  companyId: string;
  agentId: string;
  projectId?: string;
  issueId?: string;
  runId: string;
  /** Issue title or task summary — used as the query for semantic search. */
  taskSummary?: string;
}

export interface HydrateRunContextResult {
  /** Combined snippets from all bindings, ready for injection into context. */
  snippets: MemorySnippet[];
  /** Profile summary from the first binding that provides one. */
  profileSummary?: string;
  /** Aggregated usage across all bindings. */
  usage: MemoryUsage[];
  /** How many bindings were queried. */
  bindingsQueried: number;
}

/**
 * Query all applicable memory bindings with preRunHydrate enabled
 * and return combined context snippets for injection into the run.
 */
async function hydrateRunContext(
  db: Db,
  params: HydrateRunContextParams,
): Promise<HydrateRunContextResult> {
  const bindings = await resolveBindingsForAgent(db, params.companyId, params.agentId);

  const hydrateBindings = bindings.filter(
    (b) => b.hooks.preRunHydrate?.enabled === true,
  );

  if (hydrateBindings.length === 0) {
    return { snippets: [], usage: [], bindingsQueried: 0 };
  }

  const scope: MemoryScope = {
    companyId: params.companyId,
    agentId: params.agentId,
    projectId: params.projectId,
    issueId: params.issueId,
    runId: params.runId,
  };

  const query = params.taskSummary ?? "agent context";

  const allSnippets: MemorySnippet[] = [];
  const allUsage: MemoryUsage[] = [];
  let profileSummary: string | undefined;
  let bindingsQueried = 0;

  for (const binding of hydrateBindings) {
    const topK = binding.hooks.preRunHydrate?.topK ?? 5;

    const adapterStart = Date.now();
    try {
      const result: MemoryContextBundle = await binding.adapter.query({
        bindingKey: binding.bindingKey,
        scope,
        query,
        topK,
      });
      const adapterLatencyMs = Date.now() - adapterStart;

      allSnippets.push(...result.snippets);
      if (result.usage) allUsage.push(...result.usage);
      if (!profileSummary && result.profileSummary) {
        profileSummary = result.profileSummary;
      }
      bindingsQueried++;

      await logHookOperation(db, {
        companyId: params.companyId,
        bindingId: binding.bindingId,
        operationType: "query",
        scope,
        usage: result.usage,
        latencyMs: adapterLatencyMs,
        success: true,
        hookName: "preRunHydrate",
      }).catch((err) => { logger.warn({ err }, "failed to log memory hook operation"); });
    } catch (err) {
      const adapterLatencyMs = Date.now() - adapterStart;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          companyId: params.companyId,
          agentId: params.agentId,
          runId: params.runId,
          bindingKey: binding.bindingKey,
          error: message,
        },
        "memory hydration failed for binding — skipping",
      );

      await logHookOperation(db, {
        companyId: params.companyId,
        bindingId: binding.bindingId,
        operationType: "query",
        scope,
        latencyMs: adapterLatencyMs,
        success: false,
        error: message,
        hookName: "preRunHydrate",
      }).catch((err) => { logger.warn({ err }, "failed to log memory hook operation"); });
    }
  }

  return { snippets: allSnippets, profileSummary, usage: allUsage, bindingsQueried };
}

// ---------------------------------------------------------------------------
// Post-run capture
// ---------------------------------------------------------------------------

export interface CaptureRunResultParams {
  companyId: string;
  agentId: string;
  projectId?: string;
  issueId?: string;
  runId: string;
  /** Run outcome: succeeded, failed, timed_out, cancelled. */
  outcome: string;
  /** Issue title or task summary. */
  taskSummary?: string;
  /** Structured run result (from adapter). */
  resultJson?: Record<string, unknown> | null;
  /** Agent name for readable summaries. */
  agentName?: string;
}

export interface CaptureRunResultResult {
  /** Number of bindings that received captured content. */
  bindingsCaptured: number;
  /** Aggregated usage across all captures. */
  usage: MemoryUsage[];
}

/**
 * After a run completes, capture a summary of what happened into all
 * applicable memory bindings with postRunCapture enabled.
 */
async function captureRunResult(
  db: Db,
  params: CaptureRunResultParams,
): Promise<CaptureRunResultResult> {
  const bindings = await resolveBindingsForAgent(db, params.companyId, params.agentId);

  const captureBindings = bindings.filter(
    (b) => b.hooks.postRunCapture?.enabled === true,
  );

  if (captureBindings.length === 0) {
    return { bindingsCaptured: 0, usage: [] };
  }

  const scope: MemoryScope = {
    companyId: params.companyId,
    agentId: params.agentId,
    projectId: params.projectId,
    issueId: params.issueId,
    runId: params.runId,
  };

  const allUsage: MemoryUsage[] = [];
  let bindingsCaptured = 0;

  for (const binding of captureBindings) {
    const captureDepth = binding.hooks.postRunCapture?.captureDepth ?? "summary";
    const content = buildCaptureContent(params, captureDepth);

    const adapterStart = Date.now();
    try {
      const result = await binding.adapter.write({
        bindingKey: binding.bindingKey,
        scope,
        source: {
          kind: "run",
          companyId: params.companyId,
          runId: params.runId,
          issueId: params.issueId,
        },
        content,
        mode: "append",
      });
      const adapterLatencyMs = Date.now() - adapterStart;

      if (result.usage) allUsage.push(...result.usage);
      bindingsCaptured++;

      await logHookOperation(db, {
        companyId: params.companyId,
        bindingId: binding.bindingId,
        operationType: "write",
        scope,
        usage: result.usage,
        latencyMs: adapterLatencyMs,
        success: true,
        hookName: "postRunCapture",
      }).catch((err) => { logger.warn({ err }, "failed to log memory hook operation"); });
    } catch (err) {
      const adapterLatencyMs = Date.now() - adapterStart;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          companyId: params.companyId,
          agentId: params.agentId,
          runId: params.runId,
          bindingKey: binding.bindingKey,
          error: message,
        },
        "memory capture failed for binding — skipping",
      );

      await logHookOperation(db, {
        companyId: params.companyId,
        bindingId: binding.bindingId,
        operationType: "write",
        scope,
        latencyMs: adapterLatencyMs,
        success: false,
        error: message,
        hookName: "postRunCapture",
      }).catch((err) => { logger.warn({ err }, "failed to log memory hook operation"); });
    }
  }

  return { bindingsCaptured, usage: allUsage };
}

// ---------------------------------------------------------------------------
// Capture content builder
// ---------------------------------------------------------------------------

function buildCaptureContent(
  params: CaptureRunResultParams,
  depth: "summary" | "full",
): string {
  const lines: string[] = [];

  lines.push(`## Run ${params.outcome}`);
  if (params.agentName) lines.push(`Agent: ${params.agentName}`);
  if (params.taskSummary) lines.push(`Task: ${params.taskSummary}`);
  lines.push(`Run: ${params.runId}`);
  if (params.issueId) lines.push(`Issue: ${params.issueId}`);
  lines.push(`Outcome: ${params.outcome}`);
  lines.push(`Captured: ${new Date().toISOString()}`);

  if (depth === "full" && params.resultJson) {
    lines.push("");
    lines.push("### Result");
    const resultStr = JSON.stringify(params.resultJson, null, 2);
    const maxLen = 4000;
    if (resultStr.length > maxLen) {
      lines.push("```");
      lines.push(resultStr.slice(0, maxLen));
      lines.push("```");
      lines.push(`(truncated — ${resultStr.length} chars total)`);
    } else {
      lines.push(resultStr);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Operation logging helper
// ---------------------------------------------------------------------------

async function logHookOperation(
  db: Db,
  params: {
    companyId: string;
    bindingId: string;
    operationType: string;
    scope: MemoryScope;
    usage?: MemoryUsage[];
    latencyMs: number;
    success: boolean;
    error?: string;
    hookName: string;
  },
) {
  await db.insert(memoryOperations).values({
    companyId: params.companyId,
    bindingId: params.bindingId,
    operationType: params.operationType,
    agentId: params.scope.agentId ?? null,
    projectId: params.scope.projectId ?? null,
    issueId: params.scope.issueId ?? null,
    runId: params.scope.runId ?? null,
    sourceRef: { hook: params.hookName },
    usage: params.usage ?? null,
    latencyMs: params.latencyMs,
    success: params.success,
    error: params.error ?? null,
  });
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function memoryHooksService(db: Db) {
  return {
    resolveBindingsForAgent: (companyId: string, agentId: string) =>
      resolveBindingsForAgent(db, companyId, agentId),

    hydrateRunContext: (params: HydrateRunContextParams) =>
      hydrateRunContext(db, params),

    captureRunResult: (params: CaptureRunResultParams) =>
      captureRunResult(db, params),
  };
}
