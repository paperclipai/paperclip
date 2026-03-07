/**
 * ThoughtForm Bundle Schema & Deserializer
 *
 * Strict Zod-based validation and deserialization for ThoughtForm bundles.
 * ThoughtForm bundles capture structured agent reasoning: a sequence of
 * thought steps with metadata, used for archival, replay, and on-chain storage.
 */

import { z } from 'zod/v4';

// ── Schema version ───────────────────────────────────────────────────────────

export const THOUGHTFORM_SCHEMA_VERSION = '1.0.0';

// ── Zod schemas ──────────────────────────────────────────────────────────────

export const ThoughtStepSchema = z.strictObject({
  /** Unique identifier for this step */
  id: z.string().min(1),
  /** The reasoning or content produced at this step */
  content: z.string(),
  /** Role that produced the thought */
  role: z.enum(['agent', 'system', 'tool']),
  /** ISO-8601 timestamp */
  timestamp: z.iso.datetime(),
  /** Duration of this step in milliseconds */
  durationMs: z.number().int().nonnegative().optional(),
  /** Tool invocations associated with this step */
  toolCalls: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        input: z.record(z.string(), z.unknown()),
        output: z.string().optional(),
      }),
    )
    .optional(),
  /** Free-form metadata */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ThoughtFormManifestSchema = z.strictObject({
  /** Schema version */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** Agent that produced the bundle */
  agentName: z.string().min(1),
  /** Agent type */
  agentType: z.enum(['clawdbot', 'goose', 'cline', 'generic']),
  /** ISO-8601 creation timestamp */
  createdAt: z.iso.datetime(),
  /** SHA-256 hex digest of the steps JSON */
  stepsHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Total number of steps */
  stepCount: z.number().int().positive(),
  /** Optional description of the reasoning session */
  description: z.string().optional(),
});

export const ThoughtFormBundleSchema = z.strictObject({
  /** Bundle format identifier */
  format: z.literal('agentvault-thoughtform-v1'),
  /** Bundle manifest with provenance metadata */
  manifest: ThoughtFormManifestSchema,
  /** Ordered sequence of thought steps */
  steps: z.array(ThoughtStepSchema).min(1),
});

// ── Inferred types ───────────────────────────────────────────────────────────

export type ThoughtStep = z.infer<typeof ThoughtStepSchema>;
export type ThoughtFormManifest = z.infer<typeof ThoughtFormManifestSchema>;
export type ThoughtFormBundle = z.infer<typeof ThoughtFormBundleSchema>;

// ── Deserializer ─────────────────────────────────────────────────────────────

/**
 * Deserialize and validate a ThoughtForm bundle from a JSON string.
 *
 * Uses Zod `safeParse` internally and throws a descriptive error when the
 * input does not match the expected schema.
 *
 * @param json - Raw JSON string representing a ThoughtForm bundle
 * @returns A fully validated {@link ThoughtFormBundle}
 * @throws {Error} If `json` is not valid JSON or fails schema validation
 */
export function deserializeThoughtFormBundle(json: string): ThoughtFormBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Failed to deserialize ThoughtForm bundle: invalid JSON');
  }

  const result = ThoughtFormBundleSchema.safeParse(raw);

  if (!result.success) {
    const issues = z.prettifyError(result.error);
    throw new Error(
      `Failed to deserialize ThoughtForm bundle: schema validation failed\n${issues}`,
    );
  }

  return result.data;
}
