import { writeExecutionControl } from "./execution-control-notifications.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, chatActions, chatConversations, chatEndpoints, heartbeatRuns, issues, issueComments, runIdentityContexts, issueRecoveryActions, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import { persistActivity } from "./activity-log.js";
import { createSystemRecovery, readSystemRecovery } from "./system-recovery-state.js";
import { adoptSystemRecovery, updateSystemRecovery } from "./system-recovery.js";
import { instanceSettingsService } from "./instance-settings.js";
import { notifyChatActionWork } from "./chat-work-notifications.js";
import { authorizationService } from "./authorization.js";
import { preserveNativeFailedWorkspace } from "./native-runtime/native-failed-workspace-recovery.js";
import { NativeWorkspaceFinalizationBusyError } from "./native-runtime/native-workspace-finalization-ownership.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";

export async function taskRetryMutationAllowed(db: Db, input: {
  companyId: string; issueId: string; actorId: string; actorSource: TaskRetryIntent["actorSource"];
}) {
  const [issue] = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId }).from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!issue) return false;
  const permission = await authorizationService(db).decide({
    actor: { type: "board", userId: input.actorId, source: input.actorSource }, action: "issue:mutate",
    resource: { type: "issue", companyId: input.companyId, issueId: input.issueId, ...issue },
  });
  return permission.allowed;
}

export async function assertTaskRetryConversationAllowed(
  db: Db,
  issue: { conversationAgentId?: string | null; conversationUserId?: string | null },
  actorId: string,
) {
  if (!issue.conversationAgentId) return;
  if (!(await instanceSettingsService(db).getExperimental()).enableAgentChat) throw notFound("Agent Chat is disabled");
  if (issue.conversationUserId !== actorId) throw forbidden("Only the conversation owner can retry a chat run");
}

const taskRetryIntentSchema = z.object({
  schema: z.literal("paperclip.task-retry.v1"), generationId: z.string().uuid(), sourceRunId: z.string().uuid(),
  actorId: z.string().min(1), actorSource: z.enum(["local_implicit", "session", "board_key", "cloud_tenant"]).default("session"), strategy: z.enum(["evaluate", "continue", "fresh_isolated_workspace", "finalize_result"]),
  chatActionId: z.string().uuid().optional(), canonicalIntentId: z.string().uuid().optional(),
  boardMessageOrigin: z.object({ commentId: z.string().uuid(), identityContextId: z.string().uuid() }).optional(),
});
export type TaskRetryIntent = z.infer<typeof taskRetryIntentSchema>;
export function readTaskRetryIntent(payload: Record<string, unknown> | null | undefined): TaskRetryIntent | null {
  const result = taskRetryIntentSchema.safeParse(payload?.taskRetry);
  return result.success ? result.data : null;
}

/** A board message has its own accepted user identity, not an external inbound
 * receipt. Certify its exact unchanged source and retained pre-provider evidence;
 * this selects the canonical Retry owner and never substitutes chat authority.
 * Normal queue containment and current permissions still govern dispatch. */
export async function readTaskRetryBoardMessageOrigin(db: Db, input: {
  companyId: string; issueId: string; agentId: string; sourceRunId: string; actorId: string;
}) {
  return readBoardMessageRetrySource(db, input, new Set<string>());
}

