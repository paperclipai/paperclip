import { createDb, type Db } from "@paperclipai/db";
import { DATABASE_WORK_CHANNEL, enableDatabaseWorkNotifications, publishDatabaseWorkHint,
  receiveDatabaseWorkNotification, reconcileDatabaseWorkNotifications, subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { activeNativeExecutionRunIds, subscribeActiveNativeExecutions } from "./native-runtime/native-active-runs.js";
import { isIdleTaskDrainActive, subscribeTaskDrainChanges } from "./task-admission.js";
import { subscribeAllCompanyLiveEvents } from "./live-events.js";

/** Temporary overlap, not steady-state horizontal scaling. Listen while startup
 * and its 120-second handoff window are active, or while this process owns a
 * native execution. Browser connections alone never keep PostgreSQL awake.
 * Durable queues and their existing claims remain execution authority. */
export function deploymentNotifications(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, input: {
  directDatabaseUrl: string; isWarmStandby?: () => boolean; handoffMs?: number;
}) {
  enableDatabaseWorkNotifications(db);
  let stopped = false, handoffEndsAt: number | null = null;
  let client: ReturnType<typeof createDb>["$client"] | null = null;
  const wanted = () => !stopped && !isIdleTaskDrainActive()
    && (handoffEndsAt === null || handoffEndsAt > Date.now() || activeNativeExecutionRunIds.size > 0);
  async function close() {
    const previous = client; client = null;
    await previous?.end({ timeout: 1 });
  }
  const listener = coordinator.register(DELIVERY_QUEUES.deploymentNotifications, {
    retryMs: 1000, runDuringDrain: true,
    async run(signal) {
      if (!wanted()) { await close(); return; }
      if (client) return;
      const opened = createDb(input.directDatabaseUrl, { maxConnections: 1, connectTimeoutSeconds: 5,
        applicationName: "paperclip-deployment-notifications" }).$client;
      client = opened;
      const abort = () => { void opened.end({ timeout: 0 }); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await opened.listen(DATABASE_WORK_CHANNEL, payload => receiveDatabaseWorkNotification(db, payload),
          () => reconcileDatabaseWorkNotifications(db));
      } catch (error) { if (client === opened) await close(); throw error; }
      finally { signal.removeEventListener("abort", abort); }
      if (!wanted()) await close();
    },
    hasPending: async () => false,
    nextRunAt: () => handoffEndsAt !== null && handoffEndsAt > Date.now() ? handoffEndsAt : null,
  });
  const stopActive = subscribeActiveNativeExecutions(listener.wake);
  const stopDrain = subscribeTaskDrainChanges(listener.wake);

  // Only company identity crosses the hint channel, never event contents or
  // authorization decisions. A receiving tab refreshes through its normal API.
  const companies = new Set<string>();
  let flushAt: number | null = null;
  const publisher = coordinator.register(DELIVERY_QUEUES.liveInvalidations, {
    retryMs: 1000, runDuringDrain: true,
    async run() {
      if (flushAt === null || Date.now() < flushAt) return;
      // Remove before awaiting: a same-company event arriving during the SQL
      // write belongs to the next batch and must not be cleared by this one.
      flushAt = null;
      for (const companyId of [...companies]) {
        companies.delete(companyId);
        try { await publishDatabaseWorkHint(db, `live:${companyId}`); }
        catch (error) {
          companies.add(companyId);
          flushAt ??= Date.now() + 1000;
          throw error;
        }
      }
    },
    hasPending: async () => false,
    nextRunAt: () => flushAt,
  });
  const stopEvents = subscribeAllCompanyLiveEvents(event => {
    if (stopped || !/^[a-f0-9-]{36}$/i.test(event.companyId)) return;
    companies.add(event.companyId);
    flushAt ??= Date.now() + 1000;
    publisher.wake();
  });
  return {
    async ready() {
      await listener.ready;
      // Coordinator startup errors normally retry. A replacement must not
      // advertise readiness until the cross-controller channel is connected.
      if (!client && !input.isWarmStandby?.()) throw new Error("Deployment notification listener did not become ready");
    },
    markReady() {
      handoffEndsAt = Date.now() + (input.handoffMs ?? 120_000);
      listener.wake();
    },
    subscribeCompany(companyId: string, resync: () => void) {
      return subscribeDatabaseWork(db, `live:${companyId}`, event => { if (event === "settled") resync(); });
    },
    async stop() {
      stopped = true;
      stopActive(); stopDrain(); stopEvents();
      await close();
      await Promise.all([listener.stop(), publisher.stop()]);
    },
  };
}
