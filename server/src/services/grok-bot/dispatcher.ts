import { and, asc, eq } from "drizzle-orm";
import { grokBotDispatches, grokBotRoutines, type Db } from "@paperclipai/db";
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
      // Bot-initiated callers poll their durable request while admission is
      // pending. Delay does not prove that the originating conversation ended.
      // Starting a webhook here would create a competing Grok interaction.
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