async function readBoardMessageRetrySource(db: Db, input: {
  companyId: string; issueId: string; agentId: string; sourceRunId: string; actorId: string;
}, seen: Set<string>): Promise<{ commentId: string; identityContextId: string } | null> {
  if (seen.size >= 20 || seen.has(input.sourceRunId) || adapterExecutionControls.has(input.sourceRunId)) return null;
  seen.add(input.sourceRunId);
  const [task] = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), eq(issues.assigneeAgentId, input.agentId),
    sql`${issues.status} not in ('done', 'cancelled')`));
  if (!task) return null;
  const sourceConditions = [
      eq(heartbeatRuns.id, input.sourceRunId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.responsibleUserId, input.actorId),
      eq(heartbeatRuns.status, "failed"), eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.errorCode, "setup_failed"),
      sql`${heartbeatRuns.finishedAt} is not null`,
      sql`(${heartbeatRuns.issueId} is null or ${heartbeatRuns.issueId} = ${input.issueId}::uuid)`,
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
      sql`(${heartbeatRuns.contextSnapshot}->>'taskId' is null or ${heartbeatRuns.contextSnapshot}->>'taskId' = ${input.issueId})`,
      sql`${heartbeatRuns.resultJson}#>>'{executionRecovery,kind}' = 'bootstrap'`,
      sql`${heartbeatRuns.resultJson}#>'{executionRecovery,providerWorkStarted}' = 'false'::jsonb`,
      sql`${heartbeatRuns.resultJson}->>'stopReason' = 'adapter_failed'`,
      sql`not exists (select 1 from jsonb_object_keys(case when jsonb_typeof(${heartbeatRuns.resultJson}) = 'object'
        then ${heartbeatRuns.resultJson} else '{}'::jsonb end) key
        where key not in ('effectiveTimeoutSec', 'executionRecovery', 'stopReason', 'timeoutConfigured', 'timeoutFired', 'timeoutSource'))`,
      sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch' = '{"adapterType":"paperclip_runner"}'::jsonb`,
      sql`not exists (select 1 from jsonb_object_keys(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object'
        then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) key
        where key not in ('adapterDispatch', 'aiConnectionNonAssigneeCommentWake', 'chatControlRecoveryAdmission'))`,
      ...[heartbeatRuns.nativeIssueId, heartbeatRuns.nativeSessionId, heartbeatRuns.nativePhase,
        heartbeatRuns.runtimeModeResolvedAt, heartbeatRuns.runtimeModeResolverVersion, heartbeatRuns.runtimeModeReason, heartbeatRuns.driverKind, heartbeatRuns.driverVersion,
        heartbeatRuns.completionContractId, heartbeatRuns.runnerInstanceId, heartbeatRuns.sessionIdAfter,
        heartbeatRuns.externalRunId, heartbeatRuns.processPid, heartbeatRuns.processGroupId, heartbeatRuns.processStartedAt,
        heartbeatRuns.logStore, heartbeatRuns.logRef, heartbeatRuns.logBytes, heartbeatRuns.logSha256, heartbeatRuns.stdoutExcerpt,
        heartbeatRuns.stderrExcerpt, heartbeatRuns.lastOutputAt, heartbeatRuns.lastOutputBytes,
        heartbeatRuns.lastOutputStream, heartbeatRuns.exitCode, heartbeatRuns.signal].map(column => sql`${column} is null`),
      sql`${heartbeatRuns.lastOutputSeq} = 0`, sql`not ${heartbeatRuns.logCompressed}`,
      sql`(${heartbeatRuns.usageJson} is null or ${heartbeatRuns.usageJson} - 'ledgerScope' = '{}'::jsonb)`,
      sql`(${heartbeatRuns.controllerLeaseExpiresAt} is null or ${heartbeatRuns.controllerLeaseExpiresAt} <= now())`,
      sql`not exists (select 1 from native_run_results where company_id = ${input.companyId}::uuid and run_id = ${input.sourceRunId}::uuid)`,
      sql`not exists (select 1 from native_run_finalizations where company_id = ${input.companyId}::uuid and run_id = ${input.sourceRunId}::uuid)`,
      sql`not exists (select 1 from environment_leases where company_id = ${input.companyId}::uuid and heartbeat_run_id = ${input.sourceRunId}::uuid)`,
      sql`exists (select 1 from heartbeat_run_events where company_id = ${input.companyId}::uuid and run_id = ${input.sourceRunId}::uuid
        and event_type = 'error' and stream = 'system' and source_event_id is null and message = ${heartbeatRuns.error})`,
      sql`exists (select 1 from heartbeat_run_events where company_id = ${input.companyId}::uuid and run_id = ${input.sourceRunId}::uuid
        and event_type = 'lifecycle' and stream = 'system' and source_event_id is null and message = 'task.run.measured'
        and payload->>'durableSettlement' = 'true' and payload->>'outcome' = 'failed')`,
      sql`not exists (select 1 from heartbeat_run_events where company_id = ${input.companyId}::uuid and run_id = ${input.sourceRunId}::uuid
        and (stream <> 'system' or source_event_id is not null or source_instance_id is not null or source_seq is not null
          or source_payload_sha256 is not null or protocol_schema_version is not null or event_type not in ('error', 'agent_observability.unavailable', 'lifecycle')
          or (event_type = 'lifecycle' and (message <> 'task.run.measured' or payload->>'durableSettlement' is distinct from 'true'))
          or (event_type = 'error' and message is distinct from ${heartbeatRuns.error})))`,
  ];
  const [origin] = await db.select({ commentId: issueComments.id, identityContextId: runIdentityContexts.id })
    .from(heartbeatRuns)
    .innerJoin(runIdentityContexts, and(eq(runIdentityContexts.id, heartbeatRuns.activeIdentityContextId),
      eq(runIdentityContexts.companyId, input.companyId), eq(runIdentityContexts.runId, heartbeatRuns.id),
      eq(runIdentityContexts.status, "accepted"), eq(runIdentityContexts.responsibleUserId, input.actorId)))
    .innerJoin(issueComments, and(eq(issueComments.id, runIdentityContexts.messageId),
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.authorType, "user"), eq(issueComments.authorUserId, input.actorId),
      sql`${issueComments.createdByRunId} is null`, sql`${issueComments.deletedAt} is null`,
      eq(issueComments.createdAt, issueComments.updatedAt), sql`nullif(trim(${issueComments.body}), '') is not null`))
    .innerJoin(agentWakeupRequests, and(eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.runId, heartbeatRuns.id), eq(agentWakeupRequests.requestedByActorType, "user"),
      eq(agentWakeupRequests.requestedByActorId, input.actorId), eq(agentWakeupRequests.reason, "issue_reopened_via_comment"), eq(agentWakeupRequests.status, "failed"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
      sql`${agentWakeupRequests.payload}->>'commentId' = ${issueComments.id}::text`))
    .where(and(...sourceConditions,
      sql`${heartbeatRuns.contextSnapshot}->>'source' = 'issue.comment.reopen'`,
      sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${issueComments.id}::text`,
      sql`${heartbeatRuns.contextSnapshot}->'wakeCommentIds' = jsonb_build_array(${issueComments.id}::text)`,
    )).limit(1);
  if (origin) return origin;
  // A repeated preparation failure must retain the same certified board
  // source through its real coalesced intent and failed dispatch receipt.
  // Every predecessor is checked again; cycles and long damaged chains fail closed.
  const [successor] = await db.select({ identityContextId: heartbeatRuns.activeIdentityContextId,
    retryId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'taskRetryRequestId'`,
    previousRunId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'previousRunId'`,
    dispatchKey: agentWakeupRequests.idempotencyKey }).from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, and(eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.runId, heartbeatRuns.id), eq(agentWakeupRequests.status, "failed"),
      eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.requestedByActorType, "user"),
      eq(agentWakeupRequests.requestedByActorId, input.actorId)))
    .where(and(...sourceConditions, sql`${heartbeatRuns.contextSnapshot}->'boardMessageRetry' = 'true'::jsonb`)).limit(1);
  if (!successor?.identityContextId || !z.string().uuid().safeParse(successor.retryId).success ||
      successor.dispatchKey !== `task-retry-dispatch:${successor.retryId}`) return null;
  const [receipt] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, String(successor.retryId)), eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.runId, input.sourceRunId),
    eq(agentWakeupRequests.status, "coalesced"), eq(agentWakeupRequests.reason, "task_retry"),
    eq(agentWakeupRequests.requestedByActorType, "user"), eq(agentWakeupRequests.requestedByActorId, input.actorId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`));
  const intent = readTaskRetryIntent(receipt?.payload);
  if (!intent?.boardMessageOrigin || intent.generationId !== receipt!.id || intent.actorId !== input.actorId ||
      intent.chatActionId || intent.canonicalIntentId || intent.sourceRunId !== successor.previousRunId) return null;
  const [identity] = await db.select({ id: runIdentityContexts.id }).from(runIdentityContexts).where(and(
    eq(runIdentityContexts.id, successor.identityContextId), eq(runIdentityContexts.companyId, input.companyId),
    eq(runIdentityContexts.runId, input.sourceRunId), eq(runIdentityContexts.responsibleUserId, input.actorId),
    eq(runIdentityContexts.status, "accepted"), eq(runIdentityContexts.cause, "task_retry"),
    eq(runIdentityContexts.parentContextId, intent.boardMessageOrigin.identityContextId),
    sql`${runIdentityContexts.messageId} is null`)).limit(1);
  if (!identity) return null;
  const parent = await readBoardMessageRetrySource(db, { ...input, sourceRunId: intent.sourceRunId }, seen);
  return parent && parent.commentId === intent.boardMessageOrigin.commentId &&
    parent.identityContextId === intent.boardMessageOrigin.identityContextId
    ? { commentId: parent.commentId, identityContextId: identity.id } : null;
}

