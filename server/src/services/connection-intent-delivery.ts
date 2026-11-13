import { isAgentAwaitingSetup, requestAgentLifecycleRecheckInTransaction } from "../modules/agent-lifecycle/index.js";
import { agents, companies } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { connectionIntentService } from "./connection-intents.js";
import { connectionContinuationPendingResponse, findSatisfiedConnection, satisfiedConnectionIntentService } from "./satisfied-connection-intents.js";
import { isAiAuthenticationRepairable, isAiConnectionConfigurationFailure } from "./ai-auth-failure.js";
import { connectionIntentPayloadSchema } from "@paperclipai/shared";
import { and, eq, isNull, lte, asc, inArray, notInArray, desc, sql } from "drizzle-orm";
import { connectionIntentDeliveries, issueThreadInteractions, issues, agentWakeupRequests, companyMemberships, heartbeatRuns, chatConversations, chatEndpoints, type Db } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { connectionDeliveryWaitingForResponse, connectionIntentWaitingForResponse } from "./idle-work-proof.js";
type Heartbeat = ReturnType<typeof heartbeatService>;

export async function wakeConnectionIntentAfterResolution(
  heartbeat: Pick<Heartbeat, "wakeup">,
  input: {
    loaded: {
      issue: { id: string; assigneeAgentId: string | null; status: string };
      interaction: { id: string; resolvedAt?: string | Date | null; payload?: unknown; addresseeUserId?: string | null };
    };
    status: string;
    actorId: string;
    actorType?: "user" | "system";
    /** A task linked to the card wakes under its own key, and only from in_progress. */
    linkedIssue?: true;
  },
) {
  const agentId = input.loaded.issue.assigneeAgentId;
  const wakeStatuses = input.linkedIssue ? ["in_progress"] : ["in_progress", "in_review"];
  if (!agentId || !wakeStatuses.includes(input.loaded.issue.status)) return;
  const resolvedAt = input.loaded.interaction.resolvedAt;
  const interactionResolvedAt = resolvedAt instanceof Date ? resolvedAt.toISOString() : resolvedAt;
  const payload = input.loaded.interaction.payload;
  // Setup repair resumes the accepted queued turn through lifecycle readiness.
  // It never creates an additional provider turn through the generic wake route.
  if (payload !== null && typeof payload === "object" && "agentSetup" in payload && payload.agentSetup === true) return;
  const repairsProviderAuthentication = payload !== null && typeof payload === "object" && "purpose" in payload && payload.purpose === "ai";
  await heartbeat.wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: {
      issueId: input.loaded.issue.id,
      interactionId: input.loaded.interaction.id,
      interactionKind: "connection_intent",
      interactionStatus: input.status,
      mutation: "interaction",
    },
    idempotencyKey: connectionIntentWakeKey(input.loaded.interaction.id, input.status, input.linkedIssue ? input.loaded.issue.id : undefined),
    requestedByActorType: input.actorType ?? "user",
    requestedByActorId: input.actorId,
    contextSnapshot: {
      issueId: input.loaded.issue.id,
      taskId: input.loaded.issue.id,
      interactionId: input.loaded.interaction.id,
      interactionKind: "connection_intent",
      interactionStatus: input.status,
      mutation: "interaction",
      wakeReason: "issue_commented",
      source: "connection_intent.resolved",
      ...(input.actorType === "system" && input.loaded.interaction.addresseeUserId
        ? { responsibleUserId: input.loaded.interaction.addresseeUserId, connectionIntentResolution: "existing_connection" }
        : {}),
      ...(interactionResolvedAt
        ? { interactionResolvedAt }
        : {}),
      // Provider authentication repair retains its existing restart fence.
      // Tool access alone asks the harness to refresh tools on recovery.
      ...(repairsProviderAuthentication ? { forceFreshSession: true } : { refreshTools: true }),
    },
    issueStateGuard: {
      statuses: wakeStatuses,
      assigneeAgentId: agentId,
    },
  });
}

