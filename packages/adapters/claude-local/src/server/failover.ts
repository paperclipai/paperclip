// Tier 0 (claude CLI) → Tier 1 (Anthropic SDK) → Tier 3 (RunPod/Qwen via OpenAI compat)
// failover orchestration for the claude_local adapter.
// See ROC-107 (Tier 3 RunPod A6000 + Qwen2.5-Coder-32B wiring).
//
// The orchestrator is split out from execute.ts so the acceptance harness
// (and any future caller) can compose its own Tier 0 / Tier 1 / Tier 3 stubs without
// dragging the whole adapter runtime setup in.

import type {
  AdapterExecutionResult,
  AdapterFailoverEvent,
  AdapterInvocationMeta,
  AdapterTierTransition,
  AdapterTierTransitionReason,
  AdapterTierUsed,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  CLASSIFIER_VERSION,
  isRecoverable,
  type RecoverabilityReason,
} from "./classifier.js";

/** Re-export the shared tier identifier so callers in this package don't need two imports. */
export type Tier = AdapterTierUsed;

/**
 * Shape required by the orchestrator and the production builder. Matches what
 * `parseClaudeStreamJson` returns so the production `toAdapterResult` builder
 * (which already accepts this exact type) works unchanged. Fields are kept
 * nullable to accommodate the acceptance harness's lightweight stub.
 */
export interface Tier0RawOutcome {
  proc: RunProcessResult;
  parsedStream: {
    sessionId: string | null;
    usage: UsageSummary | null;
    model: string | null;
    summary: string | null;
    costUsd: number | null;
    resultJson: Record<string, unknown> | null;
  };
  parsed: Record<string, unknown> | null;
}

export interface Tier0Runner {
  runTier0(args: { resumeSessionId: string | null }): Promise<Tier0RawOutcome>;
}

export interface Tier1Result {
  exitCode: 0 | 1;
  biller: "anthropic";
  billingType: "api_key";
  model: string;
  summary: string;
  parsed: Record<string, unknown>;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  costUsd: number;
}

export interface Tier1Runner {
  /**
   * Invoked at most once per execute(), only when the classifier returns
   * `recoverable: true`. Pure function of (prompt, options); Tier 1 must not
   * call back into Tier 0 or re-classify its own result.
   */
  runTier1(args: {
    prompt: string;
    model: string;
    transitionReason: AdapterTierTransitionReason;
    classifierMatch: string | null;
  }): Promise<Tier1Result>;
}

export interface FailoverInputs {
  tier0: Tier0Runner;
  tier1: Tier1Runner | null;
  prompt: string;
  model: string;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  /**
   * Receives the original AdapterInvocationMeta shape. On transitions the
   * orchestrator emits a `failoverEvent` field on the meta payload (see the
   * shared `AdapterInvocationMeta.failoverEvent` type). Optional because
   * non-production callers may skip it.
   */
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  resumeSessionId?: string | null;
  /**
   * Production caller passes the existing `toAdapterResult(...)` so the Tier 0
   * success path is byte-identical to today (no perf regression on the happy
   * path, no behavior change to error messaging when no Tier 1 is configured).
   * The test harness omits it and gets a minimal default result built from
   * the raw outcome.
   */
  buildTier0Result?: (raw: Tier0RawOutcome) => AdapterExecutionResult;
  /**
   * Issue id this dispatch is scoped to, when known. Threaded through to the
   * Tier 1 cost-cap gate so per-issue caps can apply (ROCAA-23). May be null
   * when the adapter is invoked outside an issue-scoped context — in that
   * case only the global daily cap applies.
   */
  issueId?: string | null;
  /**
   * ROCAA-23 gate. When supplied, called *after* the classifier verdict says
   * recoverable but *before* the Tier 1 SDK call fires. If the gate returns
   * `allowed: false`, the orchestrator does NOT call Tier 1; it surfaces the
   * Tier 0 result with no transition, logs the block reason, and emits a
   * `failoverEvent` whose `to` stays at `"tier_0_claude_cli"` so the meta
   * consumer can still record the cap-block as an observable event.
   *
   * Omitting this prop preserves pre-ROCAA-23 behavior byte-for-byte.
   */
  tier1Gate?: (args: { issueId: string | null }) => Promise<FailoverTier1GateVerdict>;
  /**
   * ROCAA-23 cost recorder. When supplied, called after Tier 1 returns
   * (success or failure) so the per-issue accumulator can advance and trip
   * the per-issue cap on the next attempt. Best-effort; failures here are
   * intentionally swallowed by the implementing callback so cost-tracking
   * outages never wedge dispatch.
   */
  onTier1Cost?: (args: { issueId: string | null; costUsd: number }) => Promise<void>;
}

