/**
 * Apply layer for plugin hooks.
 *
 * Each hook kind has its own `apply...Transformers()` entry point that:
 *  1. Pulls the registered entries from the registry (already filtered by
 *     company eligibility + global feature flag).
 *  2. Iterates them in priority order, evaluating the `when` predicate.
 *  3. Runs each handler with a per-call budget; stops dispatching new hooks
 *     once the cumulative budget is exhausted (in-flight hooks still
 *     complete).
 *  4. Isolates handler errors — a thrown / timed-out / invalid-result hook
 *     drops its contribution but never aborts the chain.
 *  5. Emits telemetry for applied/skipped/error outcomes.
 *
 * No call-site wires this in yet (Phase 2 — MYO-63). The signatures are
 * shaped so call-sites can drop them in as a tail step:
 *
 * ```ts
 * payload = await applyWakePayloadTransformers(registry, payload, ctx);
 * ```
 */

import type {
  PluginHookEntry,
  PluginHookErrorReason,
  PluginHookIssueContext,
  PluginHookSkipReason,
  SkillResolverResult,
  SkillResolverTransformer,
  SkillResolverTransformerContext,
  WakePayload,
  WakePayloadTransformer,
  WakePayloadTransformerContext,
} from "./types.js";
import { evaluateWhen } from "./predicates.js";
import {
  NOOP_SINK,
  createTelemetrySink,
  type HookTelemetrySink,
  type MinimalTelemetryClient,
} from "./metrics.js";
import type { PluginHookRegistry } from "./registry.js";

/** Default total budget for the wake-payload chain — see issue MYO-62. */
export const DEFAULT_WAKE_BUDGET_MS = 50;
/** Default total budget for the skill-resolver chain — see issue MYO-62. */
export const DEFAULT_SKILL_BUDGET_MS = 20;
/** Per-handler timeout safety net (10× the per-call budget). */
const DEFAULT_PER_HANDLER_TIMEOUT_MULTIPLIER = 10;

export interface ApplyOptions {
  /** Total budget in milliseconds for the whole chain. */
  budgetMs?: number;
  /** Per-handler timeout in milliseconds. Defaults to 10× `budgetMs`. */
  perHandlerTimeoutMs?: number;
  telemetry?: HookTelemetrySink | MinimalTelemetryClient | null;
  /** Optional hook-error logger. Defaults to `console.warn`. */
  onError?: (event: HookErrorEvent) => void;
  /** Wall-clock source — overridable for tests. */
  now?: () => number;
}

export interface HookErrorEvent {
  hook: PluginHookEntry["kind"];
  pluginId: string;
  pluginKey: string;
  reason: PluginHookErrorReason;
  durationMs: number;
  error?: unknown;
}

export interface HookSkipEvent {
  hook: PluginHookEntry["kind"];
  pluginId: string;
  pluginKey: string;
  reason: PluginHookSkipReason;
}

const DEFAULT_NOW = () => performance.now();
const SILENT_ERROR_LOG: (event: HookErrorEvent) => void = () => {};

function resolveSink(input: ApplyOptions["telemetry"]): HookTelemetrySink {
  if (!input) return NOOP_SINK;
  if (typeof (input as HookTelemetrySink).recordApplied === "function") {
    return input as HookTelemetrySink;
  }
  return createTelemetrySink(input as MinimalTelemetryClient);
}

/**
 * Apply the wake-payload transformer chain. Returns the (possibly modified)
 * payload. Never throws — handler errors are isolated.
 */
export async function applyWakePayloadTransformers(
  registry: PluginHookRegistry,
  payload: WakePayload,
  context: WakePayloadTransformerContext,
  options: ApplyOptions = {},
): Promise<WakePayload> {
  if (!registry.isEnabled || registry.size() === 0) return payload;

  const entries = await registry.list("wakePayloadTransformer", {
    companyId: context.issue.companyId,
  });
  if (entries.length === 0) return payload;

  return runChain<WakePayload>({
    entries,
    initial: payload,
    runHandler: (entry, current) =>
      (entry.handler as WakePayloadTransformer)(current, context),
    validateResult: (result) => (isPlainObject(result) ? (result as WakePayload) : undefined),
    issue: context.issue,
    agentRole: context.agentRole,
    options,
    defaultBudgetMs: DEFAULT_WAKE_BUDGET_MS,
  });
}

/**
 * Apply the skill-resolver transformer chain. The chain accumulates a
 * `SkillResolverResult`; call-sites can collapse `result.skills` back to a
 * `string[]` after.
 */