/** Caller holds the issue dispatch lock. Newer work supersedes an unadmitted
 * Retry; retiring its authority does not acknowledge or discard saved input. */
export async function retireSupersededTaskRetry(db: Db, input: {
  companyId: string; issueId: string; requestId: string; sourceRunId: string;
}) {
  const [latest] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (latest?.id === input.sourceRunId) return false;
  const retired = await db.update(agentWakeupRequests).set({ status: "skipped", error: "task_retry_superseded",
    finishedAt: new Date(), updatedAt: new Date() }).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.requestId),
    eq(agentWakeupRequests.reason, "task_retry"), sql`${agentWakeupRequests.runId} is null`,
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued", "claimed"]),
  )).returning({ id: agentWakeupRequests.id });
  return retired.length > 0;
}

/** Persist a deliberate click under dispatch's issue-first lock order. This
 * transaction never contacts a provider. The normal wake queue owns execution. */
export async function requestTaskRetry(input: {
  db: Db; companyId: string; issueId: string; actorId: string;
  idempotencyKey: string; observedRunId: string | null; actorSource?: string;
  prepareChatRetry?: (tx: Db, scope: { companyId: string; issueId: string; agentId: string;
    failedRunId: string; initiatedByUserId: string; retryIntentId?: string }) => Promise<{ actionId: string }>;
}) {
  return writeExecutionControl(input.db, DELIVERY_QUEUES.workspaceRecovery, async tx => {
    const db = tx as unknown as Db;
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId),
      eq(issues.id, input.issueId))).for("update");
    if (!issue) throw notFound("Task not found");
    await assertTaskRetryConversationAllowed(db, issue, input.actorId);
    const key = `task-retry:${input.idempotencyKey}`;
    const [sameRequest] = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
    if (sameRequest) {
      if (sameRequest.payload?.issueId !== issue.id || sameRequest.requestedByActorId !== input.actorId)
        throw conflict("This retry request belongs to a different task or user.");
      const intent = readTaskRetryIntent(sameRequest.payload);
      return { requestId: intent?.canonicalIntentId ?? sameRequest.id, accepted: true, stale: false,
        observedRunId: intent?.sourceRunId ?? null, chatActionId: intent?.chatActionId };
    }
    const [latest] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, issue.companyId),
      or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`)))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    if (["done", "cancelled"].includes(issue.status) || !issue.assigneeAgentId || !latest ||
        latest.agentId !== issue.assigneeAgentId || input.observedRunId !== latest.id) {
      return { requestId: null, accepted: false, stale: true, observedRunId: latest?.id ?? null };
    }
    let active = (await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
      sql`${agentWakeupRequests.payload}->'taskRetry'->>'schema' = 'paperclip.task-retry.v1'`,
      inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued", "claimed"]),
    )).orderBy(desc(agentWakeupRequests.requestedAt)).limit(1)).at(0);
    const activeIntent = readTaskRetryIntent(active?.payload);
    if (active && !active.runId && activeIntent && await retireSupersededTaskRetry(db, {
      companyId: issue.companyId, issueId: issue.id, requestId: active.id, sourceRunId: activeIntent.sourceRunId,
    })) active = undefined;
    if (active && !active.runId && issue.conversationAgentId && active.requestedByActorId !== issue.conversationUserId) {
      // A former owner's unadmitted receipt cannot own the new owner's Retry.
      await tx.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentWakeupRequests.id, active.id));
      active = undefined;
    }
    const busy = ["queued", "running", "scheduled_retry"].includes(latest.status);
    if (!busy) {
      // Historical deadline failures can predate their preservation record.
      // Register the exact prepared source; this proves neither a stopped
      // executor nor permission to replay its work.
      try { await preserveNativeFailedWorkspace(db, latest); }
      catch (error) { if (!(error instanceof NativeWorkspaceFinalizationBusyError)) throw error; }
    }
    const records = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, issue.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${latest.id}`)).for("update");
    for (let index = 0; !busy && index < records.length; index++) {
      const action = records[index];
      if (!hasRequiredWorkspaceRecovery(action.evidence) || readSystemRecovery(action.evidence)) continue;
      await adoptSystemRecovery(db, { companyId: issue.companyId, issueId: issue.id, runId: latest.id, actionId: action.id });
      [records[index]] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    }
    // An unadmitted request can outlive its exhausted repair. A new deliberate
    // click replaces that generation; a replay of the same key returned above.
    if (active && !busy && !active.runId && records.some(action =>
      readSystemRecovery(action.evidence)?.state === "exhausted")) {
      await tx.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(agentWakeupRequests.id, active.id));
      active = undefined;
    }
    const id = randomUUID();
    const intent: TaskRetryIntent = { schema: "paperclip.task-retry.v1", generationId: active?.id ?? id,
      sourceRunId: latest.id, actorId: input.actorId,
      actorSource: taskRetryIntentSchema.shape.actorSource.parse(input.actorSource ?? "session"), strategy: "evaluate",
      ...(active && activeIntent?.chatActionId ? { chatActionId: activeIntent.chatActionId } : {}),
      ...(active ? { canonicalIntentId: active.id } : {}) };
    // Preserve external chat authority through its existing admission owner.
    // Generic board Retry must never manufacture a chat-inbound request.
    const [chat] = await tx.select({ id: chatConversations.id }).from(chatConversations)
      .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatConversations.endpointId)).where(and(
        eq(chatConversations.companyId, issue.companyId), eq(chatConversations.issueId, issue.id),
        eq(chatEndpoints.externalExecutionPolicy, "restricted"))).limit(1);
    const boardMessageOrigin = chat && !active && !busy
      ? await readTaskRetryBoardMessageOrigin(db, { companyId: issue.companyId,
        issueId: issue.id, agentId: issue.assigneeAgentId, sourceRunId: latest.id, actorId: input.actorId }) : null;
    if (boardMessageOrigin) intent.boardMessageOrigin = boardMessageOrigin;
    if (chat && !active && !busy && !boardMessageOrigin && (latest.contextSnapshot?.source === "issue.comment.reopen" || latest.contextSnapshot?.boardMessageRetry === true) &&
        latest.responsibleUserId === input.actorId) {
      throw conflict("This saved message cannot be retried safely. Send a new message on the task to continue from saved work.",
        { code: "chat_failed_run_retry_not_authorized", reason: "saved_board_message_not_replayable" });
    }
    await tx.insert(agentWakeupRequests).values({ id, companyId: issue.companyId, agentId: issue.assigneeAgentId,
      source: "on_demand", triggerDetail: "manual", reason: "task_retry", idempotencyKey: key,
      requestedByActorType: "user", requestedByActorId: input.actorId,
      status: active || busy ? "coalesced" : "deferred_issue_execution",
      runId: active?.runId ?? (busy ? latest.id : null),
      payload: { issueId: issue.id, taskRetry: intent }, finishedAt: active || busy ? new Date() : null });
    if (chat && !boardMessageOrigin && !active && !busy) {
      if (!input.prepareChatRetry) throw conflict("Retry is unavailable for this connected conversation.");
      intent.chatActionId = (await input.prepareChatRetry(db, { companyId: issue.companyId, issueId: issue.id,
        agentId: issue.assigneeAgentId, failedRunId: latest.id, initiatedByUserId: input.actorId, retryIntentId: id })).actionId;
      await tx.update(agentWakeupRequests).set({ payload: { issueId: issue.id, taskRetry: intent } })
        .where(eq(agentWakeupRequests.id, id));
    }
    if (!busy) {
      for (const action of records) {
        const previous = readSystemRecovery(action.evidence);
        if (!previous || previous.state === "complete") continue;
        if (previous.state === "running") {
          await updateSystemRecovery(db, { companyId: issue.companyId, issueId: issue.id, runId: latest.id,
            actionId: action.id }, previous, { ...previous, intentId: active?.id ?? id });
          continue;
        }
        // Active repair keeps its attempt and cooldown. An exhausted generation
        // gets a new budget only because this click is a new durable intent.
        const next = previous.state === "exhausted"
          ? { ...createSystemRecovery(latest.id, id), revision: previous.revision + 1,
            preservationOperationIds: previous.preservationOperationIds,
            providerCooldownAt: previous.providerCooldownAt, nextAttemptAt: previous.providerCooldownAt }
          : { ...previous, revision: previous.revision + 1, intentId: active?.id ?? id,
            // Retry may advance our backoff, never a provider's cooldown and
            // never an operation whose physical owner is still running.
            nextAttemptAt: Math.max(Date.now(), previous.providerCooldownAt ?? 0) };
        if (next.generationId !== previous.generationId) await persistActivity(db, {
          companyId: issue.companyId, actorType: "system", actorId: "task-retry", entityType: "issue", entityId: issue.id,
          action: "issue.recovery_generation_replaced", runId: latest.id,
          details: { recoveryActionId: action.id, previousGeneration: previous, nextGenerationId: next.generationId },
        });
        await updateSystemRecovery(db, { companyId: issue.companyId, issueId: issue.id, runId: latest.id,
          actionId: action.id }, previous, next);
      }
    }
    await persistActivity(db, { companyId: issue.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.retry_requested", entityType: "issue", entityId: issue.id, runId: latest.id,
      details: { requestId: active?.id ?? id, sourceRunId: latest.id, attachedToExistingWork: Boolean(active || busy) } });
    return { requestId: active?.id ?? id, accepted: true, stale: false, observedRunId: latest.id,
      chatActionId: intent.chatActionId };
  });
}

