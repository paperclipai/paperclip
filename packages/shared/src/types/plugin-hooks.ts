/**
 * Plugin hook contract types — Phase 1a (MYO-50.1 / MYO-61).
 *
 * Canonical types for the wake-payload and skill-resolver transformer hooks
 * that plugins can declare in their manifest and register from their worker
 * setup. The plugin SDK re-exports these from
 * `@paperclipai/plugin-sdk` (`./hooks.ts`); the runtime registry implementation
 * (MYO-62, server-side) consumes the same shape so plugins authored against
 * the SDK match the host's expectations exactly.
 *
 * Phase 1a is types-only: no call-sites in the core, no registry, no plugin
 * implementation. See MYO-50.2 (registry), MYO-50.3 (core integration) and
 * MYO-50.4 (reference plugin) for the rest of the chain.
 */

// ---------------------------------------------------------------------------
// Issue projection exposed to hooks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Hook contexts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Wake payload transformer
// ---------------------------------------------------------------------------

/**
 * Free-form structured payload threaded between wake-payload transformers.
 * Each plugin hook receives the prior payload and returns the next one. The
 * registry rejects non-object returns to keep the chain composable.
 */
export type WakePayload = Record<string, unknown>;

export type WakePayloadTransformer = (
  payload: WakePayload,
  context: WakePayloadTransformerContext,
) => Promise<WakePayload> | WakePayload;

// ---------------------------------------------------------------------------
// Skill resolver transformer
// ---------------------------------------------------------------------------

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

export type SkillResolverTransformer = (
  current: SkillResolverResult,
  context: SkillResolverTransformerContext,
) => Promise<SkillResolverResult> | SkillResolverResult;

// ---------------------------------------------------------------------------
// `when` predicate (declarative; evaluated by the host, not plugin code)
// ---------------------------------------------------------------------------

/**
 * Declarative `when` predicate. Plugins describe predicates in their manifest;
 * the host evaluates them safely without running plugin code.
 *
 * Supported leaf forms:
 * - `{ issueHasField: "myField" }` — field exists in the exposed projection.
 * - `{ issueFieldEquals: { field, value } }` — strict equality on a scalar.
 * - `{ agentRoleEquals: "founding_engineer" }` — agent role match.
 *
 * Composite forms (recursive):
 * - `{ all: WhenPredicate[] }` — logical AND
 * - `{ any: WhenPredicate[] }` — logical OR
 * - `{ not: WhenPredicate }`   — logical NOT
 */
export type WhenPredicate =
  | { readonly issueHasField: string }
  | { readonly issueFieldEquals: { readonly field: string; readonly value: unknown } }
  | { readonly agentRoleEquals: string }
  | { readonly all: readonly WhenPredicate[] }
  | { readonly any: readonly WhenPredicate[] }
  | { readonly not: WhenPredicate };

// ---------------------------------------------------------------------------
// Manifest declaration shape
// ---------------------------------------------------------------------------

/**
 * Manifest-declared hook entry. Plugins surface these inside
 * `manifestJson.hooks.{wakePayloadTransformer,skillResolverTransformer}`.
 *
 * The handler itself is registered at worker boot — manifest only carries
 * declarative metadata (priority, optional `when` predicate) so the host can
 * decide ordering and gating without executing plugin code.
 */
export interface PluginHookManifestEntry {
  /** Lower number = earlier execution. Defaults to 100 when omitted. */
  readonly priority?: number;
  /** Optional safe predicate gating the hook. */
  readonly when?: WhenPredicate;
}

/**
 * Optional `manifest.hooks` block. Plugins declare which hook kinds they
 * provide; both fields are independent and additive.
 */
export interface PluginHooksDeclaration {
  readonly wakePayloadTransformer?: PluginHookManifestEntry;
  readonly skillResolverTransformer?: PluginHookManifestEntry;
}

/** Symbolic name for the supported hook kinds. */
export type PluginHookKind = "wakePayloadTransformer" | "skillResolverTransformer";

/**
 * Map from {@link PluginHookKind} to the handler signature. Useful for
 * registry implementations that want to stay strongly typed without resorting
 * to per-kind APIs.
 */
export interface PluginHookHandlerMap {
  wakePayloadTransformer: WakePayloadTransformer;
  skillResolverTransformer: SkillResolverTransformer;
}
