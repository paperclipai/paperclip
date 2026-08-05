// A blocked issue with no first-class blocker relation is only legitimate when the
// description names an explicit external gate OR a validated unblockDescriptor is
// present (optionally with blockedUntil for a first-class date gate). Shared by the
// route-level guard in routes/issues.ts and the service-level enter-blocked guard in
// services/issues.ts so every writer enforces the same contract. Lives in its own
// module so route tests that mock services/issues.js keep the real implementation.

import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export function hasExplicitExternalOwnerAction(description: unknown): boolean {
  if (typeof description !== "string" || description.trim().length === 0) return false;
  const owner = description.match(/^\s*external owner\s*:\s*(.+)$/im)?.[1]?.trim();
  const action = description.match(/^\s*external action\s*:\s*(.+)$/im)?.[1]?.trim();
  return Boolean(owner && action);
}

/** True when a structured unblockDescriptor is present with owner + action. */
export function hasUnblockDescriptor(descriptor: unknown): descriptor is IssueUnblockDescriptor {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return false;
  const value = descriptor as Partial<IssueUnblockDescriptor>;
  if (typeof value.action !== "string" || value.action.trim().length === 0) return false;
  const owner = value.owner;
  if (owner === "board") return true;
  if (!owner || typeof owner !== "object") return false;
  if ("agentId" in owner && typeof owner.agentId === "string" && owner.agentId.length > 0) return true;
  if ("userId" in owner && typeof owner.userId === "string" && owner.userId.length > 0) return true;
  return false;
}

/**
 * First-class date gate on the API descriptor (`blockedUntil` ISO timestamp).
 * This is the durable form of the `blocked-until-<timestamp>` convention.
 */
export function unblockDescriptorHasDateGate(descriptor: unknown): boolean {
  if (!hasUnblockDescriptor(descriptor)) return false;
  const until = (descriptor as IssueUnblockDescriptor).blockedUntil;
  if (typeof until !== "string" || until.trim().length === 0) return false;
  const ms = Date.parse(until);
  return Number.isFinite(ms);
}

/** Sanctioned no-link block: external owner/action prose OR a validated descriptor. */
export function hasSanctionedNoLinkBlockReason(input: {
  description?: unknown;
  unblockDescriptor?: unknown;
}): boolean {
  return hasExplicitExternalOwnerAction(input.description) || hasUnblockDescriptor(input.unblockDescriptor);
}

// A calendar date inside the sanctioned gate lines makes the wait a DATE gate: something must
// act at or after a wall-clock moment. Unlike an open-ended external-review wait, a date gate
// opens onto a deadline — and if no permissioned agent is named to wake on it, the gate opens
// onto nobody and expires silently (RCA 2026-07-31: TSMC-18536/18564/18560/18601 all blew
// unexecuted for four hours). Detection mirrors ~/scripts/date-gate-executor-guard.py (Layer 1):
// ISO (2026-07-31) or long form (July 31, 2026), scanned ONLY inside the External owner:/External
// action: line contents so unrelated dates elsewhere in the description (acceptance criteria,
// provenance, bench references) never trip it — a dateless external-review wait is a legitimate,
// different shape and stays creatable without an assignee.
const GATE_LINE_RE = /^\s*external (?:owner|action)\s*:\s*(.+)$/gim;
const GATE_DATE_ISO_RE = /20\d{2}-\d{2}-\d{2}/;
const GATE_DATE_LONG_RE =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2}\b/i;

export function blockedGateLinesCarryDate(description: unknown): boolean {
  if (typeof description !== "string" || description.trim().length === 0) return false;
  for (const match of description.matchAll(GATE_LINE_RE)) {
    const line = match[1] ?? "";
    if (GATE_DATE_ISO_RE.test(line) || GATE_DATE_LONG_RE.test(line)) return true;
  }
  return false;
}

// Layer 2 of the 2026-07-31 silent-gate-miss fix (prevention at write time; Layer 1 is the
// hourly guard). A date-gated blocker must name a permissioned executor to wake when the gate
// opens — `local-board` and a bare external owner cannot run. Whether the named lane is actually
// ALIVE is a runtime property the guard owns; write time can only insist that a lane is NAMED,
// i.e. that assigneeAgentId is present. Returns true when the block is malformed and must be
// rejected. Recovery escalation writers stamp DATELESS gate lines, so this is inert for them.
// Also covers first-class API date gates via unblockDescriptor.blockedUntil (TSMC-19681).
export function dateGatedBlockerMissingExecutor(input: {
  description: unknown;
  assigneeAgentId: string | null | undefined;
  unblockDescriptor?: unknown;
}): boolean {
  const hasDateGate =
    blockedGateLinesCarryDate(input.description) || unblockDescriptorHasDateGate(input.unblockDescriptor);
  return hasDateGate && !input.assigneeAgentId;
}

// Message intentionally names the required field, the way the existing enter-blocked error does.
export const DATE_GATED_BLOCKER_REQUIRES_ASSIGNEE_MESSAGE =
  "Issue cannot be blocked on a date gate without an assigneeAgentId: the External owner:/External " +
  "action: lines (or unblockDescriptor.blockedUntil) name a calendar date but no permissioned agent " +
  "to wake when the gate opens (local-board and a bare external owner cannot run). Assign a live " +
  "agent lane before blocking.";

export const BLOCKED_REQUIRES_SANCTIONED_REASON_MESSAGE =
  "Issue cannot enter blocked without unresolved blockedByIssueIds, external owner/action, or unblockDescriptor";

export const BLOCKED_CREATE_REQUIRES_SANCTIONED_REASON_MESSAGE =
  "Issue cannot be created blocked without unresolved blockedByIssueIds, external owner/action, or unblockDescriptor";

/** Issue read/list payload keys that form the blocked-gate contract surface. */
export const ISSUE_BLOCKED_GATE_PAYLOAD_KEYS = [
  "status",
  "unblockDescriptor",
  "blockedBy",
  "blockedTransitionAt",
  "blockedOwnerNotifiedAt",
  "monitorNextCheckAt",
  "executionPolicy",
] as const;
