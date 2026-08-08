import type {
  InterruptedRunRecovery,
  InterruptedRunRecoveryReceiptOutcome,
  InterruptedRunRecoveryState,
  IssueRecoveryAction,
  IssueScheduledRetry,
} from "@paperclipai/shared";
import { formatRetryReason } from "./runRetryState";

/**
 * Interrupted-run recovery slot (PAP-16730 Phase 5B, spec §1).
 *
 * A task can have at most ONE recovery card at a time. Today two mount points
 * can both speak about the same interruption (`IssueScheduledRetryCard` on the
 * detail page and `IssueRecoveryActionCard` in the thread notice stack). This
 * module is the single arbiter: it folds the Phase 5A read model
 * (`Issue.interruptedRunRecovery`) and the pre-5A fallbacks (`scheduledRetry`,
 * `activeRecoveryAction`) into one variant, in the spec's priority order.
 *
 * Deliberate non-goals:
 *  - It never infers health from run data the payload doesn't carry. An older
 *    server that omits `interruptedRunRecovery` and carries no interruption
 *    signal resolves to `null`, and the surfaces render exactly as they do
 *    today.
 *  - Cleanup (`issue.stale_lock_cleared`) is not an input. Clearing a stale
 *    lock is housekeeping, not progress, and must never move this slot.
 */
export type RecoverySlotVariant =
  /** D — an owner has to act; the recovery-action card renders instead. */
  | "recovery_owner_required"
  /** A — the run was interrupted and a successor is scheduled. */
  | "retry_queued"
  /** B — the successor is live and continuing the work. */
  | "recovered"
  /** C — bounded retries are used up. */
  | "retry_exhausted"
  /** C — automatic retry was deliberately withheld. */
  | "suppressed"
  /** C — interrupted with no retry and no recovery scheduled (the PAP-16728 shape). */
  | "pathless";

/** Which mount owns the winning variant. */
export type RecoverySlotCard = "recovery_action" | "retry";

/**
 * Run error codes that mean *interrupted* (the process went away) rather than
 * *failed* (the work ran and did not succeed). Interruption is what this slot
 * explains; ordinary failures keep the existing retry card copy.
 */
export const INTERRUPTION_ERROR_CODES: readonly string[] = [
  "server_shutdown_interrupted",
  "process_lost",
];

/** Scheduled-retry reasons raised by an interruption. */
export const INTERRUPTION_RETRY_REASONS: readonly string[] = [
  "process_lost",
  "process_lost_retry",
  "server_shutdown_interrupted",
  "assignment_recovery",
];

export function isInterruptionSignal(
  reason: string | null | undefined,
  errorCode: string | null | undefined,
): boolean {
  const normalizedReason = typeof reason === "string" ? reason.trim() : "";
  const normalizedCode = typeof errorCode === "string" ? errorCode.trim() : "";
  return (
    (normalizedReason.length > 0 && INTERRUPTION_RETRY_REASONS.includes(normalizedReason))
    || (normalizedCode.length > 0 && INTERRUPTION_ERROR_CODES.includes(normalizedCode))
  );
}

export interface RecoverySlotSource {
  issueStatus?: string | null;
  interruptedRunRecovery?: InterruptedRunRecovery | null;
  scheduledRetry?: IssueScheduledRetry | null;
  activeRecoveryAction?: IssueRecoveryAction | null;
  /** Agent that owns the interrupted run, for run-detail links. */
  agentId?: string | null;
}

export interface RecoverySlot {
  variant: RecoverySlotVariant;
  card: RecoverySlotCard;
  /** True when the server supplied the Phase 5A read model. */
  fromReadModel: boolean;
  interruptedRunId: string | null;
  successorRunId: string | null;
  agentId: string | null;
  interruptedAt: Date | string | null;
  errorCode: string | null;
  receiptId: string | null;
  receiptOutcome: InterruptedRunRecoveryReceiptOutcome | null;
  /** Bounded, non-secret; rendered verbatim. */
  suppressionReason: string | null;
  /** Bounded, non-secret; rendered verbatim. */
  escalationReason: string | null;
  attempt: number | null;
  maxAttempts: number | null;
  /** A scheduled retry the operator can pull forward with "Retry now". */
  promotableRetry: boolean;
}

