import { and, asc, eq, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { grokBotDispatches, grokBotRoutines, dotAgentBindings, dotRunnerAssignments, dotRunnerOperations, dotMailboxItems, heartbeatRuns, type Db } from "@paperclipai/db";
import { grokRoutineService } from "./routine.js";
import type { deliverGrokRoutineWake } from "./webhook.js";
import { externalBotEnabled } from "../external-bot-authority.js";

/** Drain only unsent durable intents. Sending/accepted/unknown work never retries. */
export function createGrokRoutineDispatcher(db: Db, isBackgroundWorkEnabled: () => boolean = () => true, deliver?: typeof deliverGrokRoutineWake) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let stopped = false;
  async function tick() {
    if (running || stopped || !isBackgroundWorkEnabled() || !await externalBotEnabled(db, "grok_bot")) return;
    running = true;
    try {
      const service = grokRoutineService(db, deliver);
      // A proactive caller receives an immediate assignment without an echo.
      // Queued admission gets one delayed wake only while still unaccepted.
      const proactive = await db.select({ assignment: dotRunnerAssignments }).from(dotRunnerAssignments)
        .innerJoin(dotAgentBindings, eq(dotAgentBindings.id, dotRunnerAssignments.bindingId))
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, dotRunnerAssignments.runId))
        .where(and(eq(dotAgentBindings.providerKind, "grok_bot"), isNull(dotAgentBindings.revokedAt), eq(dotRunnerAssignments.status, "offered"),
          lt(dotRunnerAssignments.createdAt, new Date(Date.now() - 10_000)), sql`${heartbeatRuns.contextSnapshot}->'grokProactiveRequest'->>'bindingId' = ${dotAgentBindings.id}::text`)).limit(10);
      for (const { assignment } of proactive) {
        try { await service.reserve({ companyId: assignment.companyId, agentId: assignment.agentId, bindingId: assignment.bindingId,
          assignmentId: assignment.id, kind: "mailbox_updated", sourceEventId: `proactive-admission:${assignment.id}` }); } catch { /* Current authority is rechecked on reservation and send. */ }
      }
      // Comments and their deferred wake commit independently of egress.
      // Discover committed, unread input here; recovery never erases feedback.
      const followUps = await db.select({ item: dotMailboxItems, assignment: dotRunnerAssignments }).from(dotMailboxItems)
        .innerJoin(dotRunnerAssignments, and(eq(dotRunnerAssignments.id, dotMailboxItems.assignmentId),
          eq(dotRunnerAssignments.bindingGeneration, dotMailboxItems.bindingGeneration)))
        .innerJoin(dotAgentBindings, eq(dotAgentBindings.id, dotRunnerAssignments.bindingId))
        .where(and(eq(dotAgentBindings.providerKind, "grok_bot"), isNull(dotAgentBindings.revokedAt),
          eq(dotMailboxItems.kind, "follow_up"), eq(dotRunnerAssignments.status, "accepted"),
          sql`coalesce(${dotMailboxItems.references}->>'consumed', 'false') <> 'true'`,
          sql`not exists (select 1 from ${grokBotDispatches} where ${grokBotDispatches.assignmentId} = ${dotRunnerAssignments.id} and ${grokBotDispatches.status} in ('prepared', 'sending', 'accepted', 'unknown'))`,
          sql`not exists (select 1 from ${grokBotDispatches} where ${grokBotDispatches.bindingId} = ${dotRunnerAssignments.bindingId} and ${grokBotDispatches.sourceEventId} = ${dotMailboxItems.sourceEventId})`))
        .orderBy(asc(dotMailboxItems.id)).limit(20);
      const feedbackAssignments = new Set<string>();
      for (const { item, assignment } of followUps) {
        if (feedbackAssignments.has(assignment.id)) continue;
        feedbackAssignments.add(assignment.id);
        try { await service.reserve({ companyId: assignment.companyId, agentId: assignment.agentId, bindingId: assignment.bindingId,
          assignmentId: assignment.id, kind: "mailbox_updated", sourceEventId: item.sourceEventId }); } catch { /* The durable comment/wake remains queued behind recovery or current authority. */ }
      }
      const results = await db.select({ operation: dotRunnerOperations, assignment: dotRunnerAssignments }).from(dotRunnerOperations)
        .innerJoin(dotRunnerAssignments, eq(dotRunnerAssignments.id, dotRunnerOperations.assignmentId))
        .innerJoin(dotAgentBindings, eq(dotAgentBindings.id, dotRunnerAssignments.bindingId))
        .innerJoin(grokBotRoutines, eq(grokBotRoutines.bindingId, dotAgentBindings.id))
        .where(and(eq(dotAgentBindings.providerKind, "grok_bot"), isNull(dotAgentBindings.revokedAt), eq(dotRunnerAssignments.status, "accepted"),
          lt(grokBotRoutines.lastContactAt, new Date(Date.now() - 15_000)),
          sql`not exists (select 1 from ${grokBotDispatches} where ${grokBotDispatches.assignmentId} = ${dotRunnerAssignments.id} and ${grokBotDispatches.status} in ('prepared', 'sending', 'accepted', 'unknown'))`,
          sql`not exists (select 1 from ${grokBotDispatches} where ${grokBotDispatches.sourceEventId} = 'operation-result:' || ${dotRunnerOperations.id}::text and ${grokBotDispatches.bindingId} = ${dotRunnerAssignments.bindingId})`,
          eq(dotRunnerOperations.status, "completed"), isNotNull(dotRunnerOperations.pendingReturnedAt), isNull(dotRunnerOperations.observedAt),
          lt(dotRunnerOperations.pendingReturnedAt, new Date(Date.now() - 5_000)))).limit(20);
      const notifiedAssignments = new Set<string>();
      for (const { operation, assignment } of results) {
        if (notifiedAssignments.has(assignment.id)) continue;
        notifiedAssignments.add(assignment.id);
        if (operation.command.action !== "tool") continue;
        try { await service.reserve({ companyId: assignment.companyId, agentId: assignment.agentId, bindingId: assignment.bindingId,
          assignmentId: assignment.id, kind: "mailbox_updated", sourceEventId: `operation-result:${operation.id}` }); } catch { /* Never change a receipt or replay the tool. */ }
      }
      const rows = await db.select({ dispatch: grokBotDispatches, agentId: grokBotRoutines.agentId }).from(grokBotDispatches)
        .innerJoin(grokBotRoutines, and(eq(grokBotRoutines.id, grokBotDispatches.routineId), eq(grokBotRoutines.companyId, grokBotDispatches.companyId)))
        .where(eq(grokBotDispatches.status, "prepared")).orderBy(asc(grokBotDispatches.createdAt)).limit(10);
      for (const { dispatch, agentId } of rows) {
        if (stopped || !isBackgroundWorkEnabled()) break;
        try { await service.send(dispatch.companyId, agentId, dispatch.id); }
        catch {
          // No HTTP effect started while status is still prepared. Rejected
          // authority is not a reason to keep attempting a stale wake.
          await db.update(grokBotDispatches).set({ status: "cancelled", updatedAt: new Date() })
            .where(and(eq(grokBotDispatches.id, dispatch.id), eq(grokBotDispatches.status, "prepared")));
        }
      }
    } finally { running = false; }
  }
  return { tick, start() { stopped = false; timer ??= setInterval(() => { void tick().catch(() => {}); }, 1000); timer.unref(); },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; } };
}
