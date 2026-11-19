import { agentWakeupRequests, agents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import type { IssueQueuedCommentQueue } from "@paperclipai/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { conflict, notFound } from "../../../errors.js";
import {
  buildQueuedCommentQueueSnapshot,
  decideQueuedCommentQueueSteering,
  queuedCommentIdsFromWakePayload,
} from "../../../services/issue-queued-comment-queue.js";
import {
  firstTurnClaimedCommentIds,
  firstTurnQueuedCommentIds,
  firstTurnWakeColumns,
  firstTurnWakeContextFields,
  firstTurnWakePayloadFields,
} from "../../../services/native-runtime/first-turn-queued-input.js";
import { getNativeSessionSteeringState } from "../../../services/native-runtime/native-session-executor.js";
import { queuedInteractionId, readQueuedInteractionResponse, type QueuedInteractionResponse } from "../../../services/queued-interaction-response.js";
import type { QueuedCommentActor } from "../application/queued-comment-ports.js";
import { parseObject } from "../domain/values.js";

type IssueQueueDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type IssueQueueTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type IssueQueueWake = typeof agentWakeupRequests.$inferSelect;
type IssueQueueRun = typeof heartbeatRuns.$inferSelect;
type IssueQueueState = {
  wake: Pick<IssueQueueWake, "id" | "companyId" | "payload" | "status" | "runId" | "agentId" | "reason"
    | "requestedByActorType" | "requestedByActorId">;
  state: "deferred" | "queued";
  queueRun: Pick<IssueQueueRun, "runtimeMode"> | null;
  /** The receipt already read for an interaction wake, reused by the queue builder. */
  response?: QueuedInteractionResponse | null;
};

const QUEUED_INTERRUPT_HANDOFF_WAIT = { reason: "interrupt_handoff", message: "Sending your messages." } as const;

async function findQueuedCommentWake(
  executor: IssueQueueDb,
  issue: { id: string; companyId: string; assigneeAgentId: string | null },
): Promise<IssueQueueState | null> {
  if (!issue.assigneeAgentId) return null;
  const rows = await executor
    .select({
      id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId,
      status: agentWakeupRequests.status, runId: agentWakeupRequests.runId,
      ...firstTurnWakeColumns,
      payload: sql<Record<string, unknown>>`jsonb_build_object(
        ${firstTurnWakePayloadFields(agentWakeupRequests.payload)},
        'issueId', ${agentWakeupRequests.payload}->'issueId',
        'mutation', ${agentWakeupRequests.payload}->'mutation',
        'interactionStatus', ${agentWakeupRequests.payload}->'interactionStatus',
        'externalChatContinuation', ${agentWakeupRequests.payload}->'externalChatContinuation',
        'executionWait', jsonb_build_object(
          'reason', ${agentWakeupRequests.payload}->'executionWait'->'reason',
          'message', ${agentWakeupRequests.payload}->'executionWait'->'message'),
        '_paperclipWakeContext', jsonb_build_object(
          ${firstTurnWakeContextFields(agentWakeupRequests.payload)},
          'wakeCommentIds', ${agentWakeupRequests.payload}->'_paperclipWakeContext'->'wakeCommentIds',
          'forceFreshSession', ${agentWakeupRequests.payload}->'_paperclipWakeContext'->'forceFreshSession')
      )`,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, issue.companyId),
        eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
        sql`${agentWakeupRequests.payload}->'issueId' = to_jsonb(${issue.id}::text)`,
        inArray(agentWakeupRequests.status, [
          "deferred_issue_execution",
          "queued",
        ]),
      ),
    )
    .orderBy(asc(agentWakeupRequests.requestedAt));

  // A saved card response (an approval, an answer, a declined connection)
  // is a read-only receipt. It must never hide the user's own later
  // messages, which are separately queued and remain editable and sendable.
  let receipt: IssueQueueState | null = null;
  let agentOnly: IssueQueueState | null = null;
  const hasPersonMessage = async (wake: { payload: unknown }) => {
    const ids = queuedCommentIdsFromWakePayload(wake.payload);
    if (ids.length === 0) return false;
    const [row] = await executor.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
      inArray(issueComments.id, ids), eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt),
    )).limit(1);
    return Boolean(row);
  };
  const pendingMessages = async (state: IssueQueueState) => {
    if (await hasPersonMessage(state.wake)) return state;
    agentOnly = state;
    return null;
  };
  for (const wake of rows) {
    if (
      parseObject(wake.payload).issueId !== issue.id ||
      (queuedCommentIdsFromWakePayload(wake.payload).length === 0 && !queuedInteractionId(wake.payload))
    )
      continue;
    const isReceipt = Boolean(queuedInteractionId(wake.payload));
    if (isReceipt && receipt) continue;
    if (!isReceipt && agentOnly) continue;
    const readReceipt = () => readQueuedInteractionResponse(executor as Db, wake.companyId, issue.id, wake.payload);
    if (wake.status === "deferred_issue_execution") {
      if (isReceipt) {
        const response = await readReceipt();
        if (response && !response.toolActionOutcome) receipt = { wake, state: "deferred", queueRun: null, response };
        continue;
      }
      const messages = await pendingMessages({ wake, state: "deferred", queueRun: null });
      if (messages) return messages;
      continue;
    }
    if (!wake.runId) continue;
    const queueRun = await executor
      .select({ runtimeMode: heartbeatRuns.runtimeMode })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, wake.runId),
          eq(heartbeatRuns.companyId, issue.companyId),
          eq(heartbeatRuns.agentId, issue.assigneeAgentId),
          eq(heartbeatRuns.wakeupRequestId, wake.id),
          eq(heartbeatRuns.status, "queued"),
        ),
      )
      .limit(1)
      .then((runRows) => runRows[0] ?? null);
    if (queueRun && isReceipt) {
      const response = await readReceipt();
      if (response && !response.toolActionOutcome) receipt = { wake, state: "queued", queueRun, response };
    }
    else if (queueRun) {
      const messages = await pendingMessages({ wake, state: "queued", queueRun });
      if (messages) return messages;
    }
  }
  return receipt ?? agentOnly;
}