/** Chat owns admission and authorization. The task receipt follows that
 * durable outcome; it never launches a parallel generic board execution. */
export async function reconcileTaskChatRetryReceipts(db: Db) {
  const pending = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}#>>'{taskRetry,chatActionId}' is not null`,
  )).orderBy(agentWakeupRequests.updatedAt).limit(50);
  for (const wake of pending) {
    const intent = readTaskRetryIntent(wake.payload);
    if (!intent?.chatActionId) continue;
    const [chat] = await db.select().from(chatActions).where(and(eq(chatActions.companyId, wake.companyId),
      eq(chatActions.id, intent.chatActionId), eq(chatActions.kind, "failed_run_retry"),
      sql`${chatActions.payload}->>'issueId' = ${String(wake.payload?.issueId)}`));
    const [receipt] = chat ? await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, wake.companyId), eq(agentWakeupRequests.id, chat.id),
      eq(agentWakeupRequests.agentId, wake.agentId))) : [];
    // A deferred chat receipt is admitted input, not a completed dispatch.
    // Re-stage that exact action through chat's owner; it rechecks authority
    // and normal queue policy before updating the existing receipt.
    if (chat?.status === "processed" && chat.payload.taskRetryIntentId === wake.id &&
        chat.payload.failedRunId === intent.sourceRunId && receipt?.status === "deferred_issue_execution" &&
        !receipt.runId && receipt.payload?.taskRetryRequestId === wake.id) {
      await db.transaction(async tx => {
        await notifyChatActionWork(tx, "failed_run_retry");
        await tx.update(chatActions).set({ status: "issued", updatedAt: new Date() })
          .where(and(eq(chatActions.id, chat.id), eq(chatActions.companyId, wake.companyId),
            eq(chatActions.status, "processed"), eq(chatActions.updatedAt, chat.updatedAt)));
      });
    }
    const failed = chat && ["failed", "cancelled"].includes(chat.status);
    await db.update(agentWakeupRequests).set({
      ...(receipt?.runId ? { status: "coalesced", runId: receipt.runId, finishedAt: new Date() }
        : failed ? { status: "failed", finishedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "deferred_issue_execution")));
  }
}
