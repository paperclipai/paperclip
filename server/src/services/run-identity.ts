import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, heartbeatRunEvents, issueComments, issueThreadInteractions, issues, runIdentityContexts, type Db } from "@paperclipai/db";
import { conflict, forbidden } from "../errors.js";

export type RunIdentityContext = typeof runIdentityContexts.$inferSelect;
type Executor = Pick<Db, "select" | "insert" | "update">;

/** Match task mutation ordering: lock the task before the run, never the reverse. */
async function lockIdentityTask(executor: Pick<Db, "select">, companyId: string, runId: string) {
  const [run] = await executor.select({ context: heartbeatRuns.contextSnapshot, issueId: heartbeatRuns.nativeIssueId })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
  const issueId = run?.context?.issueId ?? run?.context?.taskId ?? run?.issueId;
  if (typeof issueId === "string") await executor.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("update");
}

async function append(executor: Executor, input: {
  companyId: string; runId: string; responsibleUserId: string | null;
  messageId?: string | null; parentContextId?: string | null; cause: string;
  correlationId: string; status?: "accepted" | "pending";
}) {
  const [existing] = await executor.select().from(runIdentityContexts).where(and(
    eq(runIdentityContexts.runId, input.runId), eq(runIdentityContexts.correlationId, input.correlationId),
  ));
  if (existing) return existing;
  const [last] = await executor.select().from(runIdentityContexts)
    .where(eq(runIdentityContexts.runId, input.runId)).orderBy(desc(runIdentityContexts.revision)).limit(1);
  const [created] = await executor.insert(runIdentityContexts).values({
    ...input, revision: (last?.revision ?? 0) + 1,
    acceptedAt: input.status === "pending" ? null : new Date(),
  }).returning();
  if (!created) throw new Error("Failed to persist run identity");
  if (created.status === "accepted") await activate(executor, created);
  return created;
}

async function activate(executor: Executor, context: RunIdentityContext) {
  const [run] = await executor.update(heartbeatRuns).set({
    responsibleUserId: context.responsibleUserId,
    activeIdentityContextId: context.id, updatedAt: new Date(),
  }).where(and(eq(heartbeatRuns.id, context.runId), eq(heartbeatRuns.companyId, context.companyId))).returning();
  const issueId = run?.contextSnapshot?.issueId ?? run?.contextSnapshot?.taskId;
  if (typeof issueId === "string") await executor.update(issues).set({ continuationIdentityContextId: context.id })
    .where(and(eq(issues.id, issueId), eq(issues.companyId, context.companyId)));
}

/** Called only for newly dispatched runs. Historical rows are never backfilled. */
export async function initializeRunIdentity(db: Db, input: {
  companyId: string; runId: string; responsibleUserId: string | null;
  messageIds?: string[]; issueId?: string | null; interactionId?: string | null; parentRunId?: string | null; parentContextId?: string | null; cause: string;
}) {
  return db.transaction(async (tx) => {
    await lockIdentityTask(tx, input.companyId, input.runId);
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    )).for("update");
    if (!run) throw forbidden("Run identity does not belong to this company");
    if (run.activeIdentityContextId) {
      const [current] = await tx.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, run.activeIdentityContextId));
      return current!;
    }
    const [parent] = input.parentRunId ? await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.parentRunId), eq(heartbeatRuns.companyId, input.companyId),
    )) : [];
    const [interaction] = input.interactionId && input.issueId ? await tx.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, input.interactionId), eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
    )) : [];
    const parentId = interaction?.sourceIdentityContextId ?? input.parentContextId ?? parent?.activeIdentityContextId;
    const [origin] = parentId ? await tx.select().from(runIdentityContexts).where(and(
      eq(runIdentityContexts.id, parentId), eq(runIdentityContexts.companyId, input.companyId),
      eq(runIdentityContexts.status, "accepted"),
    )) : [];
    if (parentId && !origin) throw forbidden("Originating execution identity is unavailable");
    let current = await append(tx, {
      companyId: input.companyId, runId: input.runId,
      responsibleUserId: origin ? origin.responsibleUserId : input.responsibleUserId,
      parentContextId: origin?.id ?? null,
      cause: origin?.cause === "company_default" ? "company_default" : input.cause, correlationId: "dispatch",
    });
    const ids = [...new Set(input.messageIds ?? [])];
    const comments = ids.length && input.issueId ? await tx.select().from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId), inArray(issueComments.id, ids),
    )) : [];
    for (const id of ids) {
      const comment = comments.find((c) => c.id === id);
      if (!comment?.authorUserId) continue;
      current = await append(tx, {
        companyId: input.companyId, runId: input.runId, responsibleUserId: comment.authorUserId,
        messageId: id, parentContextId: current.id, cause: "instruction", correlationId: `message:${id}`,
      });
    }
    return current;
  });
}

/** Caller holds the task and run row locks, in that order. Reserve before delivery so acquisitions cannot guess. */
export async function prepareSteeredIdentity(executor: Executor, input: {
  companyId: string; runId: string; messageId: string; issueId: string;
}) {
  const [run] = await executor.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
  ));
  const [comment] = await executor.select().from(issueComments).where(and(
    eq(issueComments.id, input.messageId), eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
  ));
  if (!run || !comment?.authorUserId) throw forbidden("Steering requires an authenticated message author");
  if (run.status !== "running" || (run.contextSnapshot?.issueId !== input.issueId && run.contextSnapshot?.taskId !== input.issueId)) {
    throw conflict("Steering targets a different or inactive execution");
  }
  return append(executor, {
    companyId: input.companyId, runId: input.runId, responsibleUserId: comment.authorUserId,
    messageId: comment.id, parentContextId: run.activeIdentityContextId,
    cause: "steering", correlationId: `message:${comment.id}`, status: "pending",
  });
}

