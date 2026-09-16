import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  heartbeatRuns,
  issueComments,
  statusDecisions,
  statusDecisionEffects,
  type Db,
} from "@paperclipai/db";

export const CHAT_CONTROL_RECOVERY_STOP_CODE = "chat_control_completed_source";
export const CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE =
  "chat_control_recovery_proof_unresolved";
export const CHAT_CONTROL_RECOVERY_ADMISSION_KEY =
  "chatControlRecoveryAdmission";
type AdmissionRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  | "id"
  | "companyId"
  | "agentId"
  | "wakeupRequestId"
  | "nativeIssueId"
  | "contextSnapshot"
  | "runnerProfileJson"
>;
export function chatControlRecoveryAdmission(
  run: AdmissionRun,
  phase: "required" | "admitted",
) {
  return {
    version: 1,
    phase,
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    issueId:
      record(run.contextSnapshot).issueId ?? record(run.contextSnapshot).taskId,
    wakeupRequestId: run.wakeupRequestId,
  };
}
export function readChatControlRecoveryAdmission(
  run: AdmissionRun,
): "historical" | "required" | "admitted" | "invalid" {
  const profile = record(run.runnerProfileJson);
  if (!Object.hasOwn(profile, CHAT_CONTROL_RECOVERY_ADMISSION_KEY))
    return "historical";
  const value = record(profile[CHAT_CONTROL_RECOVERY_ADMISSION_KEY]);
  if (value.phase !== "required" && value.phase !== "admitted")
    return "invalid";
  const expected = chatControlRecoveryAdmission(run, value.phase);
  if (
    !id(expected.issueId) ||
    !id(expected.wakeupRequestId) ||
    (run.nativeIssueId !== null && run.nativeIssueId !== expected.issueId) ||
    Object.keys(value).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, entry]) => value[key] !== entry)
  )
    return "invalid";
  return value.phase;
}
const MAX_ANCESTRY = 64;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function id(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}

export type ChatControlRecoveryScope = {
  companyId: string;
  issueId: string;
  agentId: string;
  sourceRunId: string;
};
export type ChatControlRecoveryStop =
  | { kind: "clear" }
  | { kind: "unresolved" }
  | {
      kind: "stopped";
      conversationId: string;
      publicationId: string;
      sourceRunId: string;
    };

/** A dispatched native continuation inherits only its committed decision's
 * source run. Arbitrary payload.nativeDecisionId / context.source is not proof. */
export async function readChatControlNativeParent(
  db: Db,
  scope: Omit<ChatControlRecoveryScope, "sourceRunId">,
  actorId: string | null,
): Promise<
  { kind: "clear" | "unresolved" } | { kind: "parent"; runId: string }
> {
  const prefix = "native-status-wake-dispatch:";
  if (!actorId?.startsWith(prefix)) return { kind: "clear" };
  const intentId = actorId.slice(prefix.length);
  if (!id(intentId)) return { kind: "unresolved" };
  const [intent] = await db
    .select()
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.id, intentId),
        eq(agentWakeupRequests.companyId, scope.companyId),
        eq(agentWakeupRequests.agentId, scope.agentId),
      ),
    )
    .limit(1);
  if (
    !intent ||
    intent.source !== "automation" ||
    intent.requestedByActorType !== "system" ||
    intent.requestedByActorId !== "native-status-committer"
  )
    return { kind: "unresolved" };
  if (!["issue_status_changed", "monitor_due"].includes(intent.reason ?? ""))
    return { kind: "clear" };
  const payload = record(intent.payload);
  if (payload.issueId !== scope.issueId || !id(payload.nativeDecisionId))
    return { kind: "unresolved" };
  const [proof] = await db
    .select({ runId: statusDecisions.runId, agentId: heartbeatRuns.agentId })
    .from(statusDecisions)
    .innerJoin(
      statusDecisionEffects,
      and(
        eq(statusDecisionEffects.companyId, scope.companyId),
        eq(statusDecisionEffects.issueId, scope.issueId),
        eq(statusDecisionEffects.decisionId, statusDecisions.id),
        eq(statusDecisionEffects.effectKind, "enqueue_continuation"),
        eq(statusDecisionEffects.targetType, "agent_wakeup_request"),
        eq(statusDecisionEffects.targetId, intent.id),
        eq(statusDecisionEffects.deliveryState, "delivered"),
      ),
    )
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.companyId, scope.companyId),
        eq(heartbeatRuns.id, statusDecisions.runId),
      ),
    )
    .where(
      and(
        eq(statusDecisions.companyId, scope.companyId),
        eq(statusDecisions.issueId, scope.issueId),
        eq(statusDecisions.id, payload.nativeDecisionId),
        eq(statusDecisions.applicationState, "applied"),
        sql`${statusDecisions.appliedAt} is not null`,
      ),
    )
    .limit(1);
  if (!proof) return { kind: "unresolved" };
  // A separately assigned participant is not a same-agent replay of old work.
  return proof.agentId === scope.agentId
    ? { kind: "parent", runId: proof.runId }
    : { kind: "clear" };
}

