import { z } from "zod";

/**
 * Reasoning effort levels the `claude_local` adapter can pass via `--effort`.
 * Not every model supports every level (see `claudeLocalReasoningEffortsForModel`
 * in `@paperclipai/adapter-claude-local`).
 */
export const CLAUDE_REASONING_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeReasoningEffortLevel = (typeof CLAUDE_REASONING_EFFORT_LEVELS)[number];

/** Effort levels assumed for a model the catalog doesn't recognize at all. */
export const DEFAULT_CLAUDE_REASONING_EFFORTS: readonly ClaudeReasoningEffortLevel[] = ["low", "medium", "high"];

export const claudeModelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  // Omitted/absent means the adapter's own default effort set applies.
  efforts: z.array(z.enum(CLAUDE_REASONING_EFFORT_LEVELS)).optional(),
}).strict();

/**
 * The claude_local model catalog: which model IDs the picker offers and, for
 * each, which reasoning-effort levels it supports. `direct` covers the
 * Anthropic API; `bedrock` covers AWS Bedrock-native IDs. An operator can
 * override the bundled default by placing a file matching this shape at the
 * instance's model-catalog override path (see `resolveDefaultModelCatalogDir`
 * in `./home-paths.js` and `PAPERCLIP_CLAUDE_MODEL_CATALOG_FILE`) without
 * rebuilding or redeploying the app.
 */
export const claudeModelCatalogSchema = z.object({
  version: z.number().int().positive(),
  direct: z.array(claudeModelCatalogEntrySchema).default([]),
  bedrock: z.array(claudeModelCatalogEntrySchema).default([]),
}).strict();

export type ClaudeModelCatalogEntry = z.infer<typeof claudeModelCatalogEntrySchema>;
export type ClaudeModelCatalog = z.infer<typeof claudeModelCatalogSchema>;
