/** Long-context / document-engine helpers for the router.
 *
 *  - Subscription availability check (env flag, no live ping — that belongs in
 *    adapter integration, not router decision time).
 *  - Context window guard: returns whether a long-context task should bias to a
 *    document engine.
 *  - Second-pass rule helper: any outbound/regulatory/critical document-engine
 *    output should be paired with a reasoning-pass marker.
 */

import { LONG_CONTEXT_THRESHOLD_TOKENS, type Sensitivity } from './types.js';

/** Env var contract. Set to `true|1|yes` once the long-context (Gemini Advanced)
 *  subscription is reachable for the running agent. Defaults to `false` if unset. */
const GEMINI_ENV_KEY = 'GEMINI_ADVANCED_AVAILABLE' as const;

type Env = Record<string, string | undefined>;

function readProcessEnv(): Env {
  const maybeGlobal = globalThis as { process?: { env?: Env } };
  return maybeGlobal.process?.env ?? {};
}

export function isGeminiAvailable(env: Env = readProcessEnv()): boolean {
  const raw = env[GEMINI_ENV_KEY];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function shouldPromoteToGeminiLongContext(estimatedInputTokens?: number): boolean {
  if (!estimatedInputTokens) return false;
  return estimatedInputTokens > LONG_CONTEXT_THRESHOLD_TOKENS;
}

/** True when a document-engine output should not ship without a reasoning pass —
 *  i.e. anything outbound/regulatory/critical. */
export function geminiRequiresClaudeReasoningPass(sensitivity: Sensitivity): boolean {
  return sensitivity === 'outbound' || sensitivity === 'regulatory' || sensitivity === 'critical';
}

export interface GeminiContextWindowReport {
  /** Effective context window for the chosen model. */
  max_input_tokens: number;
  estimated_input_tokens: number;
  utilization: number; // 0..1
  /** True when the request would overflow (caller must chunk or escalate). */
  exceeds_window: boolean;
}

export function describeGeminiContextWindow(
  estimatedInputTokens: number | undefined,
  maxInputTokens: number,
): GeminiContextWindowReport {
  const tokens = estimatedInputTokens ?? 0;
  const utilization = maxInputTokens > 0 ? Math.min(tokens / maxInputTokens, 1) : 0;
  return {
    max_input_tokens: maxInputTokens,
    estimated_input_tokens: tokens,
    utilization,
    exceeds_window: tokens > maxInputTokens,
  };
}

export const GEMINI_AVAILABILITY_ENV_KEY = GEMINI_ENV_KEY;
