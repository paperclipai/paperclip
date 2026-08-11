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
      FROM agents AS return_agent
      WHERE issues.company_id = $1
        AND issues.id = $2
        AND issues.status IN ('todo','in_progress','in_review') AND issues.hidden_at IS NULL
        AND execution_state->>'lastDecisionOutcome' = 'changes_requested'
        AND execution_state->'returnAssignee'->>'type' = 'agent'
        AND execution_state->'returnAssignee'->>'agentId' = return_agent.id::text
        AND return_agent.company_id = issues.company_id
        AND execution_state->>'status' = 'changes_requested'
        AND (execution_state->'currentParticipant'->>'agentId') IS DISTINCT FROM (execution_state->'returnAssignee'->>'agentId')
      RETURNING issues.id, issues.company_id, issues.identifier,
        execution_state->'returnAssignee' AS return_assignee
    ), logged AS (
      INSERT INTO activity_log (
        company_id, actor_type, actor_id, action, entity_type, entity_id,
        agent_id, details
      )
      SELECT company_id, 'system', 'paperclip-babysitter',
        'recovery.changes_requested_participant_repaired', 'issue', id::text,
        (return_assignee->>'agentId')::uuid,
        jsonb_build_object(
          'source', 'recovery.reconcile_stranded_assigned_issues',
          'issueIdentifier', identifier,
          'returnAssignee', return_assignee
        )
      FROM updated
      RETURNING entity_id
    ) SELECT coalesce(string_agg(entity_id, ','), '') FROM logged;
  `;
}

/** Execute the reviewed CAS repair against one company/issue subject. */
export function reconcileChangesRequested(psql, { companyId, issueId }) {
  if (typeof psql !== "function" || !companyId || !issueId) {
    throw new TypeError("psql, companyId, and issueId are required");
  }
  return psql(changesRequestedRepairSql(), [companyId, issueId]);
}

export function shouldRepairChangesRequested(state) {
  return state?.status === "changes_requested"
    && state?.lastDecisionOutcome === "changes_requested"
    && state?.returnAssignee?.type === "agent"
    && Boolean(state.returnAssignee.agentId)
    && state?.currentParticipant?.agentId !== state.returnAssignee.agentId;
}