export async function reserveSteeredIdentity(db: Db, input: Parameters<typeof prepareSteeredIdentity>[1]) {
  return db.transaction(async (tx) => {
    await lockIdentityTask(tx, input.companyId, input.runId);
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    )).for("update");
    // Processes started before the broker rollout keep their original environment.
    if (!run?.activeIdentityContextId) return null;
    const [pending] = await tx.select().from(runIdentityContexts).where(and(
      eq(runIdentityContexts.runId, run.id), eq(runIdentityContexts.status, "pending"),
    )).limit(1);
    if (pending && pending.messageId !== input.messageId) {
      if (await storedSteeringAcknowledgement(tx, pending)) await acceptSteeredIdentity(tx, pending);
      else throw conflict("A prior steering acknowledgement must be reconciled first");
    }
    const [existing] = await tx.select().from(runIdentityContexts).where(and(
      eq(runIdentityContexts.runId, run.id), eq(runIdentityContexts.messageId, input.messageId),
      eq(runIdentityContexts.status, "accepted"),
    ));
    if (existing) return existing;
    const context = await prepareSteeredIdentity(tx, input);
    if (context.status === "rejected") {
      await tx.update(runIdentityContexts).set({ status: "pending" }).where(eq(runIdentityContexts.id, context.id));
      return { ...context, status: "pending" };
    }
    return context;
  });
}

export async function rejectSteeredIdentity(db: Db, context: RunIdentityContext) {
  await db.update(runIdentityContexts).set({ status: "rejected" }).where(and(
    eq(runIdentityContexts.id, context.id), eq(runIdentityContexts.status, "pending"),
  ));
}

export async function acceptSteeredIdentity(executor: Executor, context: RunIdentityContext) {
  // A replay must not reactivate a historical identity after later instructions.
  const [accepted] = await executor.update(runIdentityContexts)
    .set({ status: "accepted", acceptedAt: new Date() }).where(and(
      eq(runIdentityContexts.id, context.id), eq(runIdentityContexts.status, "pending"),
    )).returning();
  if (accepted) await activate(executor, accepted);
}

export async function captureRunIdentity(db: Db, input: { companyId: string; runId: string; agentId: string }) {
  // Lock acquisition serializes with steering delivery and its durable acknowledgement.
  return db.transaction(async (tx) => {
    await lockIdentityTask(tx, input.companyId, input.runId);
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    )).for("update");
    if (!run || run.status !== "running") throw forbidden("Credential acquisition requires this agent's active run");
    const [pending] = await tx.select().from(runIdentityContexts).where(and(
      eq(runIdentityContexts.runId, run.id), eq(runIdentityContexts.status, "pending"),
    )).limit(1);
    if (pending) {
      const acknowledgement = await storedSteeringAcknowledgement(tx, pending);
      if (!acknowledgement) throw conflict("Message acceptance is being reconciled; retry credential acquisition");
      await acceptSteeredIdentity(tx, pending);
      run.activeIdentityContextId = pending.id;
      run.responsibleUserId = pending.responsibleUserId;
    }
    const [context] = run.activeIdentityContextId ? await tx.select().from(runIdentityContexts).where(and(
      eq(runIdentityContexts.id, run.activeIdentityContextId), eq(runIdentityContexts.runId, run.id),
    )) : [];
    return { run, context: context ?? null };
  });
}

export async function listRunIdentityContexts(db: Db, companyId: string, runId: string) {
  return db.select().from(runIdentityContexts).where(and(
    eq(runIdentityContexts.companyId, companyId), eq(runIdentityContexts.runId, runId),
  )).orderBy(asc(runIdentityContexts.revision));
}

/** Late native acknowledgements settle reservations even when the HTTP caller timed out. */
export async function reconcileSteeredIdentity(db: Db, context: RunIdentityContext) {
  await db.transaction(async (tx) => {
    await lockIdentityTask(tx, context.companyId, context.runId);
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, context.runId), eq(heartbeatRuns.companyId, context.companyId),
    )).for("update");
    if (!run) return;
    await acceptSteeredIdentity(tx, context);
  });
}

/** Only events validated and persisted by the native control-plane transport count. */
export async function storedSteeringAcknowledgement(executor: Pick<Db, "select">, context: RunIdentityContext) {
  if (!context.messageId) return null;
  const [receipt] = await executor.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, context.companyId), eq(heartbeatRunEvents.runId, context.runId),
    eq(heartbeatRunEvents.eventType, "item.completed"),
    sql`${heartbeatRunEvents.sourceEventId} is not null`,
    sql`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind' = 'steering_acknowledgement'`,
    sql`${heartbeatRunEvents.payload}->'prpEvent'->>'itemId' like ${`%:steer:${context.messageId}`}`,
  )).limit(1);
  const event = receipt?.payload?.prpEvent as { turnId?: string } | undefined;
  return typeof event?.turnId === "string" ? { turnId: event.turnId } : null;
}