/** Historical stop evidence, never a grant to execute. A later explicit Board
 * cause breaks the ancestry; a chat-looking context string proves nothing.
 * lockConversation is used inside the caller's claim transaction. Close receipt
 * commit locks this same row, so close-before-claim is ordered without holding
 * a lock over any provider I/O. A close after launch is not cancellation. */
export async function readChatControlRecoveryStop(
  db: Db,
  scope: ChatControlRecoveryScope,
  lockConversation = false,
): Promise<ChatControlRecoveryStop> {
  if (!Object.values(scope).every(id)) return { kind: "unresolved" };
  let runId = scope.sourceRunId;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_ANCESTRY; depth++) {
    if (seen.has(runId)) return { kind: "unresolved" };
    seen.add(runId);
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, runId),
          eq(heartbeatRuns.companyId, scope.companyId),
        ),
      )
      .limit(1);
    if (
      !run ||
      (run.nativeIssueId !== null && run.nativeIssueId !== scope.issueId) ||
      (record(run.contextSnapshot).issueId ??
        record(run.contextSnapshot).taskId) !== scope.issueId
    )
      return { kind: "unresolved" };
    if (run.agentId !== scope.agentId)
      return { kind: depth > 0 ? "clear" : "unresolved" };
    const [wake] = run.wakeupRequestId
      ? await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.id, run.wakeupRequestId),
              eq(agentWakeupRequests.companyId, scope.companyId),
              eq(agentWakeupRequests.agentId, scope.agentId),
            ),
          )
          .limit(1)
      : [];
    const [freshBoardCause] = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, scope.companyId),
          eq(agentWakeupRequests.agentId, scope.agentId),
          eq(agentWakeupRequests.runId, run.id),
          eq(agentWakeupRequests.status, "coalesced"),
          eq(agentWakeupRequests.requestedByActorType, "user"),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}`,
          sql`not exists (select 1 from chat_actions chat_cause where chat_cause.company_id = ${scope.companyId}::uuid and chat_cause.id = ${agentWakeupRequests.id})`,
        ),
      )
      .limit(1);
    if (freshBoardCause) return { kind: "clear" };
    const [action] = run.wakeupRequestId
      ? await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.id, run.wakeupRequestId),
              eq(chatActions.companyId, scope.companyId),
              inArray(chatActions.kind, ["inbound_wakeup", "failed_run_retry"]),
            ),
          )
          .limit(1)
      : [];
    if (!action) {
      if (
        wake?.source === "automation" &&
        wake.requestedByActorType === "system"
      ) {
        const nativeParent = await readChatControlNativeParent(
          db,
          scope,
          wake.requestedByActorId,
        );
        if (nativeParent.kind === "unresolved") return nativeParent;
        if (nativeParent.kind === "parent") {
          if (run.retryOfRunId && run.retryOfRunId !== nativeParent.runId)
            return { kind: "unresolved" };
          runId = nativeParent.runId;
          continue;
        }
      }
      // Only these durable system continuation receipts can extend old source
      // authority. User/Board wakes, even with retry-looking JSON, are new work.
      const automatic =
        wake?.source === "automation" &&
        wake.requestedByActorType === "system" &&
        wake.requestedByActorId === null &&
        (id(run.retryOfRunId) ||
          ["issue_continuation_needed", "issue_status_changed"].includes(
            wake.reason ?? "",
          ));
      if (!automatic) return { kind: "clear" };
      if (!id(run.retryOfRunId)) return { kind: "unresolved" };
      runId = run.retryOfRunId;
      continue;
    }
    const payload = record(action.payload);
    if (
      !wake ||
      wake.runId !== run.id ||
      !["processed", "failed"].includes(action.status) ||
      payload.version !== 1 ||
      payload.issueId !== scope.issueId ||
      payload.agentId !== scope.agentId ||
      !id(action.conversationId) ||
      !id(action.principalId) ||
      !Number.isSafeInteger(payload.sessionGeneration) ||
      (payload.sessionGeneration as number) < 1
    )
      return { kind: "unresolved" };
    const conversationQuery = db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, scope.companyId),
          eq(chatConversations.id, action.conversationId),
          eq(chatConversations.endpointId, action.endpointId),
          eq(chatConversations.issueId, scope.issueId),
        ),
      );
    const [conversation] = lockConversation
      ? await conversationQuery.for("update", { noWait: true }).limit(1)
      : await conversationQuery.limit(1);
    if (
      !conversation ||
      conversation.sessionGeneration !== payload.sessionGeneration
    )
      return { kind: "unresolved" };
    const [endpoint] = await db
      .select({ provider: chatEndpoints.provider })
      .from(chatEndpoints)
      .where(
        and(
          eq(chatEndpoints.companyId, scope.companyId),
          eq(chatEndpoints.id, action.endpointId),
        ),
      )
      .limit(1);
    if (!endpoint) return { kind: "unresolved" };
    if (action.kind === "failed_run_retry") {
      if (
        !id(payload.failedRunId) ||
        payload.failedRunId !== run.retryOfRunId ||
        action.providerActionId !== `failed-run-retry:${payload.failedRunId}` ||
        !id(payload.sourceWakeupRequestId) ||
        payload.endpointId !== action.endpointId ||
        payload.conversationId !== conversation.id ||
        payload.principalId !== action.principalId
      )
        return { kind: "unresolved" };
      const [parent] = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, payload.failedRunId),
            eq(heartbeatRuns.companyId, scope.companyId),
            eq(heartbeatRuns.agentId, scope.agentId),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${scope.issueId}`,
          ),
        )
        .limit(1);
      if (!parent) return { kind: "unresolved" };
    }
    const sourceActions =
      action.kind === "inbound_wakeup"
        ? await db
            .select({ source: chatActions })
            .from(chatActions)
            .innerJoin(
              agentWakeupRequests,
              and(
                eq(agentWakeupRequests.id, chatActions.id),
                eq(agentWakeupRequests.companyId, scope.companyId),
                eq(agentWakeupRequests.agentId, scope.agentId),
              ),
            )
            .where(
              and(
                eq(chatActions.companyId, scope.companyId),
                eq(chatActions.kind, "inbound_wakeup"),
                or(
                  eq(agentWakeupRequests.runId, run.id),
                  eq(agentWakeupRequests.id, action.id),
                  sql`${agentWakeupRequests.payload}->>'coalescedIntoWakeupRequestId' = ${action.id}`,
                ),
              ),
            )
            .limit(51)
            .then((rows) => rows.map(({ source }) => source))
        : await (async () => {
            if (
              !Array.isArray(payload.sources) ||
              payload.sources.length === 0 ||
              payload.sources.length > 50
            )
              return [];
            const ids = payload.sources.map(
              (source) => record(source).actionId,
            );
            if (!ids.every(id) || new Set(ids).size !== ids.length) return [];
            return db
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.companyId, scope.companyId),
                  inArray(chatActions.id, ids),
                ),
              );
          })();
    if (
      sourceActions.length === 0 ||
      sourceActions.length > 50 ||
      (action.kind === "failed_run_retry" &&
        sourceActions.length !== (payload.sources as unknown[]).length)
    )
      return { kind: "unresolved" };
    for (const source of sourceActions) {
      const sourcePayload = record(source.payload);
      if (
        source.kind !== "inbound_wakeup" ||
        !["processed", "failed"].includes(source.status) ||
        source.providerActionId !== `inbound_wakeup:${source.deliveryId}` ||
        source.endpointId !== action.endpointId ||
        source.conversationId !== conversation.id ||
        sourcePayload.version !== 1 ||
        sourcePayload.issueId !== scope.issueId ||
        sourcePayload.agentId !== scope.agentId ||
        sourcePayload.sessionGeneration !== conversation.sessionGeneration ||
        !id(sourcePayload.commentId) ||
        !id(source.deliveryId) ||
        !id(source.principalId)
      )
        return { kind: "unresolved" };
      if (action.kind === "failed_run_retry") {
        const retained = (payload.sources as unknown[])
          .map(record)
          .find((candidate) => candidate.actionId === source.id);
        if (
          !retained ||
          retained.deliveryId !== source.deliveryId ||
          retained.principalId !== source.principalId ||
          retained.commentId !== sourcePayload.commentId ||
          retained.receiptId !== source.id ||
          retained.ownerId !== payload.sourceWakeupRequestId
        )
          return { kind: "unresolved" };
      }
      const [sourceWake] = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.id, source.id),
            eq(agentWakeupRequests.companyId, scope.companyId),
            eq(agentWakeupRequests.agentId, scope.agentId),
          ),
        )
        .limit(1);
      if (
        !sourceWake ||
        sourceWake.requestedByActorType !==
          sourcePayload.requestedByActorType ||
        sourceWake.requestedByActorId !== sourcePayload.requestedByActorId
      )
        return { kind: "unresolved" };
      if (
        action.kind === "failed_run_retry" &&
        sourceWake.id !== payload.sourceWakeupRequestId &&
        (sourceWake.status !== "coalesced" ||
          record(sourceWake.payload).coalescedIntoWakeupRequestId !==
            payload.sourceWakeupRequestId)
      )
        return { kind: "unresolved" };
      const [binding] = await db
        .select({ id: chatMessageLinks.id })
        .from(chatMessageLinks)
        .innerJoin(
          chatDeliveries,
          and(
            eq(chatDeliveries.id, chatMessageLinks.deliveryId),
            eq(chatDeliveries.companyId, scope.companyId),
            eq(chatDeliveries.endpointId, action.endpointId),
            eq(chatDeliveries.conversationId, conversation.id),
            eq(chatDeliveries.principalId, source.principalId),
            eq(chatDeliveries.state, "processed"),
          ),
        )
        .innerJoin(
          issueComments,
          and(
            eq(issueComments.id, chatMessageLinks.commentId),
            eq(issueComments.companyId, scope.companyId),
            eq(issueComments.issueId, scope.issueId),
          ),
        )
        .where(
          and(
            eq(chatMessageLinks.companyId, scope.companyId),
            eq(chatMessageLinks.endpointId, action.endpointId),
            eq(chatMessageLinks.conversationId, conversation.id),
            eq(chatMessageLinks.direction, "inbound"),
            eq(chatMessageLinks.commentId, sourcePayload.commentId),
            eq(chatMessageLinks.deliveryId, source.deliveryId),
          ),
        )
        .limit(1);
      if (!binding) return { kind: "unresolved" };
    }
    // SQL timestamps retain PostgreSQL precision. In particular, a newly
    // admitted source after a prior close is not stopped by that old receipt.
    const publications = await db
      .select({ publication: chatPublications, authorization: chatActions })
      .from(chatPublications)
      .innerJoin(
        chatActions,
        and(
          eq(chatActions.companyId, scope.companyId),
          eq(chatActions.endpointId, action.endpointId),
          eq(chatActions.conversationId, conversation.id),
          eq(chatActions.kind, "task_control_authorization"),
          eq(chatActions.status, "processed"),
          sql`${chatActions.providerActionId} = 'task-control-authorization:' || ${chatPublications.id}::text`,
          sql`${chatActions.payload}->>'publicationId' = ${chatPublications.id}::text`,
          sql`${chatActions.result}->>'code' = 'task_control_authorized_and_sent'`,
        ),
      )
      .innerJoin(
        chatMessageLinks,
        and(
          eq(chatMessageLinks.companyId, scope.companyId),
          eq(chatMessageLinks.endpointId, action.endpointId),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.publicationId, chatPublications.id),
          eq(
            chatMessageLinks.providerMessageId,
            chatPublications.providerMessageId,
          ),
          eq(chatMessageLinks.direction, "outbound"),
          sql`${chatMessageLinks.commentId} is null`,
        ),
      )
      .where(
        and(
          eq(chatPublications.companyId, scope.companyId),
          eq(chatPublications.endpointId, action.endpointId),
          eq(chatPublications.conversationId, conversation.id),
          eq(chatPublications.issueId, scope.issueId),
          eq(chatPublications.state, "published"),
          sql`${chatPublications.idempotencyKey} ~ '^control:(close|new):'`,
          sql`length(${chatPublications.providerMessageId}) > 0`,
          sql`${chatPublications.publishedAt} is not null`,
          sql`not exists (select 1 from chat_actions admitted_source where admitted_source.company_id = ${scope.companyId}::uuid and ${inArray(
            sql`admitted_source.id`,
            sourceActions.map((source) => source.id),
          )} and admitted_source.created_at > ${chatPublications.createdAt})`,
        ),
      )
      .limit(51);
    for (const { publication, authorization } of publications) {
      if (!id(authorization.principalId)) continue;
      const match = /^control:(close|new):(.+)$/.exec(
        publication.idempotencyKey,
      );
      if (!match) continue;
      let controlProven = false;
      if (uuid.test(match[2]!)) {
        const [control] = await db
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.id, match[2]),
              eq(chatDeliveries.companyId, scope.companyId),
              eq(chatDeliveries.endpointId, action.endpointId),
              eq(chatDeliveries.conversationId, conversation.id),
              eq(chatDeliveries.principalId, authorization.principalId),
              eq(chatDeliveries.state, "processed"),
            ),
          )
          .limit(1);
        // The normalized text is not authority on its own: it is accepted only
        // alongside this exact processed delivery, authorized publication and
        // confirmed outbound receipt. These historical rows have no newer
        // invented authorization-payload version or generation fields.
        const normalized = record(control?.normalizedEvent);
        const message = record(normalized.message);
        const thread = record(normalized.conversation);
        const command =
          typeof message.text === "string"
            ? /^\/(new|close)(?:@[\w.-]+)?\s*$/i
                .exec(message.text.trim())?.[1]
                ?.toLowerCase()
            : null;
        controlProven = Boolean(
          control &&
          ["message", "direct_message", "mention"].includes(
            control.eventKind,
          ) &&
          normalized.providerEventId === control.providerEventId &&
          normalized.kind === control.eventKind &&
          command === match[1] &&
          typeof message.providerMessageId === "string" &&
          message.providerMessageId.length > 0 &&
          thread.externalConversationId ===
            conversation.externalConversationId &&
          thread.externalThreadId === conversation.externalThreadId,
        );
      } else if (
        endpoint.provider === "discord" &&
        match[2]!.startsWith(`discord:${action.endpointId}:`)
      ) {
        const controls = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.companyId, scope.companyId),
              eq(chatActions.endpointId, action.endpointId),
              eq(chatActions.conversationId, conversation.id),
              eq(chatActions.kind, "discord_native_command"),
              eq(chatActions.status, "processed"),
              eq(chatActions.principalId, authorization.principalId),
              sql`${chatActions.result}->>'publicationId' = ${publication.id}::text`,
            ),
          )
          .limit(2);
        const control = controls.length === 1 ? controls[0] : null;
        const invocation = record(record(control?.payload).invocation);
        const target = record(record(control?.payload).target);
        controlProven = Boolean(
          control &&
          control.providerActionId ===
            `discord-native-command:${invocation.interactionId}` &&
          record(control.result).kind === "discord_native_command_recorded" &&
          record(control.payload).version === 1 &&
          invocation.command === match[1] &&
          `discord:${action.endpointId}:${invocation.interactionId}` ===
            match[2] &&
          target.conversationId === conversation.id &&
          target.issueId === scope.issueId &&
          target.sessionGeneration === conversation.sessionGeneration,
        );
      }
      if (controlProven)
        return {
          kind: "stopped",
          conversationId: conversation.id,
          publicationId: publication.id,
          sourceRunId: run.id,
        };
    }
    return { kind: publications.length > 50 ? "unresolved" : "clear" };
  }
  return { kind: "unresolved" };
}
