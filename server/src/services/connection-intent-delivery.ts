import { connectionIntentService } from "./connection-intents.js";
import { and, eq, isNull, lte, asc, notInArray } from "drizzle-orm";
import { connectionIntentDeliveries, issueThreadInteractions, issues, agentWakeupRequests, companyMemberships, type Db } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";
type Heartbeat = ReturnType<typeof heartbeatService>;

export async function wakeConnectionIntentAfterResolution(
  heartbeat: Pick<Heartbeat, "wakeup">,
  input: {
    loaded: {
      issue: { id: string; assigneeAgentId: string | null; status: string };
      interaction: { id: string; resolvedAt?: string | Date | null };
    };
    status: string;
    actorId: string;
  },
) {
  const agentId = input.loaded.issue.assigneeAgentId;
  if (!agentId || !["in_progress", "in_review"].includes(input.loaded.issue.status)) return;
  const resolvedAt = input.loaded.interaction.resolvedAt;
  const interactionResolvedAt = resolvedAt instanceof Date ? resolvedAt.toISOString() : resolvedAt;
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
    idempotencyKey: `connection-intent:${input.loaded.interaction.id}:${input.status}`,
    requestedByActorType: "user",
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
      ...(interactionResolvedAt
        ? { interactionResolvedAt }
        : {}),
      forceFreshSession: true,
    },
    issueStateGuard: {
      statuses: ["in_progress", "in_review"],
      assigneeAgentId: agentId,
    },
  });
}


export function connectionIntentDeliveryService(db: Db, heartbeat: Pick<Heartbeat, "wakeup">) {
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
    const interaction = loaded?.interaction;
    const payload = interaction?.payload as { requestingAgentId?: string; serviceSlug?: string } | undefined;
    if (!loaded || !interaction || !["accepted", "rejected"].includes(interaction.status)
      || ["done", "cancelled"].includes(loaded.issue.status) || loaded.issue.assigneeAgentId !== payload?.requestingAgentId) {
      await db.update(connectionIntentDeliveries).set({ deliveredAt: new Date() }).where(eq(connectionIntentDeliveries.interactionId, interactionId));
      return;
    }
    const userId = interaction.addresseeUserId;
    if (userId !== "local-board") {
      const [membership] = await db.select().from(companyMemberships).where(and(
        eq(companyMemberships.companyId, claimed.companyId), eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId ?? ""), eq(companyMemberships.status, "active"),
      )).limit(1);
      if (!membership?.membershipRole || membership.membershipRole === "viewer") {
        await db.update(connectionIntentDeliveries).set({ deliveredAt: new Date() }).where(eq(connectionIntentDeliveries.interactionId, interactionId));
        return;
      }
    }
    if (interaction.status === "accepted") {
      const ready = await connectionIntentService(db).usableConnectionForAgent({ companyId: claimed.companyId,
        agentId: payload!.requestingAgentId!, responsibleUserId: userId!, serviceSlug: payload!.serviceSlug! });
      if (!ready) return;
    }
    if (!["in_progress", "in_review"].includes(loaded.issue.status)) return;
    const durableWake = () => db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, claimed.companyId),
      eq(agentWakeupRequests.idempotencyKey, `connection-intent:${interactionId}:${interaction.status}`),
      notInArray(agentWakeupRequests.status, ["skipped", "failed", "cancelled"]),
    )).limit(1);
    // Check before dispatch: the previous worker may have crashed after enqueueing.
    if (!(await durableWake()).length) {
      try {
        await wakeConnectionIntentAfterResolution(heartbeat, { loaded, status: interaction.status, actorId: interaction.resolvedByUserId ?? interaction.addresseeUserId! });
      } catch (error) {
        // The unique wake key also protects overlapping leases. Other failures retry.
        if (!(await durableWake()).length) throw error;
      }
    }
    if ((await durableWake()).length) {
      await db.update(connectionIntentDeliveries).set({ deliveredAt: new Date() }).where(eq(connectionIntentDeliveries.interactionId, interactionId));
    }
  }
  return { deliver, tryDeliver: async (id: string) => { try { await deliver(id); } catch { /* Persisted delivery remains due after its lease. */ } }, sweepPending: async () => {
    const rows = await db.select().from(connectionIntentDeliveries).where(and(isNull(connectionIntentDeliveries.deliveredAt), lte(connectionIntentDeliveries.nextAttemptAt, new Date())))
      .orderBy(asc(connectionIntentDeliveries.nextAttemptAt)).limit(50);
    let failed = 0;
    for (const row of rows) { try { await deliver(row.interactionId); } catch { failed += 1; } }
    return { scanned: rows.length, failed };
  }};
}
