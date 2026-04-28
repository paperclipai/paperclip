/**
 * Wake-time model tier routing.
 *
 * Picks Haiku/Sonnet/Opus per heartbeat from the wake payload alone (no
 * additional DB calls). Opt-in via `agent.adapterConfig.modelTierProfile` —
 * agents without a profile keep their existing `config.model` untouched.
 *
 * Rule (v1, see WOR-36):
 *   trivial → haiku   (blocked-task dedup, no-context wake, system-only retries)
 *   heavy   → opus    (umbrella with ≥3 in-flight children, plan/기획/설계/검토,
 *                      review/approval execution stage)
 *   else    → sonnet
 */

export type ModelTier = "haiku" | "sonnet" | "opus";

export interface ModelTierProfile {
  /** Tier to use when none of the rules match. Defaults to "sonnet". */
  default?: ModelTier;
  /** Model id for the haiku tier (e.g. "claude-haiku-4-5"). Optional. */
  haiku?: string | null;
  /** Model id for the sonnet tier (e.g. "claude-sonnet-4-6"). Optional. */
  sonnet?: string | null;
  /** Model id for the opus tier (e.g. "claude-opus-4-7"). Optional. */
  opus?: string | null;
  /** Disable routing without removing the profile. Defaults to true. */
  enabled?: boolean;
}

export interface ModelTierSelection {
  tier: ModelTier;
  /** Resolved model id, or null when the tier has no model in the profile. */
  model: string | null;
  /** Short reason — surfaced to telemetry / agent env for debugging. */
  reason: string;
}

export interface ModelTierRoutingInput {
  config: Record<string, unknown>;
  context: Record<string, unknown> | null | undefined;
  wakePayload: Record<string, unknown> | null | undefined;
}

const PLAN_MODE_KEYWORDS = [
  "mode=plan",
  "mode: plan",
  "plan-only",
  "기획",
  "설계",
  "검토",
];

const SYSTEM_RETRY_WAKE_REASONS = new Set([
  "process_lost_retry",
  "transient_failure_retry",
  "retry_failed_run",
  "missing_issue_comment",
  "issue_tree_restored",
]);

const TERMINAL_CHILD_STATUSES = new Set(["done", "cancelled"]);

const UMBRELLA_IN_FLIGHT_THRESHOLD = 3;

const HEAVY_EXECUTION_STAGE_TYPES = new Set([
  "execution_review",
  "execution_approval",
  "execution_changes_requested",
]);

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readModelTierProfile(config: Record<string, unknown>): ModelTierProfile | null {
  const raw = config.modelTierProfile;
  if (!raw || typeof raw !== "object") return null;
  const profile = raw as Record<string, unknown>;
  const enabled = profile.enabled !== false;
  if (!enabled) return null;
  const defaultTier = asString(profile.default).toLowerCase();
  const normalizedDefault: ModelTier =
    defaultTier === "haiku" || defaultTier === "sonnet" || defaultTier === "opus"
      ? defaultTier
      : "sonnet";
  return {
    default: normalizedDefault,
    haiku: typeof profile.haiku === "string" ? profile.haiku : null,
    sonnet: typeof profile.sonnet === "string" ? profile.sonnet : null,
    opus: typeof profile.opus === "string" ? profile.opus : null,
    enabled: true,
  };
}

function countInFlightChildren(wakePayload: Record<string, unknown>): number {
  const summaries = asArray(wakePayload.childIssueSummaries);
  let count = 0;
  for (const entry of summaries) {
    if (!entry || typeof entry !== "object") continue;
    const status = asString((entry as Record<string, unknown>).status).toLowerCase();
    if (status && !TERMINAL_CHILD_STATUSES.has(status)) count += 1;
  }
  return count;
}

function collectKeywordHaystack(
  context: Record<string, unknown>,
  wakePayload: Record<string, unknown>,
): string {
  const parts: string[] = [];
  const issue = asObject(wakePayload.issue);
  if (issue.title) parts.push(asString(issue.title));
  const continuation = asObject(wakePayload.continuationSummary);
  if (continuation.body) parts.push(asString(continuation.body));
  for (const comment of asArray(wakePayload.comments)) {
    if (comment && typeof comment === "object") {
      const body = asString((comment as Record<string, unknown>).body);
      if (body) parts.push(body);
    }
  }
  const paperclipIssue = asObject(context.paperclipIssue);
  if (paperclipIssue.description) parts.push(asString(paperclipIssue.description));
  const wakeComment = asObject(context.paperclipWakeComment);
  if (wakeComment.body) parts.push(asString(wakeComment.body));
  return parts.join("\n").toLowerCase();
}

function hasPlanModeKeyword(haystack: string): boolean {
  if (!haystack) return false;
  return PLAN_MODE_KEYWORDS.some((kw) => haystack.includes(kw));
}

