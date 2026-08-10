/**
 * TSMC-20250: batch issue pickup + comment-burst debounce policy.
 *
 * Measurement (2026-08-06): issue_assigned is ~61% of runs. Debouncing chatter
 * classes saves little; the entry-tax multiplier is one run per assigned issue.
 *
 * Design:
 * 1. Claim-time batch: when ≥2 pending batchable issue_assigned wakes exist for
 *    one agent (or a single batchable wake has aged past the lane window), claim
 *    one run and attach the ordered sibling issues into that run's context.
 * 2. SLA/urgent classes stay one-run-per-issue with zero hold.
 * 3. Comment-burst debounce: pure issue_commented queues hold briefly so bursts
 *    coalesce onto one run before dispatch.
 * 4. Per-lane batch windows (operator-delegated defaults).
 *
 * Kill-switch: PAPERCLIP_BATCH_ISSUE_PICKUP=false
 * Comment debounce: PAPERCLIP_COMMENT_BURST_DEBOUNCE_MS (default 300000; 0=off)
 */

export const BATCH_ISSUE_PICKUP_CONTEXT_KEY = "issueBatch" as const;
export const BATCH_ISSUE_PICKUP_META_KEY = "issueBatchPickup" as const;

/** Urgent wake reasons that must never wait in a batch window or share a run. */
export const BATCH_PICKUP_EXEMPT_WAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_commented",
  "issue_comment_mentioned",
  "issue_reopened_via_comment",
  "execution_review_requested",
  "execution_approval_requested",
  "execution_changes_requested",
  "issue_priority_changed",
  "interaction_continuation",
  "interaction_continuation_infra_retry",
  "paid_delivery_callback",
  "operator_comment",
  "board_comment",
  "heartbeat_timer",
  "manual",
  "issue_children_completed",
  "issue_blockers_resolved",
  "issue_dependency_unblocked",
]);

/** Assignment-shaped reasons eligible for multi-issue claim batching. */
export const BATCHABLE_ASSIGNMENT_WAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_assigned",
]);

export type BatchLaneClass = "csuite" | "engineering" | "drafter" | "system" | "default";

/** Per-lane batch hold windows (ms). System/recovery wakes keep existing throttles (0). */
export const BATCH_LANE_WINDOW_MS: Readonly<Record<BatchLaneClass, number>> = {
  csuite: 15 * 60_000,
  engineering: 10 * 60_000,
  drafter: 30 * 60_000,
  system: 0,
  default: 10 * 60_000,
};

export const DEFAULT_COMMENT_BURST_DEBOUNCE_MS = 300_000;
export const DEFAULT_MAX_BATCH_ISSUES = 8;

export type BatchPickupRunLike = {
  id: string;
  createdAt: Date | string | number;
  contextSnapshot?: unknown;
  triggerDetail?: string | null;
  invocationSource?: string | null;
};

export type BatchIssueEntry = {
  issueId: string;
  runId: string;
  wakeReason: string;
  priority?: string | null;
  status?: string | null;
  identifier?: string | null;
  title?: string | null;
  queuedAt: string;
};

export type BatchPickupSelection = {
  primary: BatchPickupRunLike;
  siblings: BatchPickupRunLike[];
  batch: BatchIssueEntry[];
  held: boolean;
  holdReason: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function isBatchIssuePickupEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.PAPERCLIP_BATCH_ISSUE_PICKUP;
  if (raw == null || raw === "") return true;
  return !/^(0|false|off|no)$/i.test(raw.trim());
}

export function readCommentBurstDebounceMs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  const raw = env.PAPERCLIP_COMMENT_BURST_DEBOUNCE_MS;
  if (raw == null || raw === "") return DEFAULT_COMMENT_BURST_DEBOUNCE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_COMMENT_BURST_DEBOUNCE_MS;
  return Math.floor(parsed);
}

export function readMaxBatchIssues(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
  const raw = env.PAPERCLIP_BATCH_ISSUE_PICKUP_MAX;
  if (raw == null || raw === "") return DEFAULT_MAX_BATCH_ISSUES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_BATCH_ISSUES;
  return Math.min(32, Math.floor(parsed));
}

