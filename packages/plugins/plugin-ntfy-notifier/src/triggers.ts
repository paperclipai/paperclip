/**
 * Pure classification of Paperclip plugin events into "a decision is waiting
 * for a person" candidates. No I/O happens here so every rule is unit-tested.
 *
 * Event payloads are produced by the host activity log: the activity
 * `details` object is spread at the top level of `payload`, next to
 * `agentId`, `runId` and `responsibleUserId`.
 */

import type { NotifierTriggers } from "./config.js";

/** Activity action the host logs when an issue thread interaction is created. */
export const INTERACTION_CREATED = "issue.thread_interaction_created";
/**
 * Host event for an issue entering or leaving computed blocker attention. Not
 * yet emitted to plugins by stock hosts; handled once a host emits it.
 */
export const BLOCKER_ATTENTION_CHANGED = "issue.blocker_attention_changed";
/** Activity action the host logs when an agent opens a board decision. */
export const DECISION_CREATED = "decision.created";

/**
 * Who an interaction card is for, judged from the event payload alone.
 * - `human`: the payload carries an explicit `addresseeAgentId` key and it is empty.
 * - `agent`: the payload names an agent addressee.
 * - `unknown`: the payload has no `addresseeAgentId` key at all. A missing key
 *   is never read as "human"; the notifier resolves it from the host or skips.
 * - `not_pending`: the card is already resolved.
 */
export type InteractionRouting = "human" | "agent" | "unknown" | "not_pending";

export type DecisionCandidate =
  | { kind: "approval"; companyId: string; approvalId: string; issueId: string | null; toolActionRequestId: string | null }
  | {
      kind: "interaction";
      companyId: string;
      interactionId: string;
      issueId: string;
      routing: "human" | "unknown";
      toolActionRequestId: string | null;
    }
  /** Needs a host read to confirm the human-owned unblock descriptor. */
  | { kind: "blocker"; companyId: string; issueId: string }
  /** A blocked tree whose terminal blocker has no live path (host-computed). */
  | {
      kind: "blocker_tree";
      companyId: string;
      issueId: string;
      /** Feed dedupKey, `blocker:<terminal blocker id>`. */
      dedupKey: string;
      /** The blocked issue the feed groups under this terminal blocker, when known. */
      blockedIssueId: string | null;
      /** `enter`: the item entered the feed (or is open at a host-boot baseline); `exit`: it left. */
      phase: "enter" | "exit";
      baseline: boolean;
    }
  | { kind: "decision"; companyId: string; decisionId: string; issueId: string | null };

