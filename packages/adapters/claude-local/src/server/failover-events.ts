/**
 * Shared cost-visibility helpers for the claude_local Tier 0 → Tier 1 failover.
 *
 * The schema (ROCAA-27 log-schema doc) requires three surfaces every time a
 * transition fires:
 *
 *   1. An `onMeta({ failoverEvent })` event so the run UI can render the
 *      "Tier 1 (API key)" pill on the run card.
 *   2. A single grep-friendly `[paperclip] Tier 0 ... Tier 1 ...` stdout line so
 *      terminal users see the swap inline.
 *   3. A `tier_transitions[]` entry on `AdapterExecutionResult` so post-run
 *      consumers can query the structured shape.
 *
 * ROCAA-28 owns the wiring (calling these helpers from `execute.ts`). This module
 * owns the *contents*: identical formatting in every consumer, no copy-paste.
 */
import type {
  AdapterFailoverEvent,
  AdapterInvocationMeta,
  AdapterTierTransition,
  AdapterTierTransitionReason,
} from "@paperclipai/adapter-utils";

import { BLUEPRINT_WORKER_SECRET_NAME } from "./secret-fetch.js";
import { CLASSIFIER_VERSION } from "./classifier.js";

/**
 * Bumped when the classifier decision order or schema fields change. Re-exported
 * from `./classifier.js` so the version string has a single source of truth
 * (the classifier itself), and external callers that depend on either module
 * see the same value.
 */
export const FAILOVER_CLASSIFIER_VERSION = CLASSIFIER_VERSION;

const MAX_CLASSIFIER_MATCH_LEN = 240;
const MAX_DETAIL_LEN = 240;
const MAX_LOG_MATCH_LEN = 120;

export interface ClassifierVerdictLike {
  reason: AdapterTierTransitionReason;
  match: string | null;
  detail?: string;
}

export interface FailoverTransitionInput {
  verdict: ClassifierVerdictLike;
  fromExitCode: number | null;
  fromParsed: boolean;
  /**
   * Operator-facing name of the credential Tier 1 is using. Defaults to
   * `ANTHROPIC_API_KEY_BLUEPRINT_WORKER` because every Tier 1 spawn billed by
   * this adapter charges that key. Override only when the env-var fallback path
   * is in use.
   */
  billerKeyName?: string;
  /** Injection seam for tests. Defaults to `() => new Date().toISOString()`. */
  now?: () => string;
}

function truncate(value: string | null, max: number): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function quoteShort(value: string | null): string {
  if (value == null || value.length === 0) return '""';
  return `"${truncate(value, MAX_LOG_MATCH_LEN)?.replace(/"/g, '\\"') ?? ""}"`;
}

/**
 * Builds the structured `tierTransitions[]` entry that the wiring layer attaches
 * to the AdapterExecutionResult. The verdict's `match`/`detail` are truncated to
 * keep the run-row payload bounded.
 */
export function buildTierTransition(input: FailoverTransitionInput): AdapterTierTransition {
  const at = (input.now ?? (() => new Date().toISOString()))();
  return {
    at,
    from: "tier_0_claude_cli",
    to: "tier_1_anthropic_sdk",
    reason: input.verdict.reason,
    classifierMatch: truncate(input.verdict.match, MAX_CLASSIFIER_MATCH_LEN),
    ...(input.verdict.detail
      ? { detail: truncate(input.verdict.detail, MAX_DETAIL_LEN) ?? undefined }
      : {}),
    fromExitCode: input.fromExitCode,
    fromParsed: input.fromParsed,
  };
}

/**
 * Builds the `failoverEvent` payload that goes on the next `onMeta` call. The
 * UI reads this to render the run-card chip. Always includes the biller key
 * name so operators can see *which budget* this invocation will spend.
 */
export function buildFailoverEvent(input: FailoverTransitionInput): AdapterFailoverEvent {
  const transition = buildTierTransition(input);
  return {
    at: transition.at,
    from: transition.from,
    to: transition.to,
    reason: transition.reason,
    classifierMatch: transition.classifierMatch,
    billerKeyName: input.billerKeyName ?? BLUEPRINT_WORKER_SECRET_NAME,
  };
}

/**
 * Builds the single mandatory stdout line per the log-schema contract. Format
 * is fixed:
 *
 *   [paperclip] Tier 0 (claude CLI) failed: reason=<id> match="<≤120 chars>". Failing over to Tier 1 (Anthropic SDK, billed to <KEY_NAME>).
 *
 * The literal substrings `Tier 0` and `Tier 1` are case-sensitive and grep-friendly.
 */
export function buildFailoverLogLine(input: FailoverTransitionInput): string {
  const billerKeyName = input.billerKeyName ?? BLUEPRINT_WORKER_SECRET_NAME;
  return (
    `[paperclip] Tier 0 (claude CLI) failed: reason=${input.verdict.reason} ` +
    `match=${quoteShort(input.verdict.match)}. ` +
    `Failing over to Tier 1 (Anthropic SDK, billed to ${billerKeyName}).\n`
  );
}

/** Helper for the wiring layer to emit all three surfaces in one call. */
export interface EmitFailoverVisibilityInput extends FailoverTransitionInput {
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  /** The base meta payload (adapterType, command, etc.) that the meta event extends. */
  baseMeta?: Omit<AdapterInvocationMeta, "failoverEvent">;
}

export async function emitFailoverVisibility(
  input: EmitFailoverVisibilityInput,
): Promise<{ transition: AdapterTierTransition; event: AdapterFailoverEvent }> {
  // Build transition + event together so they share an `at` timestamp via `now`.
  const at = (input.now ?? (() => new Date().toISOString()))();
  const fixedNow = () => at;
  const transition = buildTierTransition({ ...input, now: fixedNow });
  const event = buildFailoverEvent({ ...input, now: fixedNow });

  const line = buildFailoverLogLine({ ...input, now: fixedNow });
  await input.onLog("stdout", line);

  if (input.onMeta) {
    await input.onMeta({
      adapterType: "claude_local",
      command: "",
      ...(input.baseMeta ?? {}),
      failoverEvent: event,
    });
  }

  return { transition, event };
}
