/**
 * `@paperclipai/plugin-sdk/hooks` — plugin hook contract types (Phase 1a).
 *
 * Plugin authors import these types from `@paperclipai/plugin-sdk` to
 * implement wake-payload and skill-resolver transformer hooks. The canonical
 * type definitions live in `@paperclipai/shared` so the host runtime, the
 * registry layer, and the SDK consume the exact same shape.
 *
 * Phase 1a is types-only: this file does not run any code. Registration of
 * handlers will be wired in MYO-50.2 (registry) and MYO-50.3 (core
 * call-sites). MYO-50.4 ships the first real plugin against this contract.
 *
 * @example
 * ```ts
 * import type {
 *   WakePayloadTransformer,
 *   WakePayloadTransformerContext,
 * } from "@paperclipai/plugin-sdk";
 *
 * export const myWakeTransformer: WakePayloadTransformer = (
 *   payload,
 *   ctx: WakePayloadTransformerContext,
 * ) => {
 *   if (ctx.issue.fields.fastAction === true) {
 *     return { ...payload, mode: "fast" };
 *   }
 *   return payload;
 * };
 * ```
 *
 * @see PLUGIN_SPEC.md — Plugin hooks (Phase 1a)
 */

export type {
  PluginHookIssueContext,
  WakePayloadTransformerContext,
  SkillResolverTransformerContext,
  WakePayload,
  WakePayloadTransformer,
  SkillResolverResult,
  SkillResolverTransformer,
  WhenPredicate,
  PluginHookManifestEntry,
  PluginHooksDeclaration,
  PluginHookKind,
  PluginHookHandlerMap,
} from "@paperclipai/shared";
