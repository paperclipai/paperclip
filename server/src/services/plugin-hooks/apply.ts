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
  RuntimeEnvProvider,
  RuntimeEnvProviderContext,
  RuntimeEnvProviderResult,
  RuntimeFileSpec,
  SkillResolverResult,
  SkillResolverTransformer,
  SkillResolverTransformerContext,
  WakePayload,
  WakePayloadTransformer,
  WakePayloadTransformerContext,
} from "./types.js";
import { EMPTY_RUNTIME_ENV_RESULT } from "./types.js";
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
/**
 * Default total budget for the runtime-env-provider chain — see issue MYO-80.
 *
 * Sized larger than the wake/skill chains because runtime env providers may
 * legitimately fetch a fresh PAT or read a secret store before each spawn.
 * The host calls this once per heartbeat (not on every wake-payload build),
 * so a wider budget does not add per-message overhead.
 */
export const DEFAULT_RUNTIME_ENV_BUDGET_MS = 200;
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

/**
 * Apply the runtime-env-provider chain. Returns the merged env + runtimeFiles
 * the host should inject before spawning the agent process.
 *
 * Each hook receives the previous result and must return a new
 * {@link RuntimeEnvProviderResult}. Conflicts on the same env key resolve
 * last-write-wins. Files are keyed by `path`; later hooks overwrite earlier
 * entries.
 *
 * Hooks that return invalid env keys, absolute paths, or paths that escape
 * the run directory are dropped with a `runtime_file_rejected` /
 * `handler_returned_invalid` telemetry record — the chain continues with the
 * previous result so a single bad plugin cannot break the whole heartbeat.
 */
export async function applyRuntimeEnvProviderHooks(
  registry: PluginHookRegistry,
  context: RuntimeEnvProviderContext,
  options: ApplyOptions = {},
): Promise<RuntimeEnvProviderResult> {
  if (!registry.isEnabled || registry.size() === 0) return EMPTY_RUNTIME_ENV_RESULT;

  const entries = await registry.list("runtimeEnvProvider", {
    companyId: context.issue.companyId,
  });
  if (entries.length === 0) return EMPTY_RUNTIME_ENV_RESULT;

  return runChain<RuntimeEnvProviderResult>({
    entries,
    initial: EMPTY_RUNTIME_ENV_RESULT,
    runHandler: (entry, current) =>
      (entry.handler as RuntimeEnvProvider)(current, context),
    validateResult: (result, current) => mergeRuntimeEnvResult(result, current, options),
    issue: context.issue,
    agentRole: context.agentRole,
    options,
    defaultBudgetMs: DEFAULT_RUNTIME_ENV_BUDGET_MS,
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

/**
 * Allowed characters in a runtime env var name. Mirrors the POSIX-portable
 * subset (letter / digit / underscore, not starting with a digit) so the
 * value is safe across spawn implementations on every supported platform.
 */
const RUNTIME_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Default file mode applied when a runtimeEnvProvider hook omits it. */
const DEFAULT_RUNTIME_FILE_MODE = 0o600;

/**
 * Validate and merge a `runtimeEnvProvider` hook return value into the
 * accumulated result. Returns `undefined` (treated as "invalid result") when
 * the shape is wrong; returns the new accumulated result when the shape is
 * acceptable. Per-key / per-file rejections are silent at this layer — they
 * are surfaced via `options.onError` so plugin authors can see them in the
 * dev/CI log without poisoning the chain.
 */
function mergeRuntimeEnvResult(
  result: unknown,
  current: RuntimeEnvProviderResult,
  options: ApplyOptions,
): RuntimeEnvProviderResult | undefined {
  if (!isPlainObject(result)) return undefined;
  const next = result as { env?: unknown; runtimeFiles?: unknown };
  if (next.env !== undefined && !isPlainObject(next.env)) return undefined;
  if (next.runtimeFiles !== undefined && !Array.isArray(next.runtimeFiles)) {
    return undefined;
  }

  const env: Record<string, string> = { ...current.env };
  if (isPlainObject(next.env)) {
    for (const [key, value] of Object.entries(next.env)) {
      if (typeof value !== "string") return undefined;
      if (!RUNTIME_ENV_KEY_PATTERN.test(key)) return undefined;
      env[key] = value;
    }
  }

  const filesByPath = new Map<string, RuntimeFileSpec>();
  for (const f of current.runtimeFiles ?? []) filesByPath.set(f.path, f);

  if (Array.isArray(next.runtimeFiles)) {
    for (const candidate of next.runtimeFiles) {
      const validated = validateRuntimeFile(candidate);
      if (!validated) {
        options.onError?.({
          hook: "runtimeEnvProvider",
          pluginId: "<unknown>",
          pluginKey: "<unknown>",
          reason: "runtime_file_rejected",
          durationMs: 0,
        });
        continue;
      }
      filesByPath.set(validated.path, validated);
    }
  }

  const runtimeFiles = filesByPath.size === 0 ? undefined : Array.from(filesByPath.values());
  return runtimeFiles ? { env, runtimeFiles } : { env };
}

/**
 * Reject any path that escapes the run dir. The host writes files at
 * `<runDir>/<path>`; a hook that hands us `..`, `/etc/passwd`, or a Windows
 * drive letter must be dropped. The check is intentionally strict because
 * a single bypass here lets a plugin write arbitrary files into the host.
 */
function validateRuntimeFile(candidate: unknown): RuntimeFileSpec | null {
  if (!isPlainObject(candidate)) return null;
  const c = candidate as { path?: unknown; content?: unknown; mode?: unknown };
  if (typeof c.path !== "string" || c.path.length === 0) return null;
  if (typeof c.content !== "string") return null;

  const path = c.path;
  // Reject absolute paths (POSIX + Windows) and any backslash-style traversal.
  if (path.startsWith("/") || path.startsWith("\\")) return null;
  if (/^[A-Za-z]:[\\/]/.test(path)) return null;

  const segments = path.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === "." || segment === "..") return null;
    if (segment.includes("\0")) return null;
  }

  let mode: number | undefined = DEFAULT_RUNTIME_FILE_MODE;
  if (c.mode !== undefined) {
    if (typeof c.mode !== "number" || !Number.isFinite(c.mode) || c.mode < 0) {
      return null;
    }
    // Clamp to the 12 mode bits a POSIX file can carry. Anything outside is
    // either a programmer mistake or an attempt to flip setuid/sticky bits.
    mode = Math.floor(c.mode) & 0o7777;
  }

  return { path: segments.join("/"), content: c.content, mode };
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
