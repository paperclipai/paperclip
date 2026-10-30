import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { UpstreamReprobeScope } from "../modules/run-dispatch/index.js";

type Coordinator = Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">;
type Reprobe = (scope?: UpstreamReprobeScope) => Promise<unknown>;

function parseScope(hint: string): UpstreamReprobeScope | null {
  try {
    const value: unknown = JSON.parse(hint);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const scope = value as Record<string, unknown>;
    if (typeof scope.companyId !== "string" || !scope.companyId ||
        typeof scope.agentId !== "string" || !scope.agentId ||
        typeof scope.adapterType !== "string" || !scope.adapterType) return null;
    return { companyId: scope.companyId, agentId: scope.agentId, adapterType: scope.adapterType };
  } catch {
    return null;
  }
}

/**
 * Successful cost accounting is the event that makes a green run safe to use
 * as recovery evidence. Failed probes stay in the coordinator's pending work;
 * after a process restart, the durable success and retry pins are scanned once.
 */
export function registerUpstreamRecoveryReprobeWork(coordinator: Coordinator, reprobe: Reprobe) {
  let scanAll = true;
  const scopes = new Set<string>();
  return coordinator.register(DELIVERY_QUEUES.upstreamRecoveryReprobe, {
    retryMs: 5_000,
    onSettled(hints) {
      if (!hints?.size) { scanAll = true; return; }
      for (const hint of hints) {
        if (parseScope(hint)) scopes.add(hint);
        else scanAll = true;
      }
    },
    async run(signal) {
      if (signal.aborted) return;
      if (scanAll) {
        scanAll = false;
        try { await reprobe(); }
        catch (error) { scanAll = true; throw error; }
      }
      // Keep one invocation bounded even if many different scopes completed.
      for (const hint of Array.from(scopes).slice(0, 50)) {
        if (signal.aborted) return;
        scopes.delete(hint);
        try { await reprobe(parseScope(hint)!); }
        catch (error) { scopes.add(hint); throw error; }
      }
    },
    hasPending: async () => scanAll || scopes.size > 0,
  });
}