function isHeavyExecutionStage(wakePayload: Record<string, unknown>): boolean {
  const stage = wakePayload.executionStage;
  if (!stage || typeof stage !== "object") return false;
  const stageObj = stage as Record<string, unknown>;
  const type = asString(stageObj.currentStageType).toLowerCase();
  if (type && HEAVY_EXECUTION_STAGE_TYPES.has(type)) return true;
  return Object.keys(stageObj).length > 0 && asString(stageObj.currentStageType).length > 0;
}

interface TrivialReason {
  trivial: boolean;
  reason: string;
}

function classifyTrivial(
  context: Record<string, unknown>,
  wakePayload: Record<string, unknown>,
): TrivialReason {
  const issue = asObject(wakePayload.issue);
  const status = asString(issue.status).toLowerCase();
  const wakeReason = asString(wakePayload.reason) || asString(context.wakeReason);
  const comments = asArray(wakePayload.comments);
  const commentIds = asArray(wakePayload.commentIds);
  const hasNewComments = comments.length > 0 || commentIds.length > 0;
  const wakeCommentContext = asObject(context.paperclipWakeComment);
  const hasWakeCommentContext = Object.keys(wakeCommentContext).length > 0;
  const continuationSummary = asObject(wakePayload.continuationSummary);
  const executionStage = wakePayload.executionStage;
  const hasExecutionStage =
    executionStage !== null && typeof executionStage === "object" &&
    Object.keys(executionStage as Record<string, unknown>).length > 0;

  if (wakePayload.dependencyBlockedInteraction === true) {
    return { trivial: true, reason: "dependency_blocked_interaction" };
  }

  if (status === "blocked" && !hasNewComments && !hasWakeCommentContext) {
    return { trivial: true, reason: "blocked_no_new_context" };
  }

  if (
    SYSTEM_RETRY_WAKE_REASONS.has(wakeReason) &&
    !hasNewComments &&
    !hasWakeCommentContext
  ) {
    return { trivial: true, reason: `system_retry:${wakeReason}` };
  }

  if (
    !hasNewComments &&
    !hasWakeCommentContext &&
    Object.keys(continuationSummary).length === 0 &&
    !hasExecutionStage &&
    !wakeReason
  ) {
    return { trivial: true, reason: "no_context_wake" };
  }

  return { trivial: false, reason: "" };
}

interface HeavyReason {
  heavy: boolean;
  reason: string;
}

function classifyHeavy(
  context: Record<string, unknown>,
  wakePayload: Record<string, unknown>,
): HeavyReason {
  const inFlightChildren = countInFlightChildren(wakePayload);
  if (inFlightChildren >= UMBRELLA_IN_FLIGHT_THRESHOLD) {
    return { heavy: true, reason: `umbrella_children:${inFlightChildren}` };
  }
  if (isHeavyExecutionStage(wakePayload)) {
    return { heavy: true, reason: "execution_stage" };
  }
  const haystack = collectKeywordHaystack(context, wakePayload);
  if (hasPlanModeKeyword(haystack)) {
    return { heavy: true, reason: "plan_mode_keyword" };
  }
  return { heavy: false, reason: "" };
}

function pickModelForTier(profile: ModelTierProfile, tier: ModelTier): string | null {
  if (tier === "haiku") return profile.haiku ?? profile.sonnet ?? profile.opus ?? null;
  if (tier === "opus") return profile.opus ?? profile.sonnet ?? profile.haiku ?? null;
  return profile.sonnet ?? profile.opus ?? profile.haiku ?? null;
}

/**
 * Decide which model tier to use for this heartbeat.
 *
 * Returns null when the agent has no `modelTierProfile` (or it is disabled),
 * meaning the caller should leave `config.model` untouched.
 */
export function selectHeartbeatModelTier(
  input: ModelTierRoutingInput,
): ModelTierSelection | null {
  const profile = readModelTierProfile(input.config);
  if (!profile) return null;

  const context = input.context ?? {};
  const wakePayload = input.wakePayload ?? {};

  const trivial = classifyTrivial(context, wakePayload);
  if (trivial.trivial) {
    const tier: ModelTier = "haiku";
    return { tier, model: pickModelForTier(profile, tier), reason: trivial.reason };
  }

  const heavy = classifyHeavy(context, wakePayload);
  if (heavy.heavy) {
    const tier: ModelTier = "opus";
    return { tier, model: pickModelForTier(profile, tier), reason: heavy.reason };
  }

  const tier: ModelTier = profile.default ?? "sonnet";
  return { tier, model: pickModelForTier(profile, tier), reason: "default" };
}

/**
 * Apply a routing decision to an adapter `config` object. Returns a new config
 * with `config.model` overridden when the selection produced a model id.
 *
 * The routing selection is also recorded under `modelTierSelection` so the
 * adapter can surface it in env / telemetry.
 */
export function applyModelTierSelection(
  config: Record<string, unknown>,
  selection: ModelTierSelection | null,
): Record<string, unknown> {
  if (!selection) return config;
  const next: Record<string, unknown> = {
    ...config,
    modelTierSelection: {
      tier: selection.tier,
      model: selection.model,
      reason: selection.reason,
    },
  };
  if (selection.model) {
    next.model = selection.model;
  }
  return next;
}
