import { and, asc, eq, sql } from "drizzle-orm";
import { grokBotDispatches, grokBotRoutines, type Db } from "@paperclipai/db";
import { grokRoutineService } from "./routine.js";
import type { deliverGrokRoutineWake } from "./webhook.js";
import { externalBotEnabled } from "../external-bot-authority.js";
import { registerDeadlineWork } from "../deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";

export function createGrokRoutineDispatcher(db: Db, isBackgroundWorkEnabled: () => boolean = () => true, deliver?: typeof deliverGrokRoutineWake) {
  let running: Promise<void> | null = null;
  let enabled = false;
  const prepared = () => db.select({ dispatch: grokBotDispatches, agentId: grokBotRoutines.agentId }).from(grokBotDispatches)
    .innerJoin(grokBotRoutines, and(eq(grokBotRoutines.id, grokBotDispatches.routineId), eq(grokBotRoutines.companyId, grokBotDispatches.companyId)))
    .where(sql`${grokBotDispatches.status} = 'prepared'`)
    .orderBy(asc(grokBotDispatches.createdAt), asc(grokBotDispatches.id));
  function tick(signal?: AbortSignal): Promise<void> {
    if (running) return running;
    running = (async () => {
      if (!isBackgroundWorkEnabled() || signal?.aborted) return;
      enabled = await externalBotEnabled(db, "grok_bot");
      if (!enabled) return;
      const service = grokRoutineService(db, deliver);
      for (const { dispatch, agentId } of await prepared().limit(10)) {
        if (signal?.aborted || !isBackgroundWorkEnabled()) break;
        try { await service.send(dispatch.companyId, agentId, dispatch.id); }
        catch {
          await db.update(grokBotDispatches).set({ status: "cancelled", updatedAt: new Date() })
            .where(and(eq(grokBotDispatches.id, dispatch.id), eq(grokBotDispatches.status, "prepared")));
        }
      }
    })().finally(() => { running = null; });
    return running;
  }
  return {
    tick,
    start: (coordinator: ReturnType<typeof createDeliveryWorkCoordinator>) => registerDeadlineWork(coordinator, DELIVERY_QUEUES.grokDispatch, {
      run: tick,
      next: async () => enabled && (await prepared().limit(1)).length > 0 ? Date.now() : null,
      canRun: isBackgroundWorkEnabled,
      retryMs: 1000,
    }),
  };
}