function connectionIntentWakeKey(interactionId: string, status: string, linkedIssueId?: string) {
  return `connection-intent:${interactionId}:${status}${linkedIssueId ? `:${linkedIssueId}` : ""}`;
}


/**
 * The task's latest run when the task still waits on an AI repair: that run
 * failed for a reason the predicate accepts and is the card's source run or a
 * later retry of the same task. A later success, or any other later outcome,
 * means the task moved on and must not be resumed again.
 */
async function latestRunWaitingOnAiRepair(
  db: Db,
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId">,
  sourceRunId: string | null | undefined,
  accepts: (run: typeof heartbeatRuns.$inferSelect) => boolean,
) {
  if (!sourceRunId) return null;
  const [latest] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId),
    sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId', ${heartbeatRuns.nativeIssueId}::text) = ${issue.id}`,
  )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  if (!latest || latest.status !== "failed" || !accepts(latest)) return null;
  if (latest.id === sourceRunId) return latest;
  const [source] = await db.select({ createdAt: heartbeatRuns.createdAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, sourceRunId), eq(heartbeatRuns.companyId, issue.companyId)));
  return source && latest.createdAt >= source.createdAt ? latest : null;
}

export function connectionIntentDeliveryService(db: Db, heartbeat: Pick<Heartbeat, "wakeup">) {
  const satisfiedIntents = satisfiedConnectionIntentService(db);
  // Only a repaired AI-authentication failure may reopen a blocked task. An old
  // card must never resume a newer failure, a reassignment, or a manual hold.
  async function restoreAiBlockedTask(loaded: {
    issue: typeof issues.$inferSelect;
    interaction: typeof issueThreadInteractions.$inferSelect;
  }, options: { sourceRunId?: string | null; assigneeAgentId?: string | null; system?: boolean } = {}) {
    const sourceRunId = options.sourceRunId ?? loaded.interaction.sourceRunId;
    const assigneeAgentId = options.assigneeAgentId ?? loaded.issue.assigneeAgentId;
    const publications: ActivityPublication[] = [];
    const restored = await db.transaction(async (tx) => {
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.id, loaded.issue.id), eq(issues.companyId, loaded.issue.companyId),
      )).for("update");
      if (!issue || issue.status !== "blocked" || issue.assigneeAgentId !== assigneeAgentId) return null;
      const latest = await latestRunWaitingOnAiRepair(tx as unknown as Db, issue, sourceRunId, isAiConnectionConfigurationFailure);
      if (!latest) return null;
      // Restricted external chat retries require their original chat provenance.
      // Their existing Try again path owns that authorization and delivery.
      const [restrictedChat] = await tx.select({ id: chatConversations.id }).from(chatConversations)
        .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatConversations.endpointId))
        .where(and(eq(chatConversations.companyId, issue.companyId), eq(chatConversations.issueId, issue.id),
          eq(chatEndpoints.externalExecutionPolicy, "restricted"))).limit(1);
      if (restrictedChat) return null;
      const recoveries = issueRecoveryActionService(db);
      const recovery = await recoveries.getActiveForIssue(issue.companyId, issue.id, tx);
      if (!recovery || recovery.cause !== "configuration_incomplete" || recovery.evidence.latestRunId !== latest.id) return null;
      const actorId = loaded.interaction.resolvedByUserId ?? loaded.interaction.addresseeUserId!;
      const updated = await issueService(db).update(issue.id, {
        status: "in_progress", actorUserId: options.system ? null : actorId, companyGuard: issue.companyId,
      }, tx, publications);
      await recoveries.resolveActiveForIssue({ companyId: issue.companyId, sourceIssueId: issue.id,
        actionId: recovery.id, status: "resolved", outcome: "restored", resolutionNote: options.system ? "The AI connection is healthy again; restored automatically." : "AI connection restored by the responsible user." }, tx);
      return updated;
    });
    for (const publication of publications) publishActivity(publication);
    if (restored) await logActivity(db, { companyId: restored.companyId, actorType: options.system ? "system" : "user",
      actorId: options.system ? "connection-reconciliation" : loaded.interaction.resolvedByUserId ?? loaded.interaction.addresseeUserId!,
      action: "issue.updated", entityType: "issue", entityId: restored.id,
      details: { status: restored.status, _previous: { status: "blocked" }, source: "ai_connection_restored", interactionId: loaded.interaction.id } });
    return restored;
  }

  /**
   * A system reconciliation resumes a task only while it still waits on this
   * repair: its latest run is the failed source run or a later failed retry
   * of the same task, it is open and not held
   * for review, and its dependencies are resolved. A human answer keeps its
   * existing delivery rules.
   */
  async function waitingOnAiRepair(issue: typeof issues.$inferSelect, sourceRunId: string | null | undefined) {
    if (issue.status !== "in_progress" || issue.assigneeUserId) return false;
    if (!await latestRunWaitingOnAiRepair(db, issue, sourceRunId, isAiAuthenticationRepairable)) return false;
    return (await issueService(db).getDependencyReadiness(issue.id)).isDependencyReady;
  }

  /** Wake each task linked to a resolved AI repair card at most once. */
  async function wakeLinkedAiRepairTasks(interaction: typeof issueThreadInteractions.$inferSelect, connectionRestored: boolean) {
    const payload = connectionIntentPayloadSchema.safeParse(interaction.payload).data;
    if (payload?.purpose !== "ai" || !payload.linkedIssues?.length || !interaction.addresseeUserId) return;
    // The connection this card was resolved against: the one a person chose,
    // or the repaired connection a system reconciliation recorded.
    const resolvedConnectionId = interaction.result && "connectionId" in interaction.result
      && typeof interaction.result.connectionId === "string" ? interaction.result.connectionId : payload.repairConnectionId;
    for (const linked of payload.linkedIssues) {
      const [issue] = await db.select().from(issues).where(and(
        eq(issues.id, linked.issueId), eq(issues.companyId, interaction.companyId)));
      if (!issue || issue.assigneeAgentId !== linked.agentId) continue;
      // Check the agent's usable connection before changing the task: a task
      // whose agent now fails on another connection waits on that connection's
      // own card, and this card must not restore or wake it.
      if (connectionRestored) {
        const usable = await connectionIntentService(db).usableConnectionForAgent({ companyId: interaction.companyId,
          agentId: linked.agentId, responsibleUserId: interaction.addresseeUserId, serviceSlug: payload.serviceSlug,
          purpose: "ai", sourceRunId: linked.sourceRunId });
        // The usable connection must be one this card repaired: the
        // connection it was resolved against or its original repair target.
        const repaired = [resolvedConnectionId, payload.repairConnectionId].filter(Boolean);
        if (!usable || (repaired.length && !repaired.includes(usable.id))) continue;
      }
      let current = issue;
      if (connectionRestored && current.status === "blocked") {
        const restored = await restoreAiBlockedTask({ issue: current, interaction },
          { sourceRunId: linked.sourceRunId, assigneeAgentId: linked.agentId, system: interaction.status !== "accepted" });
        if (!restored) continue;
        current = restored;
      }
      if (!await waitingOnAiRepair(current, linked.sourceRunId)) continue;
      const key = connectionIntentWakeKey(interaction.id, interaction.status, current.id);
      const [woken] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, interaction.companyId), eq(agentWakeupRequests.idempotencyKey, key),
        notInArray(agentWakeupRequests.status, ["skipped", "failed", "cancelled"]))).limit(1);
      if (woken) continue;
      await wakeConnectionIntentAfterResolution(heartbeat, {
        loaded: { issue: current, interaction },
        status: interaction.status,
        actorId: interaction.status === "accepted" ? interaction.resolvedByUserId ?? interaction.addresseeUserId : "connection-reconciliation",
        ...(interaction.status === "accepted" ? {} : { actorType: "system" as const }),
        linkedIssue: true,
      });
    }
  }

  async function deliver(interactionId: string) {
    // Deterministic acceptance-test failpoint: preserve committed outcomes across a server restart.
    if (process.env.NODE_ENV === "test" && process.env.PAPERCLIP_TEST_CONNECTION_DELIVERY_HOLD === "1") return;
    const now = new Date();
    // The retry deadline is also the worker lease. A crashed worker is reclaimed.
    const [claimed] = await db.update(connectionIntentDeliveries)
      .set({ nextAttemptAt: new Date(now.getTime() + 60_000) })
      .where(and(eq(connectionIntentDeliveries.interactionId, interactionId), isNull(connectionIntentDeliveries.deliveredAt), lte(connectionIntentDeliveries.nextAttemptAt, now))).returning();
    if (!claimed) return;
    const [loaded] = await db.select({ interaction: issueThreadInteractions, issue: issues })
      .from(issueThreadInteractions).innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
      .where(and(eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, claimed.companyId), eq(issues.companyId, claimed.companyId)));
    let interaction = loaded?.interaction;
    const retiredForAvailableConnection = interaction?.status === "expired"
      && interaction.result?.outcome === "expired" && "connectionId" in interaction.result
      && typeof interaction.result.connectionId === "string";
    const payload = interaction?.payload as { requestingAgentId?: string; serviceSlug?: string; purpose?: "ai"; agentSetup?: true; agentSetupOperationId?: string; linkedIssues?: unknown[] } | undefined;
    const settle = () => db.update(connectionIntentDeliveries).set({ deliveredAt: new Date() }).where(and(eq(connectionIntentDeliveries.interactionId, interactionId),
      eq(connectionIntentDeliveries.companyId, claimed.companyId),
      eq(connectionIntentDeliveries.nextAttemptAt, claimed.nextAttemptAt), isNull(connectionIntentDeliveries.deliveredAt)));
    if (!loaded || !interaction || (!retiredForAvailableConnection && !["accepted", "rejected"].includes(interaction.status))) {
      await settle();
      return;
    }
    const ownerStale = ["done", "cancelled"].includes(loaded.issue.status) || loaded.issue.assigneeAgentId !== payload?.requestingAgentId;
    // Tasks linked to one shared AI repair card resume even when the task that
    // owns the card was closed or reassigned meanwhile.
    const fanOut = payload?.purpose === "ai" && payload.agentSetup !== true && Boolean(payload.linkedIssues?.length);
    if (ownerStale && !fanOut) {
      await settle();
      return;
    }
    const userId = interaction.addresseeUserId;
    if (userId !== "local-board") {
      const [membership] = await db.select().from(companyMemberships).where(and(
        eq(companyMemberships.companyId, claimed.companyId), eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId ?? ""), eq(companyMemberships.status, "active"),
      )).limit(1);
      if (!membership?.membershipRole || membership.membershipRole === "viewer") {
        await settle();
        return;
      }
    }
    if (fanOut) {
      await wakeLinkedAiRepairTasks(interaction, interaction.status === "accepted" || retiredForAvailableConnection);
      if (ownerStale) {
        await settle();
        return;
      }
    }
    if (interaction.status === "accepted" && payload?.agentSetup !== true) {
      const ready = await connectionIntentService(db).usableConnectionForAgent({ companyId: claimed.companyId,
        agentId: payload!.requestingAgentId!, responsibleUserId: userId!, serviceSlug: payload!.serviceSlug!, purpose: payload!.purpose, sourceRunId: interaction.sourceRunId,
        agentSetup: payload!.agentSetup, agentSetupOperationId: payload!.agentSetupOperationId });
      if (!ready) return;
    }
    if (payload?.agentSetup === true && payload.purpose === "ai") {
      await db.transaction(async tx => {
        const [task] = await tx.select().from(issues).where(and(eq(issues.id, loaded.issue.id), eq(issues.companyId, claimed.companyId))).for("update");
        const [source] = await tx.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, interaction!.sourceRunId!), eq(heartbeatRuns.companyId, claimed.companyId),
          eq(heartbeatRuns.agentId, payload.requestingAgentId!),
        )).for("no key update");
        const [agent] = await tx.select().from(agents).where(and(eq(agents.id, payload.requestingAgentId!), eq(agents.companyId, claimed.companyId))).for("update");
        const [company] = await tx.select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
          .from(companies).where(eq(companies.id, claimed.companyId));
        const verificationUserId = agent?.lifecycleOperation?.responsibleUserId ?? company?.defaultResponsibleUserId;
        if (interaction!.status === "accepted" && task && !["done", "cancelled"].includes(task.status)
          && task.assigneeAgentId === payload.requestingAgentId && source?.status === "queued" && !source.startedAt
          && source.runtimeMode === "legacy" && agent && isAgentAwaitingSetup(agent)
          && verificationUserId === interaction!.addresseeUserId
          && (!payload.agentSetupOperationId || agent.lifecycleOperation?.id === payload.agentSetupOperationId)) {
          const ready = await connectionIntentService(db).usableConnectionForAgent({ companyId: claimed.companyId,
            agentId: payload.requestingAgentId!, responsibleUserId: userId!, serviceSlug: payload.serviceSlug!, purpose: "ai",
            sourceRunId: interaction!.sourceRunId, agentSetup: true, agentSetupOperationId: payload.agentSetupOperationId });
          if (!ready) return;
          await requestAgentLifecycleRecheckInTransaction(tx, { companyId: claimed.companyId, agentId: agent.id,
            configurationRepaired: true }, () => notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle));
        }
        // Decline, Stop and stale ownership also settle this delivery without a wake.
        await tx.update(connectionIntentDeliveries).set({ deliveredAt: new Date() }).where(and(
          eq(connectionIntentDeliveries.interactionId, interactionId), eq(connectionIntentDeliveries.companyId, claimed.companyId),
          eq(connectionIntentDeliveries.nextAttemptAt, claimed.nextAttemptAt), isNull(connectionIntentDeliveries.deliveredAt)));
      });
      return;
    }
    if (retiredForAvailableConnection) {
      const publications: ActivityPublication[] = [];
      const current = await db.transaction(async tx => {
        const [task] = await tx.select().from(issues).where(and(eq(issues.id, loaded.issue.id), eq(issues.companyId, claimed.companyId))).for("update");
        const [card] = await tx.select().from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, claimed.companyId),
          eq(issueThreadInteractions.issueId, loaded.issue.id))).for("update");
        if (!task || !card || card.status !== "expired" || card.result?.outcome !== "expired") return null;
        const ready = await findSatisfiedConnection(tx as unknown as Db, task, { ...card, status: "pending" });
        if (!ready) return null;
        if (ready.id !== (card.result as { connectionId: string }).connectionId) {
          const previousConnectionId = (card.result as { connectionId: string }).connectionId;
          // This is a system observation of existing access. It grants nothing
          // and never changes or impersonates a human decision.
          const [updated] = await tx.update(issueThreadInteractions).set({ result: { ...card.result,
            connectionId: ready.id }, updatedAt: new Date() }).where(eq(issueThreadInteractions.id, card.id)).returning();
          Object.assign(card, updated);
          await logActivity(tx as unknown as Db, { companyId: claimed.companyId, actorType: "system", actorId: "connection-reconciliation",
            action: "issue.thread_interaction_resolved", entityType: "issue", entityId: task.id,
            details: { interactionId, interactionKind: "connection_intent", status: "expired", connectionId: ready.id,
              previousConnectionId, resolutionSource: "existing_connection_refreshed" } }, publications);
        }
        return { task, card, waiting: await connectionContinuationPendingResponse(tx as unknown as Db, task, card.addresseeUserId, card.sourceRunId) };
      });
      for (const publication of publications) publishActivity(publication);
      if (!current || current.waiting) return;
      loaded.issue = current.task;
      loaded.interaction = current.card;
      interaction = current.card;
    }
    if ((interaction.status === "accepted" || retiredForAvailableConnection) && payload?.purpose === "ai" && loaded.issue.status === "blocked") {
      const restored = await restoreAiBlockedTask(loaded, { system: retiredForAvailableConnection });
      if (!restored) return;
      loaded.issue = restored;
    }
    if (!["in_progress", "in_review"].includes(loaded.issue.status)) return;
    // A system reconciliation of an AI repair resumes only a task that still
    // waits on it. Review-held, dependency-blocked and already-continued
    // tasks keep their state; their own paths resume them.
    if (retiredForAvailableConnection && payload?.purpose === "ai" && !await waitingOnAiRepair(loaded.issue, interaction.sourceRunId)) {
      await settle();
      return;
    }
    const durableWake = () => db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, claimed.companyId),
      eq(agentWakeupRequests.idempotencyKey, `connection-intent:${interactionId}:${interaction.status}`),
      notInArray(agentWakeupRequests.status, ["skipped", "failed", "cancelled"]),
    )).limit(1);
    // Check before dispatch: the previous worker may have crashed after enqueueing.
    if (!(await durableWake()).length) {
      try {
        await wakeConnectionIntentAfterResolution(heartbeat, { loaded, status: interaction.status,
          actorId: retiredForAvailableConnection ? "connection-reconciliation" : interaction.resolvedByUserId ?? interaction.addresseeUserId!,
          ...(retiredForAvailableConnection ? { actorType: "system" as const } : {}),
        });
      } catch (error) {
        // The unique wake key also protects overlapping leases. Other failures retry.
        if (!(await durableWake()).length) throw error;
      }
    }
    if ((await durableWake()).length) {
      await db.update(connectionIntentDeliveries).set({ deliveredAt: new Date() }).where(and(eq(connectionIntentDeliveries.interactionId, interactionId),
        eq(connectionIntentDeliveries.companyId, claimed.companyId),
        eq(connectionIntentDeliveries.nextAttemptAt, claimed.nextAttemptAt), isNull(connectionIntentDeliveries.deliveredAt)));
    }
  }
  let maintenanceAt: number | null = null;
  async function hasPending() {
    const [state] = await db.execute<{ active: boolean; present: boolean }>(sql`
      WITH pending_deliveries AS (
        SELECT (${sql.raw(connectionDeliveryWaitingForResponse('d'))}) IS TRUE AS passive
        FROM connection_intent_deliveries d WHERE d.delivered_at IS NULL
      ), pending_intents AS (
        SELECT (${sql.raw(connectionIntentWaitingForResponse('card', 'task'))}) IS TRUE AS passive
        FROM issue_thread_interactions card LEFT JOIN issues task ON task.id = card.issue_id AND task.company_id = card.company_id
        WHERE card.kind = 'connection_intent' AND card.status = 'pending'
          AND (task.id IS NULL OR (task.status IN ('in_progress', 'in_review') AND task.assignee_user_id IS NULL))
      ) SELECT EXISTS (SELECT 1 FROM pending_deliveries WHERE NOT passive
        UNION ALL SELECT 1 FROM pending_intents WHERE NOT passive) AS active,
        EXISTS (SELECT 1 FROM pending_deliveries UNION ALL SELECT 1 FROM pending_intents) AS present`);
    if (!state || typeof state.active !== "boolean" || typeof state.present !== "boolean") throw new Error("Connection work state is unknown");
    // Passive records need no admitted-work hold or wake alarm. While the
    // process is already awake, keep the existing reconciliation cadence so
    // new access or responses resume work even without a queue notification.
    maintenanceAt = !state.active && state.present ? Date.now() + 5_000 : null;
    return state.active;
  }
  return { deliver, hasPending, nextRunAt: () => maintenanceAt, tryDeliver: async (id: string) => { try { await deliver(id); } catch { /* Persisted delivery remains due after its lease. */ } }, sweepPending: async () => {
    await satisfiedIntents.sweepPending();
    const rows = await db.select().from(connectionIntentDeliveries).where(and(isNull(connectionIntentDeliveries.deliveredAt), lte(connectionIntentDeliveries.nextAttemptAt, new Date()),
      sql`(${sql.raw(connectionDeliveryWaitingForResponse('connection_intent_deliveries'))}) IS NOT TRUE`))
      .orderBy(asc(connectionIntentDeliveries.nextAttemptAt)).limit(50);
    let failed = 0;
    for (const row of rows) { try { await deliver(row.interactionId); } catch { failed += 1; } }
    return { scanned: rows.length, failed };
  }};
}