async function queueCommentsForWake(
  executor: IssueQueueDb,
  issueId: string,
  wake: Pick<IssueQueueWake, "companyId" | "payload"> | null,
  response: QueuedInteractionResponse | null,
) {
  if (wake && queuedInteractionId(wake.payload)) return response ? [response.comment] : [];
  const ids = queuedCommentIdsFromWakePayload(wake?.payload);
  if (ids.length === 0) return [];
  const rows = await executor
    .select()
    .from(issueComments)
    .where(
      and(eq(issueComments.issueId, issueId), inArray(issueComments.id, ids)),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row && !row.deletedAt ? [{ ...row, authorType: row.authorType ?? (row.authorAgentId ? "agent" as const : "user" as const) }] : [];
  });
}

export async function readBoardQueuedComments(input: {
  executor: IssueQueueDb;
  issue: { id: string; companyId: string; assigneeAgentId: string | null; conversationAgentId?: string | null };
  activeRun: Pick<IssueQueueRun, "id" | "status" | "runtimeMode" | "runtimeModeResolvedAt" | "runnerProfileJson" | "contextSnapshot"> | null;
  actor: QueuedCommentActor;
  queueState?: IssueQueueState | null;
  steeringDisposition?: IssueQueuedCommentQueue["steeringDisposition"];
}): Promise<IssueQueuedCommentQueue> {
  const queueState =
    input.queueState === undefined
      ? await findQueuedCommentWake(input.executor, input.issue)
      : input.queueState;
  const wake = queueState?.wake ?? null;
  // Read an interaction receipt once per snapshot.
  const response = wake && queuedInteractionId(wake.payload)
    ? queueState?.response !== undefined
      ? queueState.response
      : await readQueuedInteractionResponse(input.executor as Db, input.issue.companyId, input.issue.id, wake.payload)
    : null;
  // Messages the active run took into its first turn are no longer queued.
  const claimedByFirstTurn = queueState?.state === "deferred" ? firstTurnClaimedCommentIds(input.activeRun) : new Set<string>();
  const comments = (await queueCommentsForWake(
    input.executor,
    input.issue.id,
    wake,
    response,
  )).filter((comment) => !claimedByFirstTurn.has(comment.id));
  const assignedAgent = input.issue.assigneeAgentId
    ? await input.executor
        .select({ adapterType: agents.adapterType })
        .from(agents)
        .where(
          and(
            eq(agents.id, input.issue.assigneeAgentId),
            eq(agents.companyId, input.issue.companyId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  const steering = decideQueuedCommentQueueSteering({
    state: queueState?.state ?? null,
    queueRunRuntimeMode: queueState?.state === "queued" ? queueState.queueRun?.runtimeMode ?? null : null,
    activeRun: input.activeRun,
    assignedAgentAdapterType: assignedAgent?.adapterType ?? null,
    queuedCommentCount: comments.length,
  });
  const steeringDisposition: IssueQueuedCommentQueue["steeringDisposition"] =
    input.issue.conversationAgentId ? "unsupported" : steering.kind !== "probe"
      ? steering.kind
      : input.steeringDisposition
        ?? (await getNativeSessionSteeringState(steering.steeringRunId)
          .then((state) => state.disposition)
          .catch(() => "temporarily_unavailable" as const));
  const wait = queueState?.state === "deferred" ? parseObject(parseObject(wake?.payload).executionWait) : {};
  // The user's Interrupt click is delivering these messages. Its stopped run
  // settling is not something to read about under the composer; the task
  // notice owns any wait that needs the user.
  const interruptHandoff = queueState?.state === "deferred" && parseObject(wake?.payload).queuedCommentInterrupt != null;
  const queue = buildQueuedCommentQueueSnapshot({
    issueId: input.issue.id,
    executionWait: interruptHandoff ? QUEUED_INTERRUPT_HANDOFF_WAIT
      : typeof wait.reason === "string" && typeof wait.message === "string"
        ? { reason: wait.reason, message: wait.message } : null,
    queueId: wake?.id ?? null,
    state: queueState?.state ?? null,
    activeRunId: input.activeRun?.id ?? null,
    protocol: steering.protocol,
    steeringDisposition,
    comments,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
  });
  if (wake && queuedInteractionId(wake.payload)) {
    if (response?.source.requiresFreshSession) queue.steeringDisposition = "unsupported";
    queue.entries = response ? [{ comment: response.comment, source: response.source, position: 0, canEdit: false, canDiscard: false }] : [];
  } else if (wake && queueState?.state === "deferred" && input.activeRun?.status === "running") {
    // A starting run (a booting sandbox, say) cannot be steered yet, but its
    // first turn takes these messages. The view shows them as sent.
    const firstTurnCommentIds = await firstTurnQueuedCommentIds(input.executor, {
      companyId: input.issue.companyId, issueId: input.issue.id, runId: input.activeRun.id, wake,
    });
    if (firstTurnCommentIds.length > 0) queue.firstTurnCommentIds = firstTurnCommentIds;
  }
  return queue;
}

export async function lockBoardQueuedComments(input: {
  tx: IssueQueueTx;
  issue: {
    id: string;
    companyId: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  };
  actor: QueuedCommentActor;
  queueId: string;
  targetRunId?: string;
  allowStoppedTarget?: boolean;
  /** Steering must allow PRP event ingestion to update the run before ACK. */
  lockRun?: boolean;
}) {
  const [currentIssue] = await input.tx
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.id, input.issue.id),
        eq(issues.companyId, input.issue.companyId),
      ),
    )
    .for("update");
  if (!currentIssue) throw notFound("Issue not found");
  input.issue = currentIssue;
  const wake = await input.tx
    .select()
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.id, input.queueId),
        eq(agentWakeupRequests.companyId, input.issue.companyId),
        input.issue.assigneeAgentId
          ? eq(agentWakeupRequests.agentId, input.issue.assigneeAgentId)
          : undefined,
      ),
    )
    .for("update")
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !wake ||
    parseObject(wake.payload).issueId !== input.issue.id ||
    (queuedCommentIdsFromWakePayload(wake.payload).length === 0 && !queuedInteractionId(wake.payload)) ||
    // A tool action's outcome is never a message to steer, interrupt or discard.
    (queuedInteractionId(wake.payload) &&
      (await readQueuedInteractionResponse(input.tx as unknown as Db, input.issue.companyId, input.issue.id, wake.payload))
        ?.toolActionOutcome)
  ) {
    throw conflict("The queued message is no longer pending", {
      code: "queued_comment_not_pending",
    });
  }

  let state: IssueQueueState["state"];
  let queueRun: IssueQueueRun | null = null;
  if (wake.status === "deferred_issue_execution") {
    state = "deferred";
  } else if (wake.status === "queued" && wake.runId) {
    queueRun = await input.tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, wake.runId),
          eq(heartbeatRuns.companyId, input.issue.companyId),
          eq(heartbeatRuns.agentId, wake.agentId),
          eq(heartbeatRuns.wakeupRequestId, wake.id),
        ),
      )
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!queueRun || queueRun.status !== "queued") {
      throw conflict("The queued message is already being dispatched", {
        code: "queued_comment_already_dispatching",
      });
    }
    state = "queued";
  } else if (
    wake.status === "claimed" ||
    wake.status === "running" ||
    (wake.runId && (wake.status === "succeeded" || wake.status === "failed"))
  ) {
    throw conflict("The queued message is already being dispatched", {
      code: "queued_comment_already_dispatching",
    });
  } else {
    throw conflict("The queued message is no longer pending", {
      code: "queued_comment_not_pending",
    });
  }

  const activeRunId =
    state === "deferred"
      ? (input.targetRunId ?? input.issue.executionRunId ?? null)
      : null;
  const activeRunQuery = activeRunId
    ? input.tx
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, activeRunId),
            eq(heartbeatRuns.companyId, input.issue.companyId),
            input.allowStoppedTarget ? undefined : eq(heartbeatRuns.status, "running"),
          ),
        )
        .$dynamic()
    : null;
  const activeRun = activeRunQuery
    ? await (input.lockRun === false ? activeRunQuery : activeRunQuery.for("update"))
        .limit(1).then(rows => rows[0] ?? null)
    : null;
  if (input.targetRunId) {
    const runContext = parseObject(activeRun?.contextSnapshot);
    if (
      !activeRun ||
      (runContext.issueId !== input.issue.id &&
        runContext.taskId !== input.issue.id)
    ) {
      throw conflict("The queued message targets a stale run", {
        code: "queued_comment_stale_target",
      });
    }
  }
  const queueState = { wake, state, queueRun } satisfies IssueQueueState;
  const queue = await readBoardQueuedComments({
    executor: input.tx,
    issue: input.issue,
    activeRun,
    actor: input.actor,
    queueState,
    steeringDisposition:
      activeRun?.runtimeMode === "native"
        ? "temporarily_unavailable"
        : "unsupported",
  });
  return { activeRun, wake, queueRun, state, queue, queueState };
}
