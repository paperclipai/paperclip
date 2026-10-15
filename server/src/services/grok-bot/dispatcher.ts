import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { grokBotDispatches, grokBotRoutines, dotAgentBindings, dotRunnerAssignments, heartbeatRuns, type Db } from "@paperclipai/db";
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
      // An accepted session already has a routine handling it. Quiet MCP
      // traffic does not prove that routine ended. Keep feedback and receipts
      // durable for the Bot to read instead of starting overlapping work.
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