export function classifyBatchLane(input: {
  role?: string | null;
  name?: string | null;
  title?: string | null;
}): BatchLaneClass {
  const haystack = [input.role, input.name, input.title]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (!haystack) return "default";

  if (
    /\b(ceo|cto|cfo|cmo|coo|chief|glad0s|glados|board|routingpa|routing[\s_-]?pa|orchestrat)\b/.test(
      haystack,
    ) ||
    /\b(c-?suite|coordination|director|manager|pa)\b/.test(haystack)
  ) {
    return "csuite";
  }

  if (
    /\b(drafter|content|copy|writer|media[\s_-]?draft|social|marketing[\s_-]?writer)\b/.test(haystack)
  ) {
    return "drafter";
  }

  if (
    /\b(system|recovery|astra|watchdog|compiler|mc-?compiler|cron|ops[\s_-]?bot)\b/.test(haystack)
  ) {
    return "system";
  }

  if (
    /\b(engineer|eng|coder|implement|qa|reviewer|hermes|codex|gemini|spark|backend|frontend|devtools)\b/.test(
      haystack,
    )
  ) {
    return "engineering";
  }

  return "default";
}

export function resolveBatchWindowMs(input: {
  role?: string | null;
  name?: string | null;
  title?: string | null;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): number {
  const env = input.env ?? process.env;
  const override = env.PAPERCLIP_BATCH_ISSUE_PICKUP_WINDOW_MS;
  if (override != null && override !== "") {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  const lane = classifyBatchLane(input);
  return BATCH_LANE_WINDOW_MS[lane];
}

export function readWakeReasonFromContext(contextSnapshot: unknown): string | null {
  const context = parseObject(contextSnapshot);
  return (
    readNonEmptyString(context.wakeReason) ??
    readNonEmptyString(context.reason) ??
    null
  );
}

export function readIssueIdFromContext(contextSnapshot: unknown): string | null {
  const context = parseObject(contextSnapshot);
  return (
    readNonEmptyString(context.issueId) ??
    readNonEmptyString(context.taskId) ??
    null
  );
}

export function isManualOrOperatorTrigger(input: {
  triggerDetail?: string | null;
  invocationSource?: string | null;
  contextSnapshot?: unknown;
}): boolean {
  const trigger = (input.triggerDetail ?? "").toLowerCase();
  const source = (input.invocationSource ?? "").toLowerCase();
  if (trigger === "manual" || source === "on_demand") return true;
  const context = parseObject(input.contextSnapshot);
  if (context.forceFreshSession === true) return true;
  if (readNonEmptyString(context.requestedByActorType) === "user") return true;
  return false;
}

export function isBatchableAssignmentWake(input: {
  wakeReason?: string | null;
  contextSnapshot?: unknown;
  triggerDetail?: string | null;
  invocationSource?: string | null;
}): boolean {
  if (isManualOrOperatorTrigger(input)) return false;
  const wakeReason =
    readNonEmptyString(input.wakeReason) ?? readWakeReasonFromContext(input.contextSnapshot);
  if (!wakeReason) return false;
  if (BATCH_PICKUP_EXEMPT_WAKE_REASONS.has(wakeReason)) return false;
  if (!BATCHABLE_ASSIGNMENT_WAKE_REASONS.has(wakeReason)) return false;
  // Comment-bearing assignment follow-ups stay single-issue.
  const context = parseObject(input.contextSnapshot);
  const commentId =
    readNonEmptyString(context.commentId) ??
    readNonEmptyString(context.wakeCommentId) ??
    (Array.isArray(context.wakeCommentIds) && context.wakeCommentIds.length > 0 ? "set" : null);
  if (commentId) return false;
  return Boolean(readIssueIdFromContext(input.contextSnapshot));
}

export function isCommentBurstDebounceCandidate(input: {
  wakeReason?: string | null;
  contextSnapshot?: unknown;
  triggerDetail?: string | null;
  invocationSource?: string | null;
}): boolean {
  if (isManualOrOperatorTrigger(input)) return false;
  const wakeReason =
    readNonEmptyString(input.wakeReason) ?? readWakeReasonFromContext(input.contextSnapshot);
  return wakeReason === "issue_commented";
}

function toTimeMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function shouldHoldSingleBatchableForWindow(input: {
  runCreatedAt: Date | string | number;
  siblingCount: number;
  windowMs: number;
  now?: Date | string | number;
}): boolean {
  if (input.windowMs <= 0) return false;
  if (input.siblingCount >= 1) return false; // ≥2 total including primary
  const ageMs = toTimeMs(input.now ?? Date.now()) - toTimeMs(input.runCreatedAt);
  return ageMs < input.windowMs;
}

export function shouldHoldCommentBurstForDebounce(input: {
  runCreatedAt: Date | string | number;
  debounceMs: number;
  now?: Date | string | number;
}): boolean {
  if (input.debounceMs <= 0) return false;
  const ageMs = toTimeMs(input.now ?? Date.now()) - toTimeMs(input.runCreatedAt);
  return ageMs < input.debounceMs;
}

/**
 * From a prioritized queued-run list, decide whether the head run should claim
 * alone, hold for a batch/debounce window, or claim with an ordered sibling batch.
 */
export function selectIssueBatchPickup(input: {
  prioritizedRuns: BatchPickupRunLike[];
  agent: { role?: string | null; name?: string | null; title?: string | null };
  enabled?: boolean;
  maxBatchIssues?: number;
  windowMs?: number;
  commentDebounceMs?: number;
  now?: Date | string | number;
  issueMetaById?: Map<
    string,
    { priority?: string | null; status?: string | null; identifier?: string | null; title?: string | null }
  >;
}): BatchPickupSelection | null {
  const prioritized = input.prioritizedRuns;
  if (prioritized.length === 0) return null;

  const enabled = input.enabled ?? true;
  const primary = prioritized[0]!;
  const primaryContext = primary.contextSnapshot;
  const primaryWake = readWakeReasonFromContext(primaryContext);
  const primaryIssueId = readIssueIdFromContext(primaryContext);
  const now = input.now ?? Date.now();
  const maxBatch = input.maxBatchIssues ?? DEFAULT_MAX_BATCH_ISSUES;
  const windowMs =
    input.windowMs ??
    resolveBatchWindowMs({
      role: input.agent.role,
      name: input.agent.name,
      title: input.agent.title,
    });
  const commentDebounceMs = input.commentDebounceMs ?? DEFAULT_COMMENT_BURST_DEBOUNCE_MS;

  // Comment-burst debounce (small, include while in there).
  if (
    enabled &&
    isCommentBurstDebounceCandidate({
      wakeReason: primaryWake,
      contextSnapshot: primaryContext,
      triggerDetail: primary.triggerDetail,
      invocationSource: primary.invocationSource,
    }) &&
    shouldHoldCommentBurstForDebounce({
      runCreatedAt: primary.createdAt,
      debounceMs: commentDebounceMs,
      now,
    })
  ) {
    return {
      primary,
      siblings: [],
      batch: [],
      held: true,
      holdReason: "comment_burst_debounce",
    };
  }

  if (!enabled || !primaryIssueId) {
    return {
      primary,
      siblings: [],
      batch: [],
      held: false,
      holdReason: null,
    };
  }

  const primaryBatchable = isBatchableAssignmentWake({
    wakeReason: primaryWake,
    contextSnapshot: primaryContext,
    triggerDetail: primary.triggerDetail,
    invocationSource: primary.invocationSource,
  });

  if (!primaryBatchable) {
    return {
      primary,
      siblings: [],
      batch: [],
      held: false,
      holdReason: null,
    };
  }

  const seenIssueIds = new Set<string>([primaryIssueId]);
  const siblings: BatchPickupRunLike[] = [];
  for (const candidate of prioritized.slice(1)) {
    if (siblings.length + 1 >= maxBatch) break;
    if (
      !isBatchableAssignmentWake({
        contextSnapshot: candidate.contextSnapshot,
        triggerDetail: candidate.triggerDetail,
        invocationSource: candidate.invocationSource,
      })
    ) {
      continue;
    }
    const issueId = readIssueIdFromContext(candidate.contextSnapshot);
    if (!issueId || seenIssueIds.has(issueId)) continue;
    seenIssueIds.add(issueId);
    siblings.push(candidate);
  }

  if (
    shouldHoldSingleBatchableForWindow({
      runCreatedAt: primary.createdAt,
      siblingCount: siblings.length,
      windowMs,
      now,
    })
  ) {
    return {
      primary,
      siblings: [],
      batch: [],
      held: true,
      holdReason: "lane_batch_window",
    };
  }

  const batch: BatchIssueEntry[] = [];
  const pushEntry = (run: BatchPickupRunLike) => {
    const issueId = readIssueIdFromContext(run.contextSnapshot);
    if (!issueId) return;
    const meta = input.issueMetaById?.get(issueId);
    batch.push({
      issueId,
      runId: run.id,
      wakeReason: readWakeReasonFromContext(run.contextSnapshot) ?? "issue_assigned",
      priority: meta?.priority ?? null,
      status: meta?.status ?? null,
      identifier: meta?.identifier ?? null,
      title: meta?.title ?? null,
      queuedAt: new Date(toTimeMs(run.createdAt)).toISOString(),
    });
  };
  pushEntry(primary);
  for (const sibling of siblings) pushEntry(sibling);

  return {
    primary,
    siblings,
    batch,
    held: false,
    holdReason: null,
  };
}

export function buildIssueBatchContextPatch(input: {
  batch: BatchIssueEntry[];
  absorbedRunIds: string[];
  laneClass: BatchLaneClass;
  windowMs: number;
}): Record<string, unknown> {
  const orderedIssueIds = input.batch.map((entry) => entry.issueId);
  return {
    [BATCH_ISSUE_PICKUP_CONTEXT_KEY]: {
      version: 1,
      mode: "claim_time_assignment_batch",
      primaryIssueId: orderedIssueIds[0] ?? null,
      orderedIssueIds,
      issues: input.batch,
      absorbedRunIds: input.absorbedRunIds,
      processDirective:
        "Process issues in orderedIssueIds order to a full disposition each. " +
        "Do not stop after the primary issue if budget remains. " +
        "Unfinished trailing issues are re-queued by the platform when this run ends.",
    },
    [BATCH_ISSUE_PICKUP_META_KEY]: {
      enabled: true,
      laneClass: input.laneClass,
      windowMs: input.windowMs,
      batchSize: input.batch.length,
      absorbedRunCount: input.absorbedRunIds.length,
    },
  };
}

/**
 * Issues from a finished batch run that still need a fresh assignment wake.
 * Terminal statuses and issues no longer assigned to the finishing agent are skipped.
 */
export function selectUnfinishedBatchIssuesForRequeue(input: {
  batchIssueIds: string[];
  primaryIssueId: string | null;
  issueStates: Array<{
    id: string;
    status: string;
    assigneeAgentId: string | null;
  }>;
  finishingAgentId: string;
}): string[] {
  const stateById = new Map(input.issueStates.map((row) => [row.id, row]));
  const unfinished: string[] = [];
  for (const issueId of input.batchIssueIds) {
    if (input.primaryIssueId && issueId === input.primaryIssueId) {
      // Primary keeps normal latch/continuation machinery; only siblings need
      // explicit requeue when the shared run ends without per-issue disposition.
      continue;
    }
    const state = stateById.get(issueId);
    if (!state) continue;
    if (state.assigneeAgentId !== input.finishingAgentId) continue;
    if (state.status === "done" || state.status === "cancelled") continue;
    unfinished.push(issueId);
  }
  return unfinished;
}

export function extractBatchIssueIdsFromContext(contextSnapshot: unknown): string[] {
  const context = parseObject(contextSnapshot);
  const batch = parseObject(context[BATCH_ISSUE_PICKUP_CONTEXT_KEY]);
  if (Array.isArray(batch.orderedIssueIds)) {
    return batch.orderedIssueIds
      .map((value) => readNonEmptyString(value))
      .filter((value): value is string => Boolean(value));
  }
  if (Array.isArray(batch.issues)) {
    return batch.issues
      .map((entry) => readIssueIdFromContext(entry))
      .filter((value): value is string => Boolean(value));
  }
  return [];
}