export interface EventLike {
  eventType: string;
  companyId: string;
  entityId?: string;
  entityType?: string;
  payload: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function classifyApproval(event: EventLike, payload: Record<string, unknown>): DecisionCandidate | null {
  if (event.entityType !== undefined && event.entityType !== "approval") return null;
  const approvalId = nonEmptyString(event.entityId);
  if (!approvalId) return null;
  const issueIds = Array.isArray(payload.issueIds) ? payload.issueIds : [];
  const issueId = issueIds.map(nonEmptyString).find((id): id is string => id !== null) ?? null;
  // A tool-gateway approval and its approval card are one decision; both
  // events carry the tool action request id, which becomes the dedupe key.
  const toolActionRequestId = payload.source === "tool_gateway" ? nonEmptyString(payload.actionRequestId) : null;
  return { kind: "approval", companyId: event.companyId, approvalId, issueId, toolActionRequestId };
}

/**
 * Routing for an interaction card. This matches the board inbox, which lists
 * pending interactions whose `addresseeAgentId` is null (optionally narrowed
 * to one `addresseeUserId`). An agent addressee is agent-to-agent traffic.
 *
 * The board inbox also lists cards whose agent addressee is no longer
 * invokable. The host only accepts an invokable agent addressee when a card is
 * created, so at creation time an agent-addressed card is never in the inbox.
 */
export function interactionRouting(details: Record<string, unknown>): InteractionRouting {
  const status = details.interactionStatus;
  if (status !== undefined && status !== null && status !== "pending") return "not_pending";
  if (!Object.prototype.hasOwnProperty.call(details, "addresseeAgentId")) return "unknown";
  return nonEmptyString(details.addresseeAgentId) ? "agent" : "human";
}

/** True only for a card the payload itself proves is for a person. */
export function isHumanAddressedInteraction(details: Record<string, unknown>): boolean {
  return interactionRouting(details) === "human";
}

function classifyInteraction(event: EventLike, details: Record<string, unknown>): DecisionCandidate | null {
  if (event.entityType !== undefined && event.entityType !== "issue") return null;
  const issueId = nonEmptyString(event.entityId) ?? nonEmptyString(details.issueId);
  const interactionId = nonEmptyString(details.interactionId);
  if (!issueId || !interactionId) return null;
  const routing = interactionRouting(details);
  if (routing !== "human" && routing !== "unknown") return null;
  return {
    kind: "interaction",
    companyId: event.companyId,
    interactionId,
    issueId,
    routing,
    toolActionRequestId: nonEmptyString(details.toolActionRequestId),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Host-computed blocker attention: a blocked issue whose blocker tree has no
 * live path, grouped by its terminal blocker like the board attention feed.
 * The host emits `entered: true` when an item enters the feed (or, with
 * `baseline: true`, for the items still open at the first evaluation after a
 * host boot) and `entered: false` when it leaves. One feed episode is one
 * decision: the notifier keeps a durable open/closed record per terminal
 * blocker, keyed by the feed's own `dedupKey` (`blocker:<terminal>`).
 */
function classifyBlockerAttention(event: EventLike, payload: Record<string, unknown>): DecisionCandidate | null {
  if (event.entityType !== undefined && event.entityType !== "issue") return null;
  const terminalId = nonEmptyString(payload.terminalBlockerIssueId) ?? nonEmptyString(event.entityId);
  if (!terminalId || !UUID_PATTERN.test(terminalId)) return null;
  const dedupKey = nonEmptyString(payload.dedupKey);
  if (dedupKey !== `blocker:${terminalId}`) return null;
  const base = {
    kind: "blocker_tree" as const,
    companyId: event.companyId,
    issueId: terminalId,
    dedupKey,
    blockedIssueId: nonEmptyString(payload.blockedIssueId),
  };
  if (payload.entered === false) return { ...base, phase: "exit", baseline: false };
  if (payload.state !== "stalled" && payload.state !== "needs_attention") return null;
  if (payload.blockingTreeLive !== false) return null;
  const activityAt = nonEmptyString(payload.activityAt);
  if (!activityAt || Number.isNaN(Date.parse(activityAt))) return null;
  return { ...base, phase: "enter", baseline: payload.baseline === true };
}

function classifyDecision(event: EventLike, payload: Record<string, unknown>): DecisionCandidate | null {
  if (event.entityType !== undefined && event.entityType !== "decision") return null;
  const decisionId = nonEmptyString(event.entityId);
  if (!decisionId) return null;
  return { kind: "decision", companyId: event.companyId, decisionId, issueId: nonEmptyString(payload.originIssueId) };
}

/**
 * `issue.updated` is a candidate only when the issue is now blocked and the
 * update moved it into `blocked` or changed its unblock descriptor. Whether a
 * person owns the unblock step is confirmed against the current issue.
 */
function classifyIssueUpdated(event: EventLike, payload: Record<string, unknown>): DecisionCandidate | null {
  const issueId = nonEmptyString(event.entityId);
  if (!issueId) return null;
  const changes = asRecord(payload.changes) ?? {};
  const statusChange = asRecord(changes.status);
  const previous = asRecord(payload._previous);
  const enteredBlocked = statusChange
    ? statusChange.to === "blocked" && statusChange.from !== "blocked"
    : payload.status === "blocked" && previous !== null && "status" in previous && previous.status !== "blocked";
  const descriptorChanged = "unblockDescriptor" in changes;
  if (!enteredBlocked && !descriptorChanged) return null;
  if (!enteredBlocked && payload.status !== undefined && payload.status !== "blocked") return null;
  return { kind: "blocker", companyId: event.companyId, issueId };
}

export function classifyEvent(event: EventLike, triggers: NotifierTriggers): DecisionCandidate | null {
  const payload = asRecord(event.payload);
  if (!payload || !nonEmptyString(event.companyId)) return null;

  switch (event.eventType) {
    case "approval.created":
      return triggers.approvals ? classifyApproval(event, payload) : null;
    case INTERACTION_CREATED:
      return triggers.interactions ? classifyInteraction(event, payload) : null;
    case "activity.logged": {
      // Not emitted to plugins by current hosts; accepted defensively in case a
      // host forwards raw activity rows (`{ action, details, entityId }`).
      if (!triggers.interactions || payload.action !== INTERACTION_CREATED) return null;
      const details = asRecord(payload.details) ?? payload;
      return classifyInteraction(
        { ...event, entityId: nonEmptyString(payload.entityId) ?? event.entityId, entityType: nonEmptyString(payload.entityType) ?? event.entityType },
        details,
      );
    }
    case "issue.updated":
      return triggers.blockerAttention ? classifyIssueUpdated(event, payload) : null;
    case BLOCKER_ATTENTION_CHANGED:
      return triggers.blockerAttention ? classifyBlockerAttention(event, payload) : null;
    case DECISION_CREATED:
      return triggers.decisions ? classifyDecision(event, payload) : null;
    default:
      return null;
  }
}

export interface IssueBlockerView {
  status?: string | null;
  unblockDescriptor?: { owner?: unknown } | null;
  blockedTransitionAt?: string | Date | null;
}

/** Mirrors the board attention rule for a human-owned unblock descriptor. */
export function isHumanOwnedBlocker(issue: IssueBlockerView): boolean {
  if (issue.status !== "blocked") return false;
  const owner = issue.unblockDescriptor?.owner;
  if (owner === "board") return true;
  const ownerRecord = asRecord(owner);
  return ownerRecord !== null && nonEmptyString(ownerRecord.userId) !== null;
}

/**
 * Dedupe identity for one blocked episode of an issue. A new episode (the
 * issue leaves and re-enters `blocked`) gets a new transition timestamp.
 */
export function blockerDecisionKey(issueId: string, issue: IssueBlockerView): string {
  const at = issue.blockedTransitionAt;
  const stamp = at instanceof Date ? at.toISOString() : nonEmptyString(at) ?? "unknown";
  return `blocker:${issueId}:${stamp}`;
}

/**
 * Episode record for a computed blocker-attention item: the board feed's own
 * `dedupKey` (`blocker:<terminal issue id>`). It is open while the item is in
 * the feed and closed when the host reports that it left.
 */
export function blockerTreeEpisodeKey(dedupKey: string): string {
  return `episode:${dedupKey}`;
}
