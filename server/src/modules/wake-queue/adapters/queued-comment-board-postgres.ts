import { agentWakeupRequests, agents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import type { IssueQueuedCommentQueue } from "@paperclipai/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { assertQueuedCommentInteractionDelivery, recheckQueuedCommentInteractionDelivery } from "../../../services/agent-interaction-delivery.js";
import { deliverSteeredMessage, steeringDeliveryIsUncertain } from "../../../services/queued-comment-steering.js";
import { acceptSteeredIdentity, rejectSteeredIdentity, reserveSteeredIdentity, type RunIdentityContext } from "../../../services/run-identity.js";
import {
  buildQueuedCommentQueueSnapshot,
  decideQueuedCommentQueueSteering,
  queuedCommentIdsFromWakePayload,
  withQueuedCommentIdsInWakePayload,
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
import type { QueuedCommentActor, QueuedCommentSteeringPort, SteerQueuedCommentInput } from "../application/queued-comment-ports.js";
import { QueuedCommentMutationError } from "../application/queued-comment-use-cases.js";
import { parseObject } from "../domain/values.js";

type IssueQueueDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type IssueQueueTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type IssueQueueWake = typeof agentWakeupRequests.$inferSelect;
type IssueQueueRun = typeof heartbeatRuns.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
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

type BoardQueueTarget = Pick<SteerQueuedCommentInput, "actor" | "issue" | "queueId"> & {
  tx: IssueQueueTx;
  targetRunId?: string;
  allowStoppedTarget?: boolean;
};

export async function lockBoardQueuedComments(input: BoardQueueTarget) {
  const { issue, wake } = await lockBoardQueueRows(input);
  return readLockedBoardQueue({ ...input, issue }, wake);
}

async function lockBoardQueueRows(input: Pick<BoardQueueTarget, "tx" | "issue" | "queueId">) {
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
  if (!currentIssue) throw new QueuedCommentMutationError("queued_comment_issue_not_found", "Issue not found");
  const wake = await input.tx
    .select()
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.id, input.queueId),
        eq(agentWakeupRequests.companyId, input.issue.companyId),
        currentIssue.assigneeAgentId
          ? eq(agentWakeupRequests.agentId, currentIssue.assigneeAgentId)
          : undefined,
      ),
    )
    .for("update")
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return { issue: currentIssue, wake };
}

function runTargetsIssue(run: IssueQueueRun, issueId: string) {
  const context = parseObject(run.contextSnapshot);
  return context.issueId === issueId || context.taskId === issueId;
}

