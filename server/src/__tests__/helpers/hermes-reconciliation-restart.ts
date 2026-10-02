// Invoked only by heartbeat-hermes-reconciliation.test.ts in a fresh process.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createDb, heartbeatRuns, issueRecoveryActions } from "@paperclipai/db";
import { heartbeatService } from "../../services/heartbeat.ts";
import { adapterExecutionControls } from "../../services/adapter-execution-control.js";

const { connectionString, agentId, issueId, runId } = JSON.parse(process.argv[2]);
assert.equal(new URL(connectionString).hostname, "127.0.0.1");
const db = createDb(connectionString);
try {
  assert.equal(adapterExecutionControls.size, 0);
  const heartbeat = heartbeatService(db);
  await heartbeat.reapOrphanedRuns();
  await heartbeat.reconcileStrandedAssignedIssues();
  await heartbeat.reconcileResolvedDependencyWakes();
  const retry = await heartbeat.scheduleBoundedRetry(runId);
  assert.equal(retry.outcome, "not_scheduled");
  assert.equal("errorCode" in retry ? retry.errorCode : null, "legacy_execution_requires_reconciliation");
  const wake = await heartbeat.wakeup(agentId, {
    source: "automation", triggerDetail: "system", reason: "issue_assigned",
    payload: { issueId }, contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    requestedByActorType: "user", requestedByActorId: "test-board",
  });
  assert.equal(wake, null);
  await heartbeat.drainActiveRunExecutions();
  const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  assert.deepEqual(runs.map(row => row.id), [runId]);
  const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  assert(actions.some(row => row.cause === "legacy_execution_requires_reconciliation" && row.ownerType === "board"));
  console.log("hermes-restart-hold-ok");
} finally {
  await db.$client.end({ timeout: 0 });
}