const LIVE_SUCCESSOR_STATUSES: readonly string[] = ["queued", "running"];
const TERMINAL_ISSUE_STATUSES: readonly string[] = ["done", "cancelled"];

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Priority order from spec §1. First match wins; every branch is reachable
 * from either the read model or the pre-5A fallbacks.
 */
export function resolveRecoverySlot(source: RecoverySlotSource): RecoverySlot | null {
  const { issueStatus, interruptedRunRecovery: model, scheduledRetry, activeRecoveryAction } = source;

  // Pri 1 — a finished task never explains an interruption.
  if (issueStatus && TERMINAL_ISSUE_STATUSES.includes(issueStatus)) return null;

  const serverState: InterruptedRunRecoveryState | null = model?.state ?? null;
  const receiptOutcome = model?.receiptOutcome ?? null;
  const successorStatus = readNonEmptyString(model?.successorStatus);
  const retryStatus = scheduledRetry?.status ?? null;
  const retryReason = scheduledRetry?.scheduledRetryReason ?? null;
  const retryExhaustedReason = readNonEmptyString(scheduledRetry?.retryExhaustedReason);
  const promotableRetry = retryStatus === "scheduled_retry";

  // Pre-5A fallback gate: with no read model we only claim an interruption when
  // the retry metadata actually says so. Anything else keeps today's behavior.
  const interruptionSignal = model != null
    || isInterruptionSignal(retryReason, scheduledRetry?.errorCode);

  const base = {
    fromReadModel: model != null,
    interruptedRunId: readNonEmptyString(model?.interruptedRunId)
      ?? readNonEmptyString(scheduledRetry?.retryOfRunId),
    successorRunId: readNonEmptyString(model?.successorRunId)
      ?? (retryStatus === "queued" || retryStatus === "running"
        ? readNonEmptyString(scheduledRetry?.runId)
        : null),
    agentId: readNonEmptyString(source.agentId) ?? readNonEmptyString(scheduledRetry?.agentId),
    interruptedAt: model?.interruptedAt ?? null,
    errorCode: readNonEmptyString(model?.errorCode)
      ?? readNonEmptyString(scheduledRetry?.errorCode)
      // Pre-5A payloads carry the interruption on the retry reason instead.
      ?? (retryReason && INTERRUPTION_RETRY_REASONS.includes(retryReason) ? retryReason : null),
    receiptId: readNonEmptyString(model?.receiptId),
    receiptOutcome,
    suppressionReason: readNonEmptyString(model?.suppressionReason),
    escalationReason: readNonEmptyString(model?.escalationReason) ?? retryExhaustedReason,
    attempt: readPositiveInt(model?.attempt) ?? readPositiveInt(scheduledRetry?.scheduledRetryAttempt),
    maxAttempts: readPositiveInt(model?.maxAttempts),
    promotableRetry,
  } satisfies Omit<RecoverySlot, "variant" | "card">;

  // Pri 2 — an open recovery action owns the slot. Only the recovery-action
  // card speaks while someone has to act; the retry card stands down.
  const actionStatus = activeRecoveryAction?.status ?? null;
  if (actionStatus === "active" || actionStatus === "escalated") {
    return { ...base, variant: "recovery_owner_required", card: "recovery_action" };
  }
  if (serverState === "recovery_owner_required") {
    return { ...base, variant: "recovery_owner_required", card: "recovery_action" };
  }

  if (!interruptionSignal) return null;

  // The server runs the same table, so when it supplies a state that state is
  // authoritative for pri 3-5. Only pre-5A payloads fall through to the
  // client-side derivation below.
  if (serverState !== null) {
    return { ...base, variant: serverState, card: "retry" };
  }

  // Pri 3 — a live successor reads as recovery, not as a pending promise.
  const hasLiveSuccessor =
    (successorStatus !== null && LIVE_SUCCESSOR_STATUSES.includes(successorStatus))
    || ((retryStatus === "queued" || retryStatus === "running")
      && readNonEmptyString(scheduledRetry?.retryOfRunId) !== null);
  if (hasLiveSuccessor) {
    return { ...base, variant: "recovered", card: "retry" };
  }

  // Pri 4 — a bounded retry is on the way.
  if (receiptOutcome === "queued" || promotableRetry) {
    return { ...base, variant: "retry_queued", card: "retry" };
  }

  // Pri 5 — no live path: exhausted, withheld, or nothing scheduled at all.
  if (receiptOutcome === "suppressed") {
    return { ...base, variant: "suppressed", card: "retry" };
  }
  if (receiptOutcome === "escalated" || retryExhaustedReason) {
    return { ...base, variant: "retry_exhausted", card: "retry" };
  }

  // Pri 6 — healthy live run, valid waiting path, receipt waiting/terminal.
  return null;
}

