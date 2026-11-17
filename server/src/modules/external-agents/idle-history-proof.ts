import { finishedIdleRun } from "../../services/idle-work-proof.js";

function completedAssignment(alias: string, provider: "dot" | "muse"): string {
  const muse = provider === "muse";
  const identity = muse ? 'muse' : 'openai_dot';
  return `EXISTS (SELECT 1 FROM ${provider}_agent_bindings binding JOIN heartbeat_runs run
      ON run.id = ${alias}.run_id AND run.company_id = binding.company_id AND run.agent_id = binding.agent_id
      WHERE binding.id = ${alias}.binding_id AND binding.company_id = ${alias}.company_id
        ${muse ? '' : "AND binding.provider_kind = 'openai_dot'"}
        AND binding.agent_id = ${alias}.agent_id AND ${alias}.binding_generation > 0
        AND ${alias}.binding_generation <= binding.generation AND ${finishedIdleRun('run')}
        AND ((${alias}.status = 'settled' AND ${muse
    ? `run.status = 'succeeded' AND ${alias}.accepted_result_at IS NOT NULL AND ${alias}.finalized_at = run.finished_at`
    : `${alias}.settled_at IS NOT NULL`})
          OR (${alias}.status = 'fenced' AND (${alias}.${muse ? 'claimed_at' : 'accepted_at'} IS NULL
            OR EXISTS (SELECT 1 FROM external_agent_holds h WHERE h.provider = '${identity}'
              AND ${muse ? 'true' : 'false'}
              AND h.assignment_id = ${alias}.id AND h.company_id = ${alias}.company_id
              AND h.agent_id = ${alias}.agent_id AND h.run_id = ${alias}.run_id
              AND h.binding_id = ${alias}.binding_id AND h.binding_generation = ${alias}.binding_generation
              AND h.released_at IS NOT NULL AND NOT h.worker_unknown AND NOT h.native_effects_unknown))))
        AND NOT EXISTS (SELECT 1 FROM external_agent_holds h WHERE h.provider = '${identity}'
          AND h.assignment_id = ${alias}.id AND (h.company_id <> ${alias}.company_id
            OR h.run_id <> ${alias}.run_id OR h.binding_id <> ${alias}.binding_id
            OR h.binding_generation <> ${alias}.binding_generation OR h.agent_id <> ${alias}.agent_id
            OR h.released_at IS NULL OR h.worker_unknown OR h.native_effects_unknown)))`;
}

function completedOperation(alias: string, provider: "dot" | "muse"): string {
  return `${alias}.status IN (${provider === 'dot' ? "'completed', 'rejected'" : "'settled', 'rejected'"})
    AND jsonb_typeof(${alias}.outcome) = 'object'
    AND EXISTS (SELECT 1 FROM ${provider}_runner_assignments a WHERE a.id = ${alias}.assignment_id
      AND a.company_id = ${alias}.company_id AND (${completedAssignment('a', provider)}))`;
}

function assignmentCheck(provider: "dot" | "muse") {
  return { reason: `${provider}_runner_assignments`, query: `SELECT 1 FROM ${provider}_runner_assignments a WHERE (
    (${completedAssignment('a', provider)}) AND NOT EXISTS (SELECT 1 FROM ${provider}_runner_operations o
      WHERE o.assignment_id = a.id AND (o.company_id <> a.company_id OR (${completedOperation('o', provider)}) IS NOT TRUE))) IS NOT TRUE` };
}

function mailboxCheck(provider: "dot" | "muse") {
  return { reason: `${provider}_mailbox_items`, query: `SELECT 1 FROM ${provider}_mailbox_items m WHERE (
    EXISTS (SELECT 1 FROM ${provider}_agent_bindings b WHERE b.id = m.binding_id AND b.company_id = m.company_id
      AND m.binding_generation > 0 AND m.binding_generation <= b.generation)
    AND ((m.assignment_id IS NOT NULL AND m.kind IN ('assignment', 'operation_result', 'follow_up', 'authority_revoked'${provider === 'muse' ? ", 'input_available'" : ''})
      AND EXISTS (SELECT 1 FROM ${provider}_runner_assignments a WHERE a.id = m.assignment_id
        AND a.company_id = m.company_id AND a.binding_id = m.binding_id AND a.binding_generation = m.binding_generation
        AND (${completedAssignment('a', provider)})))
      OR (m.assignment_id IS NULL AND m.kind = 'readiness_challenge' AND EXISTS (
        SELECT 1 FROM ${provider}_agent_bindings b WHERE b.id = m.binding_id AND b.company_id = m.company_id
          AND b.status = 'revoked' AND b.revoked_at IS NOT NULL)))) IS NOT TRUE` };
}

