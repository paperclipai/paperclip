import { createHash } from "node:crypto";

/**
 * Short debounce for equivalent issue wakes. This is not the no-progress
 * rewake cooldown: a material fingerprint change, an explicit user wake, or a
 * failure retry always admits a new request. Five seconds covers overlapping
 * comment, child-completion, blocker, and monitor emissions of the same work
 * without holding later distinct work.
 */
export const WAKE_REQUEST_COALESCE_WINDOW_MS = 5_000;

export const WAKE_EQUIVALENCE_PAYLOAD_KEY = "_paperclipWakeEquivalence";

export const WAKE_REQUEST_COALESCED_ACTIVITY_ACTION = "wakeup.coalesced";

/**
 * Only a wake that still owns pending execution may absorb a duplicate.
 * A completed or already-coalesced row must not swallow a later wake.
 */
export const WAKE_REQUEST_COALESCE_TARGET_STATUSES = [
  "queued",
  "claimed",
  "deferred_issue_execution",
] as const;

const VOLATILE_PAYLOAD_KEYS = new Set([
  "requestedAt",
  "createdAt",
  "updatedAt",
  "occurredAt",
  "timestamp",
  "now",
  "sentAt",
  "idempotencyKey",
  "requestId",
  "nonce",
  "traceId",
  "spanId",
  WAKE_EQUIVALENCE_PAYLOAD_KEY,
]);

const SCOPE_PAYLOAD_KEYS = new Set([
  "issueId",
  "taskId",
  "taskKey",
  "companyId",
  "agentId",
]);

export type WakeCoalesceExemption =
  | "explicit_user_wake"
  | "retry_after_failure"
  | "durable_receipt"
  | "interaction_continuation"
  | "force_fresh_session"
  | "run_coalescing_disabled"
  | "unknown_blocker_state";

export type WakeEquivalenceStamp = {
  v: 1;
  fingerprint: string;
  issueId: string;
};

export type WakeEquivalenceMaterial = {
  companyId: string;
  agentId: string;
  issueId: string;
  ownerAgentId: string | null;
  issueStatus: string;
  issueStatusVersion: number;
  blockerState: string | null;
  payload: Record<string, unknown> | null;
};

export type StoredWakeEquivalence = {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string;
  status: string;
  requestedAt: Date;
  fingerprint: string | null;
  runId: string | null;
  coalescedCount: number;
};

export type WakeCoalesceDecision =
  | { coalesce: false }
  | { coalesce: true; relation: "equivalent_pending" };

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Canonical JSON with sorted object keys. Arrays keep their order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function materialPayload(payload: Record<string, unknown> | null): Record<string, unknown> {
  if (!payload) return {};
  const material: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (VOLATILE_PAYLOAD_KEYS.has(key) || SCOPE_PAYLOAD_KEYS.has(key)) continue;
    if (value === undefined) continue;
    material[key] = value;
  }
  return material;
}

export function readWakeEquivalenceStamp(payload: unknown): WakeEquivalenceStamp | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const stamp = (payload as Record<string, unknown>)[WAKE_EQUIVALENCE_PAYLOAD_KEY];
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return null;
  const fingerprint = readNonEmptyString((stamp as Record<string, unknown>).fingerprint);
  const issueId = readNonEmptyString((stamp as Record<string, unknown>).issueId);
  if (!fingerprint || !issueId || (stamp as Record<string, unknown>).v !== 1) return null;
  return { v: 1, fingerprint, issueId };
}

/** Stamp issue scope wins over a missing or conflicting caller `issueId`. */
export function readWakeRequestIssueScope(payload: unknown): string | null {
  const stamp = readWakeEquivalenceStamp(payload);
  if (stamp) return stamp.issueId;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return readNonEmptyString((payload as Record<string, unknown>).issueId);
}

export function stampWakeEquivalencePayload(
  payload: Record<string, unknown> | null,
  stamp: WakeEquivalenceStamp,
): Record<string, unknown> {
  return {
    ...(stripWakeEquivalencePayload(payload) ?? {}),
    issueId: stamp.issueId,
    [WAKE_EQUIVALENCE_PAYLOAD_KEY]: stamp,
  };
}

/** Drop the internal stamp so it cannot ride along into a prompt snapshot. */
export function stripWakeEquivalencePayload<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (!Object.prototype.hasOwnProperty.call(payload, WAKE_EQUIVALENCE_PAYLOAD_KEY)) return payload;
  const copy = { ...(payload as Record<string, unknown>) };
  delete copy[WAKE_EQUIVALENCE_PAYLOAD_KEY];
  return copy as T;
}

