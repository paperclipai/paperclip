import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type { TrustPresetResolution } from "./trust-preset-resolver.js";

/**
 * Derive exact-task authority from existing server-owned execution records.
 * Responsible-user attribution alone is insufficient: it is also inherited by
 * agent-created work. Never read authority or retry ancestry from tool payloads.
 */
export async function withHumanDirectedWork(
  db: Pick<Db, "execute">,
  resolution: TrustPresetResolution,
  input: { companyId: string; agentId: string; runId: string },
): Promise<TrustPresetResolution> {
  if (resolution.kind !== "low_trust_review" ||
      resolution.boundary.companyId !== input.companyId) return resolution;

  // One snapshot binds the live run, current assignee, and authenticated wake.
  // Reassignment cancels the old request records in the assignment transaction.
  // Neither those records nor cancelled executions can lend authority to retries.
  // UNION deduplicates rows so a malformed retry cycle terminates without a cap.
  const [issue] = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE current_task AS (
      SELECT i.id, i.conversation_agent_id, i.conversation_user_id, r.id AS run_id
      FROM heartbeat_runs r
      JOIN issues i ON i.id::text = coalesce(r.context_snapshot->>'issueId', r.context_snapshot->>'taskId')
        AND i.company_id = r.company_id AND i.assignee_agent_id = r.agent_id
      WHERE r.id = ${input.runId}::uuid AND r.company_id = ${input.companyId}::uuid
        AND r.agent_id = ${input.agentId}::uuid AND r.status = 'running'
    ), task_runs AS (
      SELECT r.id, r.retry_of_run_id
      FROM heartbeat_runs r JOIN current_task t ON t.run_id = r.id
      UNION
      SELECT parent.id, parent.retry_of_run_id
      FROM heartbeat_runs parent JOIN task_runs child ON parent.id = child.retry_of_run_id
      JOIN current_task t ON t.id::text = coalesce(parent.context_snapshot->>'issueId', parent.context_snapshot->>'taskId')
      WHERE parent.company_id = ${input.companyId}::uuid AND parent.agent_id = ${input.agentId}::uuid
        AND parent.status <> 'cancelled'
    )
    SELECT t.id FROM current_task t
    WHERE (t.conversation_agent_id = ${input.agentId}::uuid AND t.conversation_user_id IS NOT NULL)
      OR EXISTS (
        SELECT 1 FROM agent_wakeup_requests w
        WHERE (w.run_id IN (SELECT id FROM task_runs) OR
            (w.run_id IS NULL AND w.reason = 'issue_human_assignment' AND w.status = 'completed'))
        AND w.company_id = ${input.companyId}::uuid AND w.agent_id = ${input.agentId}::uuid
          AND w.requested_by_actor_type = 'user' AND nullif(trim(w.requested_by_actor_id), '') IS NOT NULL
          AND w.status NOT IN ('skipped', 'cancelled')
          -- The source is copied from server-owned context at admission, never
          -- from caller payloads. Plugins can attribute a user but use plugin: sources.
          AND (w.payload->'_paperclipWakeContext'->>'source' LIKE 'issue.%'
            -- Before origin snapshots were retained, board assignment requests
            -- already had this closed source/reason/actor combination. Plugin
            -- assignment wakes are system-attributed; plugin human comments are
            -- automation wakes. External connector receipts are excluded below.
            OR (NOT (w.payload ? '_paperclipWakeContext')
              AND w.source = 'assignment' AND w.reason = 'issue_assigned'))
          AND coalesce(w.payload->>'issueId', w.payload->>'taskId',
            w.payload->'_paperclipWakeContext'->>'issueId', w.payload->'_paperclipWakeContext'->>'taskId') = t.id::text
          -- Connector sender attribution can also use a user id. Its durable
          -- inbound receipts are not authenticated board instructions.
          AND (w.idempotency_key IS NULL OR w.idempotency_key NOT LIKE 'chat-inbound:%')
      )
  `);
  return issue ? { ...resolution, humanDirectedIssueId: issue.id } : resolution;
}

/** Preserve a board assignment made before a task is runnable, without starting it.
 * Uses the existing requester columns, not another user identity or grant table.
 * Call only with the authenticated HTTP actor and the committed write result.
 */
export async function retainBacklogHumanAssignment(
  db: Db,
  issue: { id: string; companyId: string; assigneeAgentId: string | null; status: string; statusVersion: number },
  actor: { actorType: string; actorId: string },
) {
  if (actor.actorType !== "user" || !actor.actorId.trim() || issue.status !== "backlog" || !issue.assigneeAgentId) return;
  await db.transaction(async (tx) => {
    // An assignment that changed (even A -> B -> A) before this callback cannot
    // revive stale direction. Reassignment and this receipt share the issue lock.
    const [current] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, issue.id), eq(issues.companyId, issue.companyId),
      eq(issues.assigneeAgentId, issue.assigneeAgentId!), eq(issues.statusVersion, issue.statusVersion),
    )).for("update");
    if (!current) return;
    await tx.insert(agentWakeupRequests).values({
      companyId: issue.companyId, agentId: issue.assigneeAgentId!, source: "assignment",
      reason: "issue_human_assignment", status: "completed", finishedAt: new Date(),
      requestedByActorType: "user", requestedByActorId: actor.actorId,
      payload: { issueId: issue.id, _paperclipWakeContext: { source: "issue.backlog_assignment" } },
    });
  });
}