export const idleExternalAgentHistoryChecks = [
  { reason: "dot_agent_bindings", query: `SELECT 1 FROM dot_agent_bindings b WHERE (
    b.provider_kind = 'openai_dot' AND b.status = 'revoked' AND b.revoked_at IS NOT NULL AND b.pairing_code_hash IS NULL
    AND b.challenge_hash IS NULL AND EXISTS (SELECT 1 FROM agents a WHERE a.id = b.agent_id AND a.company_id = b.company_id)
    AND (b.grant_id IS NULL OR EXISTS (SELECT 1 FROM mcp_oauth_grants g
      WHERE g.id = b.grant_id AND g.company_id = b.company_id AND g.user_id = b.operator_id
        AND g.agent_id = b.agent_id AND g.purpose = 'agent' AND g.revoked_at IS NOT NULL))) IS NOT TRUE` },
  { reason: "muse_agent_bindings", query: `SELECT 1 FROM muse_agent_bindings b WHERE (
    b.status = 'revoked' AND b.revoked_at IS NOT NULL AND b.ticket_hash IS NULL AND b.challenge_hash IS NULL
    AND ((b.qualification_id IS NULL AND b.detector_removal_requested_at IS NULL)
      OR (b.detector_removed_at IS NOT NULL AND b.detector_removed_at >= b.detector_removal_requested_at))
    AND EXISTS (SELECT 1 FROM agents a WHERE a.id = b.agent_id AND a.company_id = b.company_id)
    AND (b.grant_id IS NULL OR EXISTS (SELECT 1 FROM mcp_oauth_grants g
      WHERE g.id = b.grant_id AND g.company_id = b.company_id AND g.user_id = b.operator_id
        AND g.agent_id = b.agent_id AND g.purpose = 'agent' AND g.revoked_at IS NOT NULL))) IS NOT TRUE` },
  { reason: "muse_credentials", query: `SELECT 1 FROM muse_credentials c WHERE (
    c.kind IN ('access', 'refresh', 'signal', 'cleanup', 'detector_cleanup')
    AND (c.revoked_at IS NOT NULL OR c.consumed_at IS NOT NULL OR c.expires_at <= now())
    AND EXISTS (SELECT 1 FROM muse_agent_bindings b WHERE b.id = c.binding_id AND b.company_id = c.company_id
      AND c.binding_generation > 0 AND c.binding_generation <= b.generation)) IS NOT TRUE` },
  assignmentCheck('dot'), assignmentCheck('muse'),
  { reason: "dot_runner_operations", query: `SELECT 1 FROM dot_runner_operations o WHERE (${completedOperation('o', 'dot')}) IS NOT TRUE` },
  { reason: "muse_runner_operations", query: `SELECT 1 FROM muse_runner_operations o WHERE (${completedOperation('o', 'muse')}) IS NOT TRUE` },
  mailboxCheck('dot'), mailboxCheck('muse'),
  { reason: "muse_input_deliveries", query: `SELECT 1 FROM muse_input_deliveries i WHERE (
    EXISTS (SELECT 1 FROM muse_runner_assignments a WHERE a.id = i.assignment_id AND a.company_id = i.company_id
      AND a.turn_id = i.turn_id AND (${completedAssignment('a', 'muse')}))) IS NOT TRUE` },
  { reason: "external_agent_holds", query: `SELECT 1 FROM external_agent_holds h WHERE (
    h.provider = 'muse' AND h.released_at IS NOT NULL AND NOT h.worker_unknown AND NOT h.native_effects_unknown
    AND EXISTS (SELECT 1 FROM muse_runner_assignments a WHERE a.id = h.assignment_id
      AND a.company_id = h.company_id AND a.agent_id = h.agent_id AND a.run_id = h.run_id
      AND a.binding_id = h.binding_id AND a.binding_generation = h.binding_generation
      AND (h.operator_attested_at IS NOT NULL OR (a.status = 'settled' AND a.accepted_result_at IS NOT NULL))
      AND (${completedAssignment('a', 'muse')}))) IS NOT TRUE` },
] as const;