export interface RecoverySlotTone {
  /** Card shell. */
  container: string;
  /** Badge pill. */
  badge: string;
}

const NEUTRAL_TONE: RecoverySlotTone = {
  container: "border-border/60",
  badge: "border-border bg-muted text-muted-foreground",
};

const BLUE_TONE: RecoverySlotTone = {
  container: "border-blue-500/30 bg-blue-500/5",
  badge: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
};

const AMBER_TONE: RecoverySlotTone = {
  container: "border-amber-500/30 bg-amber-500/10",
  badge: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

export type RecoverySlotIcon = "clock" | "rotate" | "alert";

export interface RecoverySlotPresentation {
  badgeLabel: string;
  icon: RecoverySlotIcon;
  tone: RecoverySlotTone;
  /** Second line under the headline. Null when the state has nothing to add. */
  body: string | null;
  /** Whether this variant offers the "Retry now" control. */
  showRetryNow: boolean;
}

function shortId(id: string | null): string | null {
  if (!id) return null;
  return id.length > 8 ? id.slice(0, 8) : id;
}

export { shortId as shortRecoveryId };

/**
 * Exact copy from spec §6. Reason and suppression strings render verbatim —
 * never summarized into a friendlier-but-vaguer phrase.
 */
export function describeRecoverySlot(slot: RecoverySlot): RecoverySlotPresentation | null {
  if (slot.card !== "retry") return null;

  if (slot.variant === "retry_queued") {
    const reasonLabel = formatRetryReason(slot.errorCode);
    const isRestart = slot.errorCode === "server_shutdown_interrupted";
    return {
      badgeLabel: "Retry queued",
      icon: "clock",
      tone: BLUE_TONE,
      body: isRestart || !reasonLabel
        ? "The last run was interrupted by a server restart. Work resumes automatically — nothing is needed from you."
        : `The last run was interrupted (${reasonLabel}). Work resumes automatically — nothing is needed from you.`,
      showRetryNow: slot.promotableRetry,
    };
  }

  if (slot.variant === "recovered") {
    return {
      badgeLabel: "Recovered",
      icon: "rotate",
      tone: NEUTRAL_TONE,
      body: null,
      showRetryNow: false,
    };
  }

  if (slot.variant === "suppressed") {
    return {
      // §6 gives C only "Retry exhausted" / "No recovery scheduled". Reusing
      // "exhausted" here would contradict the body — the retries were withheld,
      // not spent — so the withheld sub-state gets its own label.
      badgeLabel: "Retry withheld",
      icon: "alert",
      tone: AMBER_TONE,
      body: slot.suppressionReason
        ? `Automatic retry withheld: ${slot.suppressionReason}.`
        : "Automatic retry withheld.",
      showRetryNow: slot.promotableRetry,
    };
  }

  if (slot.variant === "pathless") {
    return {
      badgeLabel: "No recovery scheduled",
      icon: "alert",
      tone: AMBER_TONE,
      body: "Paperclip should repair this automatically. If this card persists, open a typed recovery action or escalate to a recovery owner.",
      showRetryNow: slot.promotableRetry,
    };
  }

  return {
    badgeLabel: "Retry exhausted",
    icon: "alert",
    tone: AMBER_TONE,
    body: slot.escalationReason,
    showRetryNow: slot.promotableRetry,
  };
}

/** Headline sentence. Variant A's timing fragment is supplied by the caller. */
export function recoverySlotHeadline(
  slot: RecoverySlot,
  options: { relativeDue?: string | null } = {},
): string {
  if (slot.variant === "retry_queued") {
    const relative = options.relativeDue ?? null;
    if (relative === "now") return "Automatic retry due now";
    if (relative) return `Automatic retry ${relative}`;
    return "Automatic retry pending schedule";
  }
  if (slot.variant === "recovered") {
    const successor = shortId(slot.successorRunId);
    return successor
      ? `Recovered after restart — run ${successor} is continuing the work.`
      : "Recovered after restart — a successor run is continuing the work.";
  }
  if (slot.variant === "pathless") {
    return "The last run was interrupted and no retry or recovery is scheduled.";
  }
  if (slot.variant === "suppressed") {
    return "Automatic retry is withheld. A recovery owner is needed to continue.";
  }
  return "Automatic retries are used up. A recovery owner is needed to continue.";
}

/** `Attempt {n} of {max}` — omitted entirely when the bound is unknown. */
export function recoveryAttemptLabel(slot: Pick<RecoverySlot, "attempt" | "maxAttempts">): string | null {
  if (slot.attempt === null) return null;
  return slot.maxAttempts === null
    ? `Attempt ${slot.attempt}`
    : `Attempt ${slot.attempt} of ${slot.maxAttempts}`;
}

/** Tooltip for the receipt chip: full id plus the outcome that produced it. */
export function receiptChipTitle(slot: Pick<RecoverySlot, "receiptId" | "receiptOutcome">): string | null {
  if (!slot.receiptId) return null;
  return slot.receiptOutcome ? `${slot.receiptId} · ${slot.receiptOutcome}` : slot.receiptId;
}

// ── Blocked-parent leaf chips (spec §4) ──────────────────────────────────────

export interface LeafRecoveryChip {
  label: string;
  className: string;
  /** A/B leaves resume on their own; C/D leaves need an owner. */
  needsOwner: boolean;
}

/**
 * Interruption states worth naming on a blocked parent. State A is included
 * here (the parent's operator wants to know *why* the chain paused) but
 * intentionally shows no chip at list level — a queued bounded retry is
 * healthy in-progress work.
 */
const LEAF_RECOVERY_CHIPS: Partial<Record<InterruptedRunRecoveryState, LeafRecoveryChip>> = {
  retry_queued: {
    label: "Retry queued",
    className: "border-blue-500/60 bg-blue-500/15 text-blue-700 dark:text-blue-300",
    needsOwner: false,
  },
  retry_exhausted: {
    label: "Retry exhausted",
    className: "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    needsOwner: true,
  },
  suppressed: {
    label: "Retry withheld",
    className: "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    needsOwner: true,
  },
  pathless: {
    label: "No recovery scheduled",
    className: "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-300",
    needsOwner: true,
  },
};

export function leafRecoveryChip(
  state: InterruptedRunRecoveryState | null | undefined,
): LeafRecoveryChip | null {
  if (!state) return null;
  return LEAF_RECOVERY_CHIPS[state] ?? null;
}

/**
 * A leaf is "unhealthy" when it is in an interruption state the parent should
 * name. State `recovered` is explicitly healthy: its successor is live, so the
 * chain still counts as covered.
 */
export function isUnhealthyLeafRecoveryState(
  state: InterruptedRunRecoveryState | null | undefined,
): boolean {
  if (!state) return false;
  return state !== "recovered";
}

/**
 * True for C/D leaves — the ones that cannot resume without an owner. Drives
 * the blocked-parent body sentence (spec §4.2); A/B leaves get the
 * "resumes automatically" wording instead.
 */
export function leafRecoveryNeedsOwner(
  state: InterruptedRunRecoveryState | null | undefined,
): boolean {
  if (!state) return false;
  if (state === "recovery_owner_required") return true;
  return leafRecoveryChip(state)?.needsOwner ?? false;
}
