import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lte, or, sql } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, caseHandoffs, heartbeatRunEvents, heartbeatRuns, issueComments, issueThreadInteractions, issues, statusDecisions, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { agentInteractionDenial, type AgentInteractionDenial, type AgentInteractionInput } from "./agent-interaction-policy.js";
import { withQueuedCommentIdsInRunContext, withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";
import { notifyDeferredExecutionWork } from "./deferred-execution-notifications.js";
import { currentPluginInteractionOrigin, withPluginInteractionOrigin } from "./plugin-interaction-context.js";

export const INTERACTION_DELIVERY_DENIED = "agent_interaction_delivery_denied";
const DENIALS_KEY = "interactionPermissionDenials";
const ORIGIN_KEY = "interactionOrigin";
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Wake = typeof agentWakeupRequests.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
type DeliveryDenial = AgentInteractionDenial | {
  code: "agent_interaction_provenance_unavailable";
  operation: "assign" | "comment";
  targetAgentId: string;
  issueId: string | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" && value.length ? value : null;
const ids = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((entry): entry is string => typeof entry === "string") : [];

export function agentInteractionDeliveryDenial(db: Executor, input: AgentInteractionInput) {
  return withPluginInteractionOrigin(undefined, () => agentInteractionDenial(db, input));
}

export function agentWakeInteractionTexts(value: unknown): string[] {
  const payload = record(value);
  return [payload.continuationSummary, payload.retrySummary, payload.unblockAction,
    ...(Array.isArray(payload.childIssueSummaries) ? payload.childIssueSummaries.map(entry => record(entry).summary) : []),
  ].filter((entry): entry is string => typeof entry === "string");
}

export function isInteractionDeliveryDeniedRun(run: { errorCode?: string | null } | null | undefined) {
  return run?.errorCode === INTERACTION_DELIVERY_DENIED;
}

export async function hasAutomaticInteractionDeliveryHold(db: Executor, input: {
  companyId: string; issueId: string; agentId: string; payload: unknown; context: unknown;
  actorType?: string; actorId?: string | null;
}) {
  const origin = record(record(input.payload)[ORIGIN_KEY]);
  const actorType = origin.actorType === "agent" ? "agent" : input.actorType;
  if (actorType === "user" || actorType === "agent" || commentIds(input.context).length || commentIds(input.payload).length) return false;
  const [latest] = await db.select({ errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.issueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  return isInteractionDeliveryDeniedRun(latest);
}

export function withInteractionDeliveryOrigin(payload: unknown, actorType?: string, actorId?: string | null, savedOrigin?: unknown, actorCompanyId?: string) {
  const next = { ...record(payload) };
  delete next[ORIGIN_KEY];
  const saved = record(savedOrigin);
  if (saved.actorType === "agent" && string(saved.actorId)) {
    actorType = "agent"; actorId = string(saved.actorId); actorCompanyId = string(saved.actorCompanyId) ?? actorCompanyId;
  }
  const pluginOrigin = currentPluginInteractionOrigin();
  if (pluginOrigin && !string(saved.actorId)) { actorType = "agent"; actorId = pluginOrigin.agentId; actorCompanyId = pluginOrigin.companyId; }
  if (actorType && actorId) next[ORIGIN_KEY] = { actorType, actorId,
    ...(actorCompanyId ? { actorCompanyId } : {}),
    ...(saved.operation === "comment" ? { operation: "comment" } : {}),
  };
  return next;
}

function commentIds(context: unknown): string[] {
  const value = record(context);
  return [...new Set([...ids(value.wakeCommentIds), string(value.wakeCommentId), string(value.commentId)]
    .filter((id): id is string => Boolean(id)))];
}

function requiresWakeOriginCheck(wake: Wake): boolean {
  const payload = record(wake.payload);
  const context = record(payload._paperclipWakeContext);
  const reason = string(context.wakeReason) ?? wake.reason;
  const operation = record(payload[ORIGIN_KEY]).operation;
  if (operation === "assign" || operation === "comment") return true;
  if (["issue_commented", "issue_reopened_via_comment", "issue_comment_mentioned"].includes(reason ?? "")) return false;
  if (reason && reason !== "issue_execution_same_name") return true;
  return commentIds(payload).length === 0 && commentIds(context).length === 0;
}

async function recheckAssignmentWakes(db: Executor, run: Run, wakes: Wake[], issueId: string | null, hasComments: boolean) {
  const reason = string(record(run.contextSnapshot).wakeReason);
  const runHasIndependentOrigin = Boolean(run.retryOfRunId || reason &&
    !["issue_commented", "issue_reopened_via_comment", "issue_comment_mentioned", "issue_execution_same_name"].includes(reason));
  const candidates: Array<Wake | undefined> = wakes.length
    ? wakes.filter(requiresWakeOriginCheck) : hasComments && !runHasIndependentOrigin ? [] : [undefined];
  let denial: unknown;
  for (const wake of candidates) {
    const current = record(record(wake ? wake.payload : run.resultJson)[DENIALS_KEY]).assignment
      ?? await assignmentDenial(db, run, wake, issueId);
    if (!current) continue;
    denial ??= current;
    if (wake) await db.update(agentWakeupRequests).set({ status: "skipped", finishedAt: new Date(),
      error: INTERACTION_DELIVERY_DENIED, updatedAt: new Date(),
      payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{interactionPermissionDenials}',
        coalesce(${agentWakeupRequests.payload}->'interactionPermissionDenials', '{}'::jsonb) || ${JSON.stringify({ assignment: current })}::jsonb)`,
    }).where(eq(agentWakeupRequests.id, wake.id));
  }
  return denial;
}

async function unknownOriginDenial(db: Executor, companyId: string, targetAgentId: string,
  operation: "assign" | "comment", issueId: string | null): Promise<DeliveryDenial | null> {
  const [target] = await db.select({ permissions: agents.permissions }).from(agents)
    .where(and(eq(agents.id, targetAgentId), eq(agents.companyId, companyId)));
  const key = operation === "comment" ? "canReceiveCommentsFromAgents" : "canReceiveAssignmentsFromAgents";
  return record(record(target?.permissions).interactions)[key] === false
    ? { code: "agent_interaction_provenance_unavailable", operation, targetAgentId, issueId } : null;
}

export async function queuedCommentInteractionDenial(db: Executor, input: {
  companyId: string; issueId: string; agentId: string; commentId: string; lock?: boolean;
}): Promise<DeliveryDenial | null> {
  const [comment] = await db.select().from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    eq(issueComments.id, input.commentId)));
  let actorAgentId = comment?.authorAgentId ?? comment?.derivedAuthorAgentId;
  if (!actorAgentId && comment?.createdByRunId) {
    const [run] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, comment.createdByRunId), eq(heartbeatRuns.companyId, input.companyId)));
    actorAgentId = run?.agentId;
  }
  if (actorAgentId) return agentInteractionDeliveryDenial(db, {
    companyId: input.companyId, actorAgentId, operation: "comment", issueId: input.issueId,
    targetAgentId: input.agentId, texts: [comment!.body], delivery: true, lock: input.lock,
  });
  if (comment?.authorUserId || comment?.authorType === "system") return null;
  const [interaction] = comment ? [] : await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.id, input.commentId)));
  if (interaction?.resolvedByAgentId) return agentInteractionDeliveryDenial(db, {
    companyId: input.companyId, actorAgentId: interaction.resolvedByAgentId, operation: "comment",
    issueId: input.issueId, targetAgentId: input.agentId, delivery: true, lock: input.lock,
  });
  if (interaction?.resolvedByUserId) return null;
  return unknownOriginDenial(db, input.companyId, input.agentId, "comment", input.issueId);
}

export async function filterQueuedInteractionComments(db: Executor, input: {
  companyId: string; issueId: string; agentId: string; commentIds: string[];
  wake?: Wake | null; lock?: boolean;
}): Promise<{ allowedIds: string[]; denials: Record<string, unknown> }> {
  const previous = record(record(input.wake?.payload)[DENIALS_KEY]);
  const denials = { ...previous };
  const allowedIds: string[] = [];
  for (const commentId of input.commentIds) {
    const denial = previous[commentId] ?? await queuedCommentInteractionDenial(db, { ...input, commentId });
    if (denial) denials[commentId] = denial;
    else allowedIds.push(commentId);
  }
  if (input.wake && allowedIds.length !== input.commentIds.length) {
    const payload = { ...withQueuedCommentIdsInWakePayload(input.wake.payload, allowedIds), [DENIALS_KEY]: denials };
    await db.update(agentWakeupRequests).set({ payload, updatedAt: new Date(),
      ...(allowedIds.length ? {} : { status: "skipped", error: INTERACTION_DELIVERY_DENIED, finishedAt: new Date() }),
    }).where(eq(agentWakeupRequests.id, input.wake.id));
  }
  return { allowedIds, denials };
}

async function assignmentDenial(db: Executor, run: Run, wake: Wake | undefined, issueId: string | null, depth = 0): Promise<DeliveryDenial | null> {
  const origin = record(record(wake?.payload)[ORIGIN_KEY]);
  const reason = wake?.reason ?? string(record(run.contextSnapshot).wakeReason);
  let operation: "assign" | "comment" = origin.operation === "comment" ? "comment" : "assign";
  const capturedAgent = origin.actorType === "agent" ? string(origin.actorId) : null;
  let actorType = capturedAgent ? "agent" : wake?.requestedByActorType;
  let actorId = capturedAgent ?? wake?.requestedByActorId;
  if (wake && (actorType === "system" || !actorType)) {
    const [handoff] = await db.select({ actorType: caseHandoffs.actorType, actorId: caseHandoffs.actorId })
      .from(caseHandoffs).where(and(eq(caseHandoffs.companyId, run.companyId), eq(caseHandoffs.wakeupRequestId, wake.id),
        eq(caseHandoffs.toAgentId, run.agentId)));
    if (handoff) { actorType = handoff.actorType; actorId = handoff.actorId; }
  }
  if (wake && (actorType === "system" || !actorType) && reason !== "issue_blockers_resolved") {
    const payload = record(wake.payload), context = record(payload._paperclipWakeContext);
    const decisionId = string(payload.nativeDecisionId) ?? string(payload.nativeReviewDecisionId)
      ?? string(payload.nativeChildCompletionDecisionId) ?? string(context.nativeReviewDecisionId)
      ?? string(context.nativeChildCompletionDecisionId);
    if (decisionId && /^[0-9a-f-]{36}$/i.test(decisionId)) {
      const [source] = await db.select({ agentId: heartbeatRuns.agentId }).from(statusDecisions)
        .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, statusDecisions.runId), eq(heartbeatRuns.companyId, statusDecisions.companyId)))
        .where(and(eq(statusDecisions.id, decisionId), eq(statusDecisions.companyId, run.companyId)));
      if (source) { actorType = "agent"; actorId = source.agentId; }
      if (reason === "issue_children_completed") operation = "comment";
    }
  }
  if (actorType === "user") return null;
  if (actorType === "agent" && actorId) {
    const payload = record(wake?.payload);
    const texts = agentWakeInteractionTexts(payload);
    const reviewId = string(payload.nativeReviewInteractionId);
    if (reviewId && /^[0-9a-f-]{36}$/i.test(reviewId)) {
      const [review] = await db.select({ summary: issueThreadInteractions.summary, payload: issueThreadInteractions.payload })
        .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, run.companyId), eq(issueThreadInteractions.id, reviewId)));
      for (const value of [review?.summary, record(review?.payload).prompt, record(review?.payload).detailsMarkdown]) {
        if (typeof value === "string") texts.push(value);
      }
    }
    return agentInteractionDeliveryDenial(db, {
      companyId: run.companyId, actorAgentId: actorId, operation, targetAgentId: run.agentId,
      actorCompanyId: string(origin.actorCompanyId) ?? undefined,
      issueId, texts, delivery: true, lock: true,
    });
  }
  if (run.retryOfRunId && (actorType === "system" || !actorType)) {
    if (depth >= 16) return unknownOriginDenial(db, run.companyId, run.agentId, operation, issueId);
    const [source] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.retryOfRunId),
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId)));
    if (source) {
      const [sourceWake] = source.wakeupRequestId ? await db.select().from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.id, source.wakeupRequestId), eq(agentWakeupRequests.companyId, run.companyId))) : [];
      const savedDenial = record(record(source.resultJson)[DENIALS_KEY]).assignment;
      return savedDenial as DeliveryDenial | undefined ?? assignmentDenial(db, source, sourceWake, issueId, depth + 1);
    }
  }
  if (actorType === "system" && wake?.requestedByActorId?.startsWith("native-status") && reason !== "issue_blockers_resolved") {
    return unknownOriginDenial(db, run.companyId, run.agentId, reason === "issue_children_completed" ? "comment" : operation, issueId);
  }
  if (actorType === "system" && reason !== "issue_assigned" && reason !== "issue_created") return null;
  if (wake?.source !== "assignment" && run.invocationSource !== "assignment") return null;
  if (issueId) {
    if (!actorType || actorType === "system") {
      const requestedAt = wake
        ? sql`(select ${agentWakeupRequests.requestedAt} from ${agentWakeupRequests} where ${agentWakeupRequests.id} = ${wake.id} and ${agentWakeupRequests.companyId} = ${run.companyId})`
        : sql`(select ${heartbeatRuns.createdAt} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${run.id} and ${heartbeatRuns.companyId} = ${run.companyId})`;
      const [assignment] = await db.select({ actorType: activityLog.actorType, actorId: activityLog.actorId })
        .from(activityLog).where(and(eq(activityLog.companyId, run.companyId), eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId), lte(activityLog.createdAt, requestedAt),
          or(eq(activityLog.action, "issue.created"), eq(activityLog.action, "issue.updated")),
          sql`${activityLog.details}->>'assigneeAgentId' = ${run.agentId}`))
        .orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1);
      if (assignment?.actorType === "agent") return agentInteractionDeliveryDenial(db, {
        companyId: run.companyId, actorAgentId: assignment.actorId, operation: "assign",
        targetAgentId: run.agentId, issueId, delivery: true, lock: true,
      });
      if (assignment?.actorType === "user") return null;
    }
    const [issue] = await db.select({ createdByAgentId: issues.createdByAgentId, createdByUserId: issues.createdByUserId })
      .from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
    if (reason === "issue_created" && issue?.createdByAgentId) return agentInteractionDeliveryDenial(db, {
      companyId: run.companyId, actorAgentId: issue.createdByAgentId, operation: "assign",
      targetAgentId: run.agentId, issueId, delivery: true, lock: true,
    });
    if (reason === "issue_created" && issue?.createdByUserId) return null;
  }
  return unknownOriginDenial(db, run.companyId, run.agentId, "assign", issueId);
}

export async function recheckQueuedRunInteractions(db: Db, run: Run): Promise<{
  run: Run; denied: boolean; denials: Record<string, unknown>;
}> {
  if (run.status !== "queued") return { run, denied: false, denials: {} };
  const issueId = run.nativeIssueId ?? run.issueId ?? string(record(run.contextSnapshot).issueId);
  return db.transaction(async tx => {
    if (issueId) await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))).for("update");
    const wakes = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
      or(eq(agentWakeupRequests.runId, run.id), run.wakeupRequestId ? eq(agentWakeupRequests.id, run.wakeupRequestId) : undefined),
    )).orderBy(asc(agentWakeupRequests.id)).for("update");
    const [current] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId))).for("update");
    if (!current || current.status !== "queued") return { run: current ?? run, denied: false, denials: {} };
    if (record(current.resultJson).interactionDeliveryDenied === true) {
      return { run: current, denied: true, denials: record(record(current.resultJson)[DENIALS_KEY]) };
    }
    const allIds = [...new Set([...commentIds(current.contextSnapshot), ...wakes.flatMap(wake =>
      [...commentIds(wake.payload), ...commentIds(record(wake.payload)._paperclipWakeContext)])])];
    const denials: Record<string, unknown> = {};
    const allowed = new Set(allIds);
    if (issueId && allIds.length) {
      for (const wake of wakes) {
        const wakeIds = [...new Set([...commentIds(wake.payload), ...commentIds(record(wake.payload)._paperclipWakeContext)])];
        const checked = await filterQueuedInteractionComments(tx, {
          companyId: run.companyId, issueId, agentId: run.agentId, commentIds: wakeIds, wake, lock: true,
        });
        Object.assign(denials, checked.denials);
        for (const id of wakeIds) if (!checked.allowedIds.includes(id)) allowed.delete(id);
      }
      const remaining = await filterQueuedInteractionComments(tx, {
        companyId: run.companyId, issueId, agentId: run.agentId, commentIds: [...allowed], lock: true,
      });
      Object.assign(denials, remaining.denials);
      for (const id of [...allowed]) if (!remaining.allowedIds.includes(id)) allowed.delete(id);
    }
    const assignment = await recheckAssignmentWakes(tx, current, wakes, issueId, allIds.length > 0);
    if (assignment) denials.assignment = assignment;
    if (!Object.keys(denials).length) return { run: current, denied: false, denials };
    if (!denials.assignment && allowed.size === allIds.length) return { run: current, denied: false, denials };
    const denied = Boolean(denials.assignment) || (allIds.length > 0 && allowed.size === 0);
    const primary = wakes.find(wake => wake.id === current.wakeupRequestId);
    if (!denied && primary && allIds.length) await tx.update(agentWakeupRequests).set({
      status: "queued", finishedAt: null, error: null,
      payload: { ...withQueuedCommentIdsInWakePayload(primary.payload, [...allowed]), [DENIALS_KEY]: denials },
      updatedAt: new Date(),
    }).where(eq(agentWakeupRequests.id, primary.id));
    const contextSnapshot = allIds.length
      ? withQueuedCommentIdsInRunContext(current.contextSnapshot, [...allowed]) : record(current.contextSnapshot);
    if (allIds.length) delete contextSnapshot.executionContinuation;
    const [updated] = await tx.update(heartbeatRuns).set({ contextSnapshot,
      resultJson: { ...record(current.resultJson), [DENIALS_KEY]: denials, ...(denied ? { interactionDeliveryDenied: true } : {}) }, updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, current.id)).returning();
    if (assignment && issueId && allowed.size) await retainAllowedMessages(tx, current, issueId, [...allowed]);
    return { run: updated ?? current, denied, denials };
  });
}

export async function assertQueuedCommentInteractionDelivery(db: Executor, input: {
  companyId: string; issueId: string; agentId: string; commentId: string; lock?: boolean;
}) {
  const denial = await queuedCommentInteractionDenial(db, input);
  if (denial) throw forbidden("Queued agent input is no longer permitted.", { ...denial, deliveryCode: INTERACTION_DELIVERY_DENIED });
}

export async function recheckQueuedCommentInteractionDelivery(db: Db, input: {
  companyId: string; issueId: string; agentId: string; commentId: string; queueId: string;
}) {
  const denial = await db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
    const [wake] = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, input.queueId), eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId))).for("update");
    if (!wake || string(record(wake.payload).issueId) !== input.issueId) return null;
    const previous = record(record(wake.payload)[DENIALS_KEY])[input.commentId];
    if (previous) return previous;
    const pendingIds = [...new Set([...commentIds(wake.payload), ...commentIds(record(wake.payload)._paperclipWakeContext)])];
    if (!pendingIds.includes(input.commentId)) return null;
    const checked = await filterQueuedInteractionComments(tx, { ...input, commentIds: pendingIds, wake, lock: true });
    return checked.denials[input.commentId] ?? null;
  });
  if (denial) throw forbidden("Queued agent input is no longer permitted.", {
    ...record(denial), deliveryCode: INTERACTION_DELIVERY_DENIED,
  });
}

export async function filterRunMessageInteractionDelivery(db: Executor, input: {
  companyId: string; runId: string; issueId: string; commentIds: string[];
}): Promise<Set<string>> {
  if (!input.commentIds.length) return new Set();
  const [run] = await db.select({ agentId: heartbeatRuns.agentId, resultJson: heartbeatRuns.resultJson })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
  if (!run) return new Set();
  const previous = record(record(run.resultJson)[DENIALS_KEY]);
  const allowed = new Set<string>();
  const denied: Record<string, unknown> = {};
  for (const commentId of input.commentIds) {
    const denial = previous[commentId] ?? await queuedCommentInteractionDenial(db, { ...input, agentId: run.agentId, commentId });
    if (denial) denied[commentId] = denial;
    else allowed.add(commentId);
  }
  if (Object.keys(denied).some(id => !previous[id])) await db.update(heartbeatRuns).set({
    resultJson: sql`jsonb_set(coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb), '{interactionPermissionDenials}',
      coalesce(${heartbeatRuns.resultJson}->'interactionPermissionDenials', '{}'::jsonb) || ${JSON.stringify(denied)}::jsonb)`,
    updatedAt: new Date(),
  }).where(eq(heartbeatRuns.id, input.runId));
  return allowed;
}

export async function preparedRunInteractionDeliveryDenied(db: Db, run: Run): Promise<boolean> {
  if (run.processPid) return false;
  const [accepted] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(eq(heartbeatRunEvents.eventType, "turn.accepted"), eq(heartbeatRunEvents.eventType, "turn.started")),
  )).limit(1);
  if (accepted) return false;
  const issueId = run.nativeIssueId ?? run.issueId ?? string(record(run.contextSnapshot).issueId);
  const inputIds = commentIds(run.contextSnapshot);
  const allowed = issueId && inputIds.length ? await filterRunMessageInteractionDelivery(db,
    { companyId: run.companyId, runId: run.id, issueId, commentIds: inputIds }) : new Set<string>();
  const wakes = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    or(eq(agentWakeupRequests.runId, run.id), run.wakeupRequestId ? eq(agentWakeupRequests.id, run.wakeupRequestId) : undefined),
  )).orderBy(asc(agentWakeupRequests.id));
  const denial = await recheckAssignmentWakes(db, run, wakes, issueId, inputIds.length > 0);
  if (!denial && allowed.size === inputIds.length) return false;
  if (issueId && allowed.size) await db.transaction(tx => retainAllowedMessages(tx, run, issueId, [...allowed]));
  if (denial) await db.update(heartbeatRuns).set({
    resultJson: sql`jsonb_set(coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb), '{interactionPermissionDenials}',
      coalesce(${heartbeatRuns.resultJson}->'interactionPermissionDenials', '{}'::jsonb) || ${JSON.stringify({ assignment: denial })}::jsonb)
      || '{"interactionDeliveryDenied": true}'::jsonb`, updatedAt: new Date(),
  }).where(eq(heartbeatRuns.id, run.id));
  return true;
}

async function retainAllowedMessages(tx: Executor, run: Run, issueId: string, allowedIds: string[]) {
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))).for("update");
    const [current] = await tx.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id)).for("update");
    if (!current) return;
    const retained = record(record(current.resultJson).interactionRetainedMessages);
    for (const commentId of allowedIds) {
      if (retained[commentId]) continue;
      const [comment] = await tx.select().from(issueComments).where(and(eq(issueComments.id, commentId),
        eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId)));
      if (!comment) continue;
      let actorAgentId = comment.authorAgentId ?? comment.derivedAuthorAgentId;
      if (!actorAgentId && comment.createdByRunId) {
        actorAgentId = await tx.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, comment.createdByRunId), eq(heartbeatRuns.companyId, run.companyId)))
          .then(rows => rows[0]?.agentId ?? null);
      }
      const actorType = actorAgentId ? "agent" : comment.authorUserId ? "user" : "system";
      const actorId = actorAgentId ?? comment.authorUserId;
      const context = { issueId, taskId: issueId, wakeReason: "issue_commented", source: "interaction.permission_recheck",
        wakeCommentId: commentId, wakeCommentIds: [commentId] };
      const payload = withPluginInteractionOrigin(undefined, () =>
        withInteractionDeliveryOrigin({ issueId, commentId, _paperclipWakeContext: context }, actorType, actorId));
      const wakeId = randomUUID();
      await notifyDeferredExecutionWork(tx, { companyId: run.companyId, requestId: wakeId });
      const [wake] = await tx.insert(agentWakeupRequests).values({
        id: wakeId, companyId: run.companyId, agentId: run.agentId, source: "assignment", triggerDetail: "system",
        reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: actorType,
        requestedByActorId: actorId, payload, idempotencyKey: `interaction-retained:${run.id}:${commentId}`,
      }).returning({ id: agentWakeupRequests.id });
      if (wake) retained[commentId] = wake.id;
    }
    await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
      || ${JSON.stringify({ interactionRetainedMessages: retained })}::jsonb`, updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
}
