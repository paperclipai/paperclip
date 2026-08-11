/**
 * Reviewed source for the changes-requested reconciliation used by the
 * Paperclip babysitter. ECO-1123 is the canonical PM key; Paperclip remains
 * an execution projection. Keep this logic generic and subject-bound.
 *
 * The important invariant is compare-and-set: historical outcome alone never
 * overwrites a newer, explicitly restored pending participant.
 */

export function changesRequestedRepairSql() {
  return `
    WITH updated AS (
      UPDATE issues SET
        execution_state = jsonb_set(execution_state, '{currentParticipant}', execution_state->'returnAssignee'),
        updated_at = now()
      WHERE status IN ('todo','in_progress') AND hidden_at IS NULL
        AND execution_state->>'lastDecisionOutcome' = 'changes_requested'
        AND execution_state->'returnAssignee'->>'agentId' IS NOT NULL
        AND execution_state->>'status' = 'changes_requested'
        AND (execution_state->'currentParticipant'->>'agentId') IS DISTINCT FROM (execution_state->'returnAssignee'->>'agentId')
      RETURNING identifier
    ) SELECT coalesce(string_agg(identifier, ','), '') FROM updated;
  `;
}

export function shouldRepairChangesRequested(state) {
  return state?.status === "changes_requested"
    && state?.lastDecisionOutcome === "changes_requested"
    && state?.returnAssignee?.type === "agent"
    && Boolean(state.returnAssignee.agentId)
    && state?.currentParticipant?.agentId !== state.returnAssignee.agentId;
}