async function readLockedBoardQueue(
  input: BoardQueueTarget & { issue: IssueRow },
  wake: IssueQueueWake | null,
  /** Steer reads the scoped run without locking it; Interrupt still uses its existing run lock. */
  steeringRun?: IssueQueueRun | null,
) {
  if (
    !wake ||
    parseObject(wake.payload).issueId !== input.issue.id ||
    (queuedCommentIdsFromWakePayload(wake.payload).length === 0 && !queuedInteractionId(wake.payload)) ||
    // A tool action's outcome is never a message to steer, interrupt or discard.
    (queuedInteractionId(wake.payload) &&
      (await readQueuedInteractionResponse(input.tx as unknown as Db, input.issue.companyId, input.issue.id, wake.payload))
        ?.toolActionOutcome)
  ) {
    throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
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
      throw new QueuedCommentMutationError("queued_comment_already_dispatching", "The queued message is already being dispatched");
    }
    state = "queued";
  } else if (
    wake.status === "claimed" ||
    wake.status === "running" ||
    (wake.runId && (wake.status === "succeeded" || wake.status === "failed"))
  ) {
    throw new QueuedCommentMutationError("queued_comment_already_dispatching", "The queued message is already being dispatched");
  } else {
    throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
  }

  const activeRunId = state === "deferred" ? (input.targetRunId ?? input.issue.executionRunId) : null;
  const activeRun = steeringRun !== undefined
    ? activeRunId && steeringRun?.status === "running" ? steeringRun : null
    : activeRunId
      ? await input.tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, activeRunId), eq(heartbeatRuns.companyId, input.issue.companyId),
          input.allowStoppedTarget ? undefined : eq(heartbeatRuns.status, "running"),
        )).for("update").limit(1).then(rows => rows[0] ?? null)
      : null;
  if (input.targetRunId && (!activeRun || !runTargetsIssue(activeRun, input.issue.id))) {
    throw new QueuedCommentMutationError("queued_comment_stale_target", "The queued message targets a stale run");
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

export function createQueuedCommentSteeringAdapter(db: Db): QueuedCommentSteeringPort<RunIdentityContext> {
  return {
    async reserveIdentity({ issue, queueId, commentId, targetRunId }) {
      const [wake] = await db.select({ agentId: agentWakeupRequests.agentId, payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.id, queueId), eq(agentWakeupRequests.companyId, issue.companyId),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
        ));
      const response = wake ? await readQueuedInteractionResponse(db, issue.companyId, issue.id, wake.payload) : null;
      if (wake) await recheckQueuedCommentInteractionDelivery(db, {
        companyId: issue.companyId, issueId: issue.id, agentId: wake.agentId, commentId, queueId,
      });
      return reserveSteeredIdentity(db, {
        companyId: issue.companyId, issueId: issue.id, runId: targetRunId, messageId: commentId,
        source: response?.comment.id === commentId ? "interaction" : "comment",
      });
    },
    rejectIdentity: (identity) => rejectSteeredIdentity(db, identity),
    isDeliveryUncertain: steeringDeliveryIsUncertain,

    withLockedTarget(input, apply) {
      return db.transaction(async (tx) => {
        const { issue, wake } = await lockBoardQueueRows({ ...input, tx });
        const { companyId } = issue;
        const { targetRunId, commentId, actor } = input;
        // A spent wake can still identify a durable acknowledgement for a retry.
        const runScope = wake && parseObject(wake.payload).issueId === issue.id ? and(
          eq(heartbeatRuns.id, targetRunId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, wake.agentId),
        ) : undefined;
        const [candidate] = runScope ? await tx.select().from(heartbeatRuns).where(runScope) : [];
        const run = candidate && runTargetsIssue(candidate, issue.id) ? candidate : null;
        const previousAcknowledgements = parseObject(parseObject(run?.resultJson).queuedSteeringAcknowledgements);
        return apply({
          previousAcknowledgement: parseObject(previousAcknowledgements[commentId]),
          readReplayQueue: () => readBoardQueuedComments({
            executor: tx, issue, actor, activeRun: run?.status === "running" ? run : null,
          }),
          async readPendingQueue() {
            const { queue } = await readLockedBoardQueue({ ...input, tx, issue }, wake, run);
            return queue;
          },
          assertDeliveryAllowed: () => assertQueuedCommentInteractionDelivery(tx, {
            companyId, issueId: issue.id, agentId: run!.agentId, commentId, lock: true,
          }),
          deliver: (message, identity) => deliverSteeredMessage(db, {
            executor: tx, companyId, runId: targetRunId, messageId: commentId, message, identity,
          }),
          async acceptAcknowledgement({ identity, turnId, remainingIds }) {
            if (!runScope || !wake) return null;
            // PRP event ingestion needs this row to persist its ACK. Re-read and
            // lock it now so concurrent receipts survive the result merge.
            const [acknowledgedRun] = await tx.select().from(heartbeatRuns).where(and(
              runScope, eq(heartbeatRuns.status, "running"),
            )).for("update");
            if (!acknowledgedRun || !runTargetsIssue(acknowledgedRun, issue.id)) return null;
            const result = parseObject(acknowledgedRun.resultJson);
            if (identity) await acceptSteeredIdentity(tx, identity);

            const now = new Date();
            const wakeScope = and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.companyId, companyId));
            let nextWake: IssueQueueWake | null = null;
            if (remainingIds.length === 0) {
              await tx.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: now, updatedAt: now }).where(wakeScope);
            } else {
              const [updated] = await tx.update(agentWakeupRequests).set({
                payload: withQueuedCommentIdsInWakePayload(wake.payload, remainingIds), updatedAt: now,
              }).where(wakeScope).returning();
              nextWake = updated ?? wake;
            }
            await tx.update(heartbeatRuns).set({
              resultJson: {
                ...result,
                queuedSteeringAcknowledgements: {
                  ...parseObject(result.queuedSteeringAcknowledgements),
                  [commentId]: { status: "acknowledged", queueId: wake.id, turnId, acknowledgedAt: now.toISOString() },
                },
              },
              updatedAt: now,
            }).where(runScope);
            return readBoardQueuedComments({
              executor: tx, issue, actor, activeRun: acknowledgedRun,
              queueState: nextWake ? { wake: nextWake, state: "deferred", queueRun: null } : null,
            });
          },
        });
      });
    },
  };
}
