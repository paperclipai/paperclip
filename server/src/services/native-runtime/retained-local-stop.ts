import { validatePrpEvent } from "../../vendor/paperclip-runner/index.js";
import type {
  RetainedMaintenanceIdentity,
  RetainedMaintenanceSnapshot,
} from "./native-maintenance-no-launch.js";

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid");
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || value.length > 100_000)
    throw new Error("invalid");
  return value;
};
function requireProof(value: unknown): asserts value {
  if (!value) throw new Error("unproven");
}
const identityKeys = [
  "runnerInstanceId",
  "environmentLeaseId",
  "runId",
  "normalizedSessionId",
  "turnId",
  "itemId",
] as const;

/** Inventory only. The caller must separately verify local host ownership,
 * terminal coordinator/runner exit, absent processes, and unchanged files.
 * Missing launch records never count as evidence that a process stopped.
 */
export function retainedLocalProviderProcesses(input: {
  snapshot: RetainedMaintenanceSnapshot;
  identity: RetainedMaintenanceIdentity;
  now: Date;
}): number[] | null {
  try {
    const { control, runner, provider } = input.snapshot;
    const { identity } = input;
    const now = input.now.getTime();
    requireProof(Number.isFinite(now));
    requireProof(
      control.schema === "paperclip.runner.durable.control-plane-state.v1",
    );
    requireProof(runner.schema === "paperclip.runner.durable.state.v1");
    requireProof(
      provider.schema === "paperclip.runner.codex-provider-state.v1",
    );
    for (const key of identityKeys) {
      requireProof(
        typeof identity[key] === "string" && identity[key].length > 0,
      );
      requireProof(
        record(control.identity)[key] === identity[key] &&
          runner[key] === identity[key],
      );
    }
    requireProof(
      runner.lifecycle === "suspended" &&
        runner.pendingTerminalDelivery === null,
    );
    requireProof(
      runner.pendingProviderCleanup == null &&
        array(runner.outbox).length === 0,
    );
    requireProof(
      provider.lifecycle === "prepared" && provider.startupAttempt === null,
    );
    requireProof(
      array(provider.pendingEvents).length === 0 &&
        array(provider.queuedEvents).length === 0,
    );
    requireProof(
      Object.keys(record(record(provider.toolBridge).pending)).length === 0,
    );
    requireProof(
      provider.activeProviderTurnId === null &&
        provider.ambiguousTurnStartPending === false,
    );
    // An old controller or a still-valid reconnect credential must not revive
    // this authority after the process inventory has been checked.
    for (const name of ["tickets", "leases"]) {
      const credentials = Object.values(record(control[name]));
      requireProof(credentials.length > 0 && credentials.length <= 4096);
      for (const raw of credentials) {
        const expiry = Date.parse(String(record(raw).expiresAt));
        requireProof(Number.isFinite(expiry) && expiry <= now);
      }
    }
    for (const raw of array(control.commands)) {
      const command = record(raw);
      requireProof(
        ["completed", "failed", "pending"].includes(String(command.status)),
      );
      if (command.status === "pending") {
        requireProof(
          ["session.snapshot", "runner.suspend"].includes(String(command.type)),
        );
        requireProof(
          Number(command.controllerSeq) >
            Number(runner.lastControllerCommandSeq),
        );
      }
    }
    const events = array(control.committedEvents);
    requireProof(events.length > 0 && control.ackedSourceSeq === events.length);
    requireProof(
      runner.ackedSourceSeq === events.length &&
        runner.nextSourceSeq === events.length + 1,
    );
    const launches = new Map<
      string,
      { generation: number; pid: number | null }
    >();
    let lastGeneration = 0;
    for (const [index, raw] of events.entries()) {
      const wrapper = record(raw);
      const envelope = record(wrapper.envelope);
      const event = record(envelope.payload);
      requireProof(validatePrpEvent(event).ok);
      for (const key of identityKeys)
        requireProof(envelope[key] === identity[key]);
      requireProof(
        event.runId === identity.runId &&
          event.normalizedSessionId === identity.normalizedSessionId,
      );
      requireProof(
        event.sourceKind === "runner" &&
          event.sourceInstanceId === identity.runnerInstanceId,
      );
      requireProof(
        event.turnId === identity.turnId && event.itemId === identity.itemId,
      );
      requireProof(
        event.sourceSeq === index + 1 && wrapper.sourceSeq === event.sourceSeq,
      );
      const startupValue = record(event.payload).startup;
      if (startupValue === undefined) continue;
      const startup = record(startupValue);
      requireProof(
        event.eventType === "harness.diagnostic" &&
          startup.schema === "paperclip.provider_startup.v1",
      );
      for (const key of identityKeys.filter(
        (key) => key !== "environmentLeaseId",
      )) {
        requireProof(record(startup.origin)[key] === identity[key]);
      }
      const launchId = startup.launchId;
      const generation = startup.attemptedProcessGeneration;
      requireProof(typeof launchId === "string" && launchId.length > 0);
      requireProof(Number.isSafeInteger(generation) && Number(generation) > 0);
      if (startup.phase === "intent") {
        requireProof(
          !launches.has(launchId) && Number(generation) > lastGeneration,
        );
        requireProof(
          startup.processId === null && startup.processGroupId === null,
        );
        launches.set(launchId, { generation: Number(generation), pid: null });
        lastGeneration = Number(generation);
      } else {
        requireProof(startup.phase === "spawned");
        const launch = launches.get(launchId);
        requireProof(
          launch && launch.generation === generation && launch.pid === null,
        );
        requireProof(
          Number.isSafeInteger(startup.processId) &&
            Number(startup.processId) > 0,
        );
        requireProof(startup.processGroupId === startup.processId);
        launch.pid = Number(startup.processId);
      }
    }
    requireProof(
      launches.size > 0 &&
        provider.providerProcessGeneration === lastGeneration,
    );
    const processes = [...launches.values()].map((launch) => launch.pid);
    requireProof(processes.every((pid): pid is number => pid !== null));
    return [...new Set(processes)];
  } catch {
    return null;
  }
}