/**
 * Cost-cap verdict surface used by `tier1Gate` (ROCAA-23). Mirrors the
 * `Tier1GateVerdict` shape from `./tier1-cost-cap.ts` but is duplicated here
 * to keep the failover orchestrator free of import-side coupling to the
 * cost-cap module — production wiring composes the two; the acceptance
 * harness composes neither.
 */
export type FailoverTier1GateVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: "daily_cap_tripped" | "per_issue_cap_tripped";
      detail: string;
      resetAt?: string;
    };

/**
 * Recoverable-reasons subset that fires Tier 1. This is exactly the union
 * `AdapterTierTransitionReason` from the shared types — kept as a runtime Set
 * so we can narrow `RecoverabilityReason` at the boundary.
 */
const REASONS_THAT_FIRE_FAILOVER: ReadonlySet<RecoverabilityReason> = new Set<RecoverabilityReason>([
  "rate_limit",
  "token_refresh_transient",
  "network_econnreset",
  "network_etimedout",
  "network_fetch_failed",
  "anthropic_5xx",
  "claude_cli_panic",
  "malformed_stream_json",
]);

function asTransitionReason(reason: RecoverabilityReason): AdapterTierTransitionReason {
  // Caller guards with REASONS_THAT_FIRE_FAILOVER, so this narrowing is safe.
  return reason as AdapterTierTransitionReason;
}

/**
 * Run Tier 0; on a recoverable failure, run Tier 1. Returns the final result
 * with `tierUsed`, `tierTransitions[]`, and `classifierVersion` populated.
 *
 * Invariants:
 *  - Tier 0 runs at most once per call.
 *  - Tier 1 runs at most once per call, and only when the classifier says
 *    recoverable AND a Tier 1 runner is supplied. The classifier is never
 *    called on Tier 1's own outcome.
 *  - On Tier 0 success or non-recoverable Tier 0 failure with no Tier 1
 *    configured, the returned result is byte-identical to the pre-failover
 *    behavior (we only attach the three tier-metadata fields).
 */
