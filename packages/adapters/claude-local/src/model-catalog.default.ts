import type { ClaudeModelCatalog, ClaudeReasoningEffortLevel } from "@paperclipai/shared/claude-model-catalog";

// All current reasoning-effort levels, offered by the newest flagship releases.
const FULL_EFFORTS: ClaudeReasoningEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
// Pre-xhigh/max releases that still get a "max" tier.
const MAX_EFFORTS: ClaudeReasoningEffortLevel[] = ["low", "medium", "high", "max"];

/**
 * The bundled default claude_local model catalog. This ships with the app
 * and is the fallback of last resort, used whenever no on-disk override is
 * present (or an override file fails validation). An operator can grant a
 * new model, relabel one, or change its reasoning-effort support by placing
 * a matching file at the instance's model-catalog override path instead of
 * waiting on a new app release — see `resolveDefaultModelCatalogDir` in
 * `@paperclipai/shared/home-paths` and `PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE`.
 *
 * Ordered the way the Claude app orders models (#14877): the newest release of each
 * family first, by decreasing capability, then older releases grouped by family. The
 * server applies the same order to discovered models (server/model-order.ts); the
 * picker keeps it.
 */
export const DEFAULT_CLAUDE_MODEL_CATALOG: ClaudeModelCatalog = {
  version: 1,
  direct: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1", efforts: FULL_EFFORTS },
    { id: "claude-mythos-5", label: "Claude Mythos 5" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: FULL_EFFORTS },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: FULL_EFFORTS },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    { id: "claude-fable-5", label: "Claude Fable 5", efforts: FULL_EFFORTS },
    { id: "claude-opus-5", label: "Claude Opus 5", efforts: FULL_EFFORTS },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: FULL_EFFORTS },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", efforts: FULL_EFFORTS },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6", efforts: MAX_EFFORTS },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: FULL_EFFORTS },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", efforts: MAX_EFFORTS },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", efforts: [] },
  ],
  // AWS Bedrock model IDs: region-qualified identifiers required by the Bedrock API.
  bedrock: [
    // Fable 5.1's documented geo inference ID carries no -v1 suffix, unlike earlier entries.
    { id: "us.anthropic.claude-fable-5-1", label: "Bedrock Fable 5.1" },
    { id: "us.anthropic.claude-opus-5-5", label: "Bedrock Opus 5.5" },
    // Sonnet 5.5's documented Bedrock ID is dateless, like Fable 5.1 and Opus 5.5.
    { id: "us.anthropic.claude-sonnet-5-5", label: "Bedrock Sonnet 5.5" },
    // Haiku 5.5's documented Bedrock ID is dateless too, like the other 5.5 releases.
    { id: "us.anthropic.claude-haiku-5-5", label: "Bedrock Haiku 5.5" },
    { id: "us.anthropic.claude-fable-5", label: "Bedrock Fable 5" },
    { id: "us.anthropic.claude-opus-5", label: "Bedrock Opus 5" },
    { id: "us.anthropic.claude-opus-4-8", label: "Bedrock Opus 4.8" },
    { id: "us.anthropic.claude-opus-4-7", label: "Bedrock Opus 4.7" },
    { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
    { id: "us.anthropic.claude-sonnet-5", label: "Bedrock Sonnet 5" },
    { id: "us.anthropic.claude-sonnet-4-6", label: "Bedrock Sonnet 4.6" },
    { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
    { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
  ],
};
