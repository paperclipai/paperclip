import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { setStartupPreservationBlocked } from "../startup-recovery-state.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { readEphemeralServerDataEligibility } from "./ephemeral-server-contract.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";

export async function registerEphemeralPreservationReadiness(db: Db,
  delivery: ReturnType<typeof createDeliveryWorkCoordinator>) {
  let blocked = true;
  let initial = true;
  let changedDuringStartup = false;
  setStartupPreservationBlocked(true);
  const removeProbe = registerIdleLocalWorkProbe(() => blocked ? "present" : "none");
  async function assess() {
    try {
      const report = await readEphemeralServerDataEligibility(db, { purpose: "startup" });
      const scoped = new Set<string>(report.runObligations.map(obligation => obligation.code));
      const global = report.blockers.filter(code => !scoped.has(code));
      if (global.length) throw new Error(`Volume-free server data is not eligible: ${global.join(", ")}`);
      if (report.runObligations.length) logger.warn({ obligations: report.runObligations }, "Native data preservation blocks replacement readiness; control plane remains available");
      blocked = !report.eligible;
      setStartupPreservationBlocked(blocked);
    } catch (error) {
      blocked = true;
      setStartupPreservationBlocked(true);
      throw error;
    }
  }
  const worker = delivery.register(DELIVERY_QUEUES.nativePreservation, {
    retryMs: 30_000,
    coalesceMs: 50,
    runDuringDrain: true,
    async run() { if (!initial) await assess(); },
    onSettled() { if (initial) changedDuringStartup = true; },
    hasPending: async () => false,
    onStop: removeProbe,
  });
  try { await assess(); }
  catch (error) { await worker.stop(); throw error; }
  initial = false;
  if (changedDuringStartup) worker.wake();
  return worker;
}