export async function executeClaudeLocalWithFailover(
  inputs: FailoverInputs,
): Promise<AdapterExecutionResult> {
  const { tier0, tier1, prompt, model, onLog, onMeta } = inputs;
  const issueId = inputs.issueId ?? null;
  const raw = await tier0.runTier0({ resumeSessionId: inputs.resumeSessionId ?? null });

  const tier0Result = inputs.buildTier0Result
    ? inputs.buildTier0Result(raw)
    : buildDefaultTier0Result(raw, model);

  const verdict = isRecoverable({
    exitCode: raw.proc.exitCode,
    stderr: raw.proc.stderr,
    stdout: raw.proc.stdout,
    parsed: raw.parsed,
    timedOut: raw.proc.timedOut,
  });

  const shouldFailover =
    verdict.recoverable && tier1 != null && REASONS_THAT_FIRE_FAILOVER.has(verdict.reason);

  if (!shouldFailover) {
    return {
      ...tier0Result,
      tierUsed: "tier_0_claude_cli",
      tierTransitions: [],
      classifierVersion: CLASSIFIER_VERSION,
    };
  }

  // ROCAA-23: Tier 1 cost-cap gate. Runs *after* the classifier says
  // recoverable but *before* the SDK fires. If the gate refuses, surface the
  // Tier 0 result with no transition and log the block reason so operators
  // see why the failover did not happen.
  if (inputs.tier1Gate) {
    let gateVerdict: FailoverTier1GateVerdict;
    try {
      gateVerdict = await inputs.tier1Gate({ issueId });
    } catch {
      // Gate failures must not block dispatch — treat as "allowed" and let
      // Tier 1 try. The monitor (ROCAA-39) is the authoritative cap source
      // anyway; the adapter side is best-effort enforcement.
      gateVerdict = { allowed: true };
    }
    if (!gateVerdict.allowed) {
      const blockedAt = new Date().toISOString();
      const blockDetail = truncate(gateVerdict.detail, 240);
      await onLog(
        "stdout",
        `[paperclip] Tier 1 blocked by cost cap: reason=${gateVerdict.reason} detail="${blockDetail}". Surfacing Tier 0 failure (reason=${verdict.reason}) without failover.\n`,
      );
      if (onMeta) {
        // Emit a failoverEvent whose `to` stays at Tier 0 so consumers can
        // distinguish "cap-blocked attempt" from "no failover needed". The
        // `reason` field reuses the existing classifier reason so the schema
        // doesn't need a new union member for cap-block; the discriminator is
        // the `to === from` invariant + the `costCapBlock` payload below.
        const failoverEvent: AdapterFailoverEvent = {
          at: blockedAt,
          from: "tier_0_claude_cli",
          to: "tier_0_claude_cli",
          reason: asTransitionReason(verdict.reason),
          classifierMatch: verdict.match,
          billerKeyName: "ANTHROPIC_API_KEY_BLUEPRINT_WORKER",
        };
        await onMeta({
          adapterType: "claude_local",
          command: "",
          failoverEvent,
          costCapBlock: {
            reason: gateVerdict.reason,
            detail: gateVerdict.detail,
            resetAt: gateVerdict.resetAt ?? null,
            issueId,
          },
        });
      }
      return {
        ...tier0Result,
        tierUsed: "tier_0_claude_cli",
        tierTransitions: [],
        classifierVersion: CLASSIFIER_VERSION,
      };
    }
  }

  // Failover path. Build the transition record FIRST so we can echo it to
  // onLog/onMeta and pin its `at` timestamp before Tier 1 runs.
  const transitionReason = asTransitionReason(verdict.reason);
  const transition: AdapterTierTransition = {
    at: new Date().toISOString(),
    from: "tier_0_claude_cli",
    to: "tier_1_anthropic_sdk",
    reason: transitionReason,
    classifierMatch: verdict.match,
    detail: verdict.detail,
    fromExitCode: raw.proc.exitCode,
    fromParsed: raw.parsed != null,
  };

  const matchForLog = truncate(verdict.match ?? "", 120);
  await onLog(
    "stdout",
    `[paperclip] Tier 0 (claude CLI) failed: reason=${verdict.reason} match="${matchForLog}". Failing over to Tier 1 (Anthropic SDK, billed to ANTHROPIC_API_KEY_BLUEPRINT_WORKER).\n`,
  );
  if (onMeta) {
    const failoverEvent: AdapterFailoverEvent = {
      at: transition.at,
      from: transition.from,
      to: transition.to,
      reason: transitionReason,
      classifierMatch: transition.classifierMatch,
      billerKeyName: "ANTHROPIC_API_KEY_BLUEPRINT_WORKER",
    };
    await onMeta({
      adapterType: "claude_local",
      command: "",
      failoverEvent,
    });
  }

  // Tier 1 runs exactly once. Whatever it returns — success or failure — is
  // the final answer. We deliberately do NOT classify Tier 1's outcome:
  //   - tierTransitions[].length stays bounded at 1 in v1
  //   - the Anthropic SDK has its own internal retry; we do not stack ours on top
  const t1 = await tier1!.runTier1({
    prompt,
    model,
    transitionReason,
    classifierMatch: verdict.match,
  });

  // ROCAA-23: feed the per-issue accumulator. Best-effort — the implementing
  // callback is expected to swallow its own errors so cost-tracking outages
  // never stop dispatch. We pass the SDK's reported `costUsd` even when 0
  // (Tier 1 error path returns 0); the recorder filters non-positive samples.
  if (inputs.onTier1Cost) {
    try {
      await inputs.onTier1Cost({ issueId, costUsd: t1.costUsd });
    } catch {
      /* swallowed — cost recording must never wedge dispatch */
    }
  }

  const tier1Result: AdapterExecutionResult = {
    exitCode: t1.exitCode,
    signal: null,
    timedOut: false,
    errorMessage:
      t1.exitCode === 0
        ? null
        : extractTier1ErrorMessage(t1.parsed) ?? `Tier 1 (Anthropic SDK) exited with code ${t1.exitCode}`,
    usage: t1.usage,
    provider: "anthropic",
    biller: t1.biller,
    billingType: t1.billingType,
    model: t1.model,
    costUsd: t1.costUsd,
    resultJson: t1.parsed,
    summary: t1.summary,
  };

  return {
    ...tier1Result,
    tierUsed: "tier_1_anthropic_sdk",
    tierTransitions: [transition],
    classifierVersion: CLASSIFIER_VERSION,
  };
}

function buildDefaultTier0Result(raw: Tier0RawOutcome, fallbackModel: string): AdapterExecutionResult {
  // Minimal result shape used by the acceptance harness and any caller that
  // does not pass `buildTier0Result`. Production execute() always passes its
  // own builder, so this default is intentionally light: it covers the fields
  // the tests assert on (exitCode, biller, billingType, model, usage, summary,
  // resultJson) and leaves session/auth concerns to the production builder.
  return {
    exitCode: raw.proc.exitCode,
    signal: raw.proc.signal as string | null,
    timedOut: raw.proc.timedOut,
    usage: raw.parsedStream.usage ?? undefined,
    provider: "anthropic",
    biller: "anthropic",
    billingType: "subscription",
    model: raw.parsedStream.model || fallbackModel,
    costUsd: raw.parsedStream.costUsd ?? null,
    summary: raw.parsedStream.summary ?? null,
    resultJson: raw.parsed ?? undefined,
  };
}

function extractTier1ErrorMessage(parsed: Record<string, unknown>): string | null {
  const message = parsed?.message;
  if (typeof message === "string" && message.trim().length > 0) return message.trim();
  const error = parsed?.error;
  if (error && typeof error === "object") {
    const m = (error as Record<string, unknown>).message;
    if (typeof m === "string" && m.trim().length > 0) return m.trim();
  }
  return null;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
