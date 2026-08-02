// A blocked issue with no first-class blocker relation is only legitimate when the
// description names an explicit external gate. Shared by the route-level guard in
// routes/issues.ts and the service-level enter-blocked guard in services/issues.ts so
// every writer enforces the same contract. Lives in its own module so route tests that
// mock services/issues.js keep the real implementation.
export function hasExplicitExternalOwnerAction(description: unknown): boolean {
  if (typeof description !== "string" || description.trim().length === 0) return false;
  const owner = description.match(/^\s*external owner\s*:\s*(.+)$/im)?.[1]?.trim();
  const action = description.match(/^\s*external action\s*:\s*(.+)$/im)?.[1]?.trim();
  return Boolean(owner && action);
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
export function dateGatedBlockerMissingExecutor(input: {
  description: unknown;
  assigneeAgentId: string | null | undefined;
}): boolean {
  return blockedGateLinesCarryDate(input.description) && !input.assigneeAgentId;
}

// Message intentionally names the required field, the way the existing enter-blocked error does.
export const DATE_GATED_BLOCKER_REQUIRES_ASSIGNEE_MESSAGE =
  "Issue cannot be blocked on a date gate without an assigneeAgentId: the External owner:/External " +
  "action: lines name a calendar date but no permissioned agent to wake when the gate opens " +
  "(local-board and a bare external owner cannot run). Assign a live agent lane before blocking.";
