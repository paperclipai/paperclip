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
export type PluginHookKind = "wakePayloadTransformer" | "skillResolverTransformer";

/**
 * Map from {@link PluginHookKind} to the handler signature. Used to keep the
 * registry strongly typed without resorting to per-kind APIs.
 */
export interface PluginHookHandlerMap {
  wakePayloadTransformer: WakePayloadTransformer;
  skillResolverTransformer: SkillResolverTransformer;
}

/**
 * Manifest-declared hook entry. Plugins surface these inside
 * `manifestJson.hooks.{wakePayloadTransformer,skillResolverTransformer}` —
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
  | "handler_timed_out";
