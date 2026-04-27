/**
 * Internal plugin-hook contract types.
 *
 * These mirror the shape that {@link MYO-61}/Phase 1a will export from
 * `@paperclipai/plugin-sdk`. Until that ships, the registry/apply layer uses
 * these locally so MYO-62 can land in isolation. When the SDK contract lands,
 * this file will narrow to a `re-export from "@paperclipai/plugin-sdk"`.
 *
 * Phase 1b only — no call-sites in the core yet (see MYO-63 for integration).
 */

/**
 * Compact, read-only projection of an issue exposed to plugin hooks.
 *
 * The full issue record is intentionally not handed to plugins so that a hook
 * cannot mutate or leak fields the host did not opt-in to share.
 */
export interface PluginHookIssueContext {
  readonly issueId: string;
  readonly companyId: string;
  readonly projectId?: string | null;
  readonly assigneeAgentId?: string | null;
  /**
   * Subset of issue scalar fields the host has opted to expose. Hooks read
   * field values via `issueFieldEquals` predicates; the registry never lets a
   * hook see fields outside this map.
   */
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface WakePayloadTransformerContext {
  readonly issue: PluginHookIssueContext;
  readonly agentId?: string;
  readonly agentRole?: string;
}

export interface SkillResolverTransformerContext {
  readonly issue: PluginHookIssueContext;
  readonly agentId: string;
  readonly agentRole?: string;
}

/**
 * Inputs available to a `runtimeEnvProvider` hook. Exposed to plugins right
 * before an adapter spawns the agent process for a heartbeat. The host calls
 * the chain once per run; the resulting env is injected into the spawned
 * process and runtimeFiles are written into `<runDir>/`.
 *
 * Only the fields needed by adapters to derive a per-run identity / secret
 * are exposed. `adapterConfig` is forwarded as an opaque, read-only view so
 * plugins can branch on adapter-specific settings without mutating them.
 */
export interface RuntimeEnvProviderContext {
  readonly issue: PluginHookIssueContext;
  readonly agentId: string;
  readonly agentRole?: string;
  readonly companyId: string;
  readonly runId: string;
  readonly adapterType: string;
  readonly adapterConfig: Readonly<Record<string, unknown>>;
}

/**
 * Per-file artifact a `runtimeEnvProvider` hook may stage in the run dir.
 *
 * The host writes the file at `<runDir>/<path>` before the process spawns.
 * Plugins return paths relative to the run dir; the apply layer rejects
 * absolute paths and any path that escapes the run dir (e.g. contains `..`).
 *
 * `mode` is an octal POSIX mode (e.g. `0o600` for secrets). Defaults to
 * `0o600` to keep credentials private by default. The host may further
 * tighten this on platforms that do not support the requested bits.
 */
export interface RuntimeFileSpec {
  readonly path: string;
  readonly content: string;
  readonly mode?: number;
}

/**
 * Aggregated contribution of the `runtimeEnvProvider` chain. Each hook is
 * given the previous result and returns a new one — chain semantics mirror
 * the wake-payload chain so plugins compose deterministically.
 *
 * `env` keys must be valid POSIX env names (see `RUNTIME_ENV_KEY_PATTERN`
 * in `apply.ts`). Conflicts are resolved last-write-wins by priority order.
 *
 * `runtimeFiles` is keyed by `path`; later hooks overwrite earlier entries
 * for the same path. Files staged by reserved or invalid paths are dropped
 * with telemetry, never silently merged into a parent path.
 */
export interface RuntimeEnvProviderResult {
  readonly env: Readonly<Record<string, string>>;
  readonly runtimeFiles?: readonly RuntimeFileSpec[];
}

export type RuntimeEnvProvider = (
  current: RuntimeEnvProviderResult,
  context: RuntimeEnvProviderContext,
) => Promise<RuntimeEnvProviderResult> | RuntimeEnvProviderResult;

/**
 * Normalised return shape of a skill-resolver hook so additive/subtractive
 * intent is explicit. The default mapping from `string[]` to this shape is
 * `{ skills, required: [] }`.
 */
export interface SkillResolverResult {
  /** The full ordered skill list after this hook runs. */
  readonly skills: readonly string[];
  /** Subset of `skills` the hook is asserting as required. May be empty. */
  readonly required?: readonly string[];
}

export type WakePayload = Record<string, unknown>;

export type WakePayloadTransformer = (
  payload: WakePayload,
  context: WakePayloadTransformerContext,
) => Promise<WakePayload> | WakePayload;

export type SkillResolverTransformer = (
  current: SkillResolverResult,
  context: SkillResolverTransformerContext,
) => Promise<SkillResolverResult> | SkillResolverResult;

/**
 * Empty seed used by the apply layer when starting a `runtimeEnvProvider`
 * chain. Exported so call-sites and tests share the exact same identity.
 */
export const EMPTY_RUNTIME_ENV_RESULT: RuntimeEnvProviderResult = Object.freeze({
  env: Object.freeze({}) as Readonly<Record<string, string>>,
});

/**
 * Declarative `when` predicate. Plugins describe predicates in their manifest;
 * the registry evaluates them safely without running plugin code (see
 * `predicates.ts`).
 *
 * Supported leaf forms:
 * - `{ issueHasField: "myField" }` — field exists in the exposed projection.
 * - `{ issueFieldEquals: { field, value } }` — strict equality on a scalar.
 * - `{ agentRoleEquals: "founding_engineer" }` — agent role match.
 *
 * Composite forms (all supported recursively):
 * - `{ all: WhenPredicate[] }` — logical AND
 * - `{ any: WhenPredicate[] }` — logical OR
 * - `{ not: WhenPredicate }` — logical NOT
 */
export type WhenPredicate =
  | { readonly issueHasField: string }
  | { readonly issueFieldEquals: { readonly field: string; readonly value: unknown } }
  | { readonly agentRoleEquals: string }
  | { readonly all: readonly WhenPredicate[] }
  | { readonly any: readonly WhenPredicate[] }
  | { readonly not: WhenPredicate };

/** Symbolic name for the supported hook kinds. */
export type PluginHookKind =
  | "wakePayloadTransformer"
  | "skillResolverTransformer"
  | "runtimeEnvProvider";

/**
 * Map from {@link PluginHookKind} to the handler signature. Used to keep the
 * registry strongly typed without resorting to per-kind APIs.
 */
export interface PluginHookHandlerMap {
  wakePayloadTransformer: WakePayloadTransformer;
  skillResolverTransformer: SkillResolverTransformer;
  runtimeEnvProvider: RuntimeEnvProvider;
}

/**
 * Manifest-declared hook entry. Plugins surface these inside
 * `manifestJson.hooks.{wakePayloadTransformer,skillResolverTransformer,runtimeEnvProvider}` —
 * MYO-61 finalises the SDK shape; we match it structurally here.
 */
export interface PluginHookManifestEntry {
  /** Lower number = earlier execution. Must be a finite number. */
  readonly priority?: number;
  /** Optional safe predicate gating the hook. */
  readonly when?: WhenPredicate;
}

/**
 * In-memory hook entry stored by the registry.
 */
export interface PluginHookEntry<K extends PluginHookKind = PluginHookKind> {
  readonly kind: K;
  readonly pluginId: string;
  readonly pluginKey: string;
  readonly priority: number;
  readonly when: WhenPredicate | null;
  readonly handler: PluginHookHandlerMap[K];
}

/**
 * Reason a hook invocation was skipped or aborted. Used by the apply layer to
 * emit precise telemetry without leaking internal state to plugins.
 */
export type PluginHookSkipReason =
  | "predicate_false"
  | "company_disabled"
  | "feature_flag_disabled"
  | "budget_exhausted";

export type PluginHookErrorReason =
  | "handler_threw"
  | "handler_returned_invalid"
  | "handler_timed_out"
  | "runtime_file_rejected";
