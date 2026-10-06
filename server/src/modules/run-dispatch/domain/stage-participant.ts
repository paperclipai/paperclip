// Pure classifier for the execution-stage participant fact both run-dispatch
// gates honour. It reads only the issue's stored execution state, never the
// wake context: the stage wake the assignee flip produced can carry any
// context shape (the deferred-wake path rebuilds it), so the proof has to
// come from the issue row itself.

function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * True when the run's agent is the participant a still-pending execution
 * stage has selected: `executionState.currentParticipant`, which every
 * pending state names. The stage entry that selects a participant also
 * flips the issue's assignee to them, and the stage wake it queues can be
 * dispatched before that flip is visible, or long after a checkout has moved
 * the issue to `in_progress` and a hand-back has moved the assignee
 * elsewhere. None of those make the selected participant a stranger to the
 * issue, so a pending stage settles ownership on its own, regardless of the
 * issue status the existing in-review bypass keys on.
 *
 * Membership in the stage's configured participants is deliberately not
 * enough. A stage lists every agent it may select; once one is selected the
 * others are exactly as much strangers to the issue as the assignee column
 * says they are, and a run of theirs must be cancelled or held like any
 * other reassigned run. The in-review bypass already keys on the selected
 * participant alone; this fact is that rule made independent of the issue
 * status, not a wider one.
 *
 * The state is read defensively rather than through the zod schema so a
 * stored state the strict normaliser would reject still yields a decision
 * instead of an exception inside a dispatch transaction.
 */
export function isCurrentStageParticipant(input: {
  agentId: string;
  executionState: unknown;
}): boolean {
  const state = parseObject(input.executionState);
  if (state.status !== "pending") return false;
  const participant = parseObject(state.currentParticipant);
  return (
    participant.type === "agent" &&
    readNonEmptyString(participant.agentId) === input.agentId
  );
}
