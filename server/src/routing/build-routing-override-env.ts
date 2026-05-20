/**
 * Phase E1 dispatch helper.
 *
 * Wraps an existing adapter env map with the two HERMES_*_OVERRIDE keys
 * that Patch 5.1 reads in the hermes-paperclip-adapter. Patch 5.1's
 * read site is `const config = (ctx.agent?.adapterConfig ?? {})` —
 * i.e. the adapter reads from `ctx.agent.adapterConfig.env`, not from
 * `ctx.config.env`. The heartbeat dispatcher in services/heartbeat.ts
 * therefore builds an in-memory wrapped agent (same identity, extended
 * adapterConfig.env) and passes it as `agent:` to adapter.execute.
 *
 * The wrap is structural only (no DB writes, no mutation of the
 * persisted agent record): if dispatch crashes after the wrap, no
 * residue is left.
 *
 * Existing env keys (notably ANTHROPIC_API_KEY and HERMES_YOLO_MODE on
 * the pilot) are preserved. The override values use the typed-env
 * wrapper shape Patch 1 + Patch 5.1 expect: `{ type: "plain", value:
 * "..." }`.
 */
import type { IssueComplexity, RoutingTier } from "@paperclipai/shared";

import { resolveTier, type ResolveTierResult } from "./resolve-tier.js";

export interface BuildRoutingOverrideEnvInput {
  /** Issue's complexity column. null/undefined when the run has no issue context. */
  readonly issueComplexity?: IssueComplexity | null;
  /** Agent's tier_preference column. null if the agent hasn't declared one. */
  readonly agentTierPreference?: RoutingTier | null;
  /** Existing adapter env to merge into. null/undefined treated as empty. */
  readonly existingEnv?: Record<string, unknown> | null;
}

export interface BuildRoutingOverrideEnvResult {
  /** Full resolver decision (tier, source, model menu entry). */
  readonly resolution: ResolveTierResult;
  /**
   * New env map: existingEnv spread first, then HERMES_MODEL_OVERRIDE +
   * HERMES_PROVIDER_OVERRIDE added. If a caller had previously set these
   * two keys, the resolver-driven values win (the wrap is the source of
   * truth for the call).
   */
  readonly env: Record<string, unknown>;
}

export function buildRoutingOverrideEnv(
  input: BuildRoutingOverrideEnvInput,
): BuildRoutingOverrideEnvResult {
  const resolution = resolveTier({
    issueComplexity: input.issueComplexity ?? null,
    agentTierPreference: input.agentTierPreference ?? null,
  });
  return {
    resolution,
    env: {
      ...(input.existingEnv ?? {}),
      HERMES_MODEL_OVERRIDE: { type: "plain", value: resolution.entry.model },
      HERMES_PROVIDER_OVERRIDE: { type: "plain", value: resolution.entry.provider },
    },
  };
}