export async function applySkillResolverTransformers(
  registry: PluginHookRegistry,
  initial: SkillResolverResult,
  context: SkillResolverTransformerContext,
  options: ApplyOptions = {},
): Promise<SkillResolverResult> {
  if (!registry.isEnabled || registry.size() === 0) return initial;

  const entries = await registry.list("skillResolverTransformer", {
    companyId: context.issue.companyId,
  });
  if (entries.length === 0) return initial;

  return runChain<SkillResolverResult>({
    entries,
    initial,
    runHandler: (entry, current) =>
      (entry.handler as SkillResolverTransformer)(current, context),
    validateResult: (result, current) => normaliseSkillResult(result, current),
    issue: context.issue,
    agentRole: context.agentRole,
    options,
    defaultBudgetMs: DEFAULT_SKILL_BUDGET_MS,
  });
}

interface ChainArgs<T> {
  entries: readonly PluginHookEntry[];
  initial: T;
  runHandler: (entry: PluginHookEntry, current: T) => unknown;
  validateResult: (result: unknown, current: T) => T | undefined;
  issue: PluginHookIssueContext;
  agentRole?: string;
  options: ApplyOptions;
  defaultBudgetMs: number;
}

async function runChain<T>(args: ChainArgs<T>): Promise<T> {
  const now = args.options.now ?? DEFAULT_NOW;
  const sink = resolveSink(args.options.telemetry);
  const onError = args.options.onError ?? SILENT_ERROR_LOG;
  const budgetMs = clampPositive(args.options.budgetMs, args.defaultBudgetMs);
  const perHandlerTimeoutMs = clampPositive(
    args.options.perHandlerTimeoutMs,
    budgetMs * DEFAULT_PER_HANDLER_TIMEOUT_MULTIPLIER,
  );
  const startedAt = now();

  let current = args.initial;

  for (const entry of args.entries) {
    const elapsed = now() - startedAt;
    if (elapsed >= budgetMs) {
      sink.recordSkipped({
        hook: entry.kind,
        pluginId: entry.pluginId,
        pluginKey: entry.pluginKey,
        reason: "budget_exhausted",
      });
      continue;
    }

    const matches = evaluateWhen(entry.when, {
      issue: args.issue,
      agentRole: args.agentRole,
    });
    if (!matches) {
      sink.recordSkipped({
        hook: entry.kind,
        pluginId: entry.pluginId,
        pluginKey: entry.pluginKey,
        reason: "predicate_false",
      });
      continue;
    }

    const handlerStart = now();
    let result: unknown;
    try {
      result = await raceWithTimeout(
        () => Promise.resolve(args.runHandler(entry, current)),
        perHandlerTimeoutMs,
      );
    } catch (err) {
      const reason: PluginHookErrorReason =
        err instanceof HookTimeoutError ? "handler_timed_out" : "handler_threw";
      const durationMs = now() - handlerStart;
      sink.recordError({
        hook: entry.kind,
        pluginId: entry.pluginId,
        pluginKey: entry.pluginKey,
        reason,
        durationMs,
      });
      onError({
        hook: entry.kind,
        pluginId: entry.pluginId,
        pluginKey: entry.pluginKey,
        reason,
        durationMs,
        error: err,
      });
      continue;
    }

    const next = args.validateResult(result, current);
    const handlerDuration = now() - handlerStart;
    if (next === undefined) {
      sink.recordError({
        hook: entry.kind,
        pluginId: entry.pluginId,
        pluginKey: entry.pluginKey,
        reason: "handler_returned_invalid",
        durationMs: handlerDuration,
      });
      onError({
        hook: entry.kind,
        pluginId: entry.pluginId,
        pluginKey: entry.pluginKey,
        reason: "handler_returned_invalid",
        durationMs: handlerDuration,
      });
      continue;
    }
    current = next;
    sink.recordApplied({
      hook: entry.kind,
      pluginId: entry.pluginId,
      pluginKey: entry.pluginKey,
      durationMs: handlerDuration,
    });
  }

  return current;
}

class HookTimeoutError extends Error {
  constructor() {
    super("Plugin hook timed out");
    this.name = "HookTimeoutError";
  }
}

function raceWithTimeout<T>(start: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return start();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new HookTimeoutError());
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    start().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseSkillResult(
  result: unknown,
  current: SkillResolverResult,
): SkillResolverResult | undefined {
  if (Array.isArray(result)) {
    if (!result.every((s) => typeof s === "string")) return undefined;
    return { skills: result.slice() as string[], required: current.required };
  }
  if (!isPlainObject(result)) return undefined;
  const next = result as { skills?: unknown; required?: unknown };
  if (!Array.isArray(next.skills) || !next.skills.every((s) => typeof s === "string")) {
    return undefined;
  }
  if (next.required !== undefined) {
    if (!Array.isArray(next.required) || !next.required.every((s) => typeof s === "string")) {
      return undefined;
    }
  }
  return {
    skills: (next.skills as string[]).slice(),
    required: next.required ? (next.required as string[]).slice() : current.required,
  };
}
