/**
 * Plugin hook registry — Phase 1b. See server/src/services/plugin-hooks for
 * the per-file responsibilities.
 *
 * The module is intentionally side-effect free. No call-site uses these
 * exports yet (Phase 2 — MYO-63 wires them into `buildPaperclipWakePayload`
 * and `resolvePaperclipDesiredSkillNames`).
 */

export {
  createPluginHookRegistry,
  type PluginHookRegistry,
  type PluginHookRegistryOptions,
  type PluginEnabledForCompanyFn,
  type HooksEnabledForCompanyFn,
  type ManifestHookDeclarations,
  type PluginLifecycleSubset,
} from "./registry.js";

export {
  applyWakePayloadTransformers,
  applySkillResolverTransformers,
  applyRuntimeEnvProviderHooks,
  DEFAULT_WAKE_BUDGET_MS,
  DEFAULT_SKILL_BUDGET_MS,
  DEFAULT_RUNTIME_ENV_BUDGET_MS,
  type ApplyOptions,
  type HookErrorEvent,
  type HookSkipEvent,
} from "./apply.js";

export { evaluateWhen, type PredicateContext } from "./predicates.js";

export {
  createTelemetrySink,
  NOOP_SINK,
  type HookTelemetrySink,
  type MinimalTelemetryClient,
} from "./metrics.js";

export type {
  PluginHookEntry,
  PluginHookErrorReason,
  PluginHookHandlerMap,
  PluginHookIssueContext,
  PluginHookKind,
  PluginHookManifestEntry,
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
  WhenPredicate,
} from "./types.js";

export { EMPTY_RUNTIME_ENV_RESULT } from "./types.js";