export function wakeRequestCoalesceExemption(input: {
  manualUserWake?: boolean;
  failedRunId?: string | null;
  wakeReason?: string | null;
  requestedByActorType?: string | null;
  triggerDetail?: string | null;
  durableReceipt?: boolean;
  interactionContinuation?: boolean;
  forceFreshSession?: boolean;
  allowRunCoalescing?: boolean;
  blockerStateKnown: boolean;
}): WakeCoalesceExemption | null {
  if (input.manualUserWake) return "explicit_user_wake";
  if (
    input.requestedByActorType === "user" &&
    input.triggerDetail === "manual"
  ) {
    return "explicit_user_wake";
  }
  if (input.failedRunId || input.wakeReason === "retry_failed_run") return "retry_after_failure";
  if (input.durableReceipt) return "durable_receipt";
  if (input.interactionContinuation) return "interaction_continuation";
  if (input.forceFreshSession) return "force_fresh_session";
  if (input.allowRunCoalescing === false) return "run_coalescing_disabled";
  if (!input.blockerStateKnown) return "unknown_blocker_state";
  return null;
}

export function buildWakeEquivalenceFingerprint(input: WakeEquivalenceMaterial): string {
  return sha256(stableStringify({
    v: 1,
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    ownerAgentId: input.ownerAgentId,
    issueStatus: input.issueStatus,
    issueStatusVersion: input.issueStatusVersion,
    blockerState: input.blockerState,
    payload: materialPayload(input.payload),
  }));
}

export function formatBlockerState(input: {
  known: boolean;
  ready: boolean;
  unresolvedBlockerIssueIds: readonly string[];
  blockedTransitionAt?: Date | string | null;
}): string | null {
  if (!input.known) return null;
  const cycle = input.blockedTransitionAt instanceof Date
    ? input.blockedTransitionAt.toISOString()
    : readNonEmptyString(input.blockedTransitionAt) ?? "none";
  const blockers = [...new Set(input.unresolvedBlockerIssueIds.filter(Boolean))].sort();
  return `${input.ready ? "ready" : "blocked"}|${blockers.join(",")}|${cycle}`;
}

export function decideEquivalentWakeCoalescing(input: {
  now: Date;
  windowMs?: number;
  incomingFingerprint: string;
  incoming: { companyId: string; agentId: string; issueId: string };
  candidate: StoredWakeEquivalence | null;
}): WakeCoalesceDecision {
  const candidate = input.candidate;
  if (!candidate?.fingerprint) return { coalesce: false };
  if (candidate.companyId !== input.incoming.companyId) return { coalesce: false };
  if (candidate.agentId !== input.incoming.agentId) return { coalesce: false };
  if (candidate.issueId !== input.incoming.issueId) return { coalesce: false };
  if (candidate.fingerprint !== input.incomingFingerprint) return { coalesce: false };
  if (!WAKE_REQUEST_COALESCE_TARGET_STATUSES.includes(
    candidate.status as (typeof WAKE_REQUEST_COALESCE_TARGET_STATUSES)[number],
  )) {
    return { coalesce: false };
  }
  const windowMs = input.windowMs ?? WAKE_REQUEST_COALESCE_WINDOW_MS;
  const ageMs = input.now.getTime() - candidate.requestedAt.getTime();
  if (ageMs < 0 || ageMs > windowMs) return { coalesce: false };
  return { coalesce: true, relation: "equivalent_pending" };
}

export function selectCoalesceTarget(
  incoming: { companyId: string; agentId: string; issueId: string; fingerprint: string },
  candidates: readonly StoredWakeEquivalence[],
  now: Date,
  windowMs: number = WAKE_REQUEST_COALESCE_WINDOW_MS,
): { target: StoredWakeEquivalence; decision: Extract<WakeCoalesceDecision, { coalesce: true }> } | null {
  const ordered = [...candidates].sort((left, right) => right.requestedAt.getTime() - left.requestedAt.getTime());
  for (const candidate of ordered) {
    const decision = decideEquivalentWakeCoalescing({
      now,
      windowMs,
      incomingFingerprint: incoming.fingerprint,
      incoming,
      candidate,
    });
    if (decision.coalesce) return { target: candidate, decision };
  }
  return null;
}
