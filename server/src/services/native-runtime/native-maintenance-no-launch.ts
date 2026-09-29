import { createHash } from "node:crypto";
import { validatePrpEvent } from "../../vendor/paperclip-runner/index.js";
import { canonicalNativeJson, nativeSha256 } from "./canonical.js";

export interface RetainedMaintenanceSnapshot {
  control: Record<string, unknown>;
  runner: Record<string, unknown>;
  provider: Record<string, unknown>;
  fingerprint: string;
  fileSha256: readonly [string, string, string];
}

export interface RetainedMaintenanceIdentity {
  runnerInstanceId: string;
  environmentLeaseId: string;
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  itemId: string;
}

export interface RetainedMaintenanceEventReceipt {
  companyId: string;
  agentId: string;
  runId: string;
  eventType: string;
  sourceInstanceId: string | null;
  sourceEventId: string | null;
  sourceSeq: number | null;
  sourcePayloadSha256: string | null;
  protocolSchemaVersion: number | null;
  payload: Record<string, unknown> | null;
}

export interface RetainedMaintenanceNoLaunchInput {
  companyId: string;
  agentId: string;
  identity: RetainedMaintenanceIdentity;
  original: RetainedMaintenanceSnapshot;
  attempted: RetainedMaintenanceSnapshot;
  requestId: string;
  requestHistory: readonly Record<string, unknown>[];
  receipts: readonly RetainedMaintenanceEventReceipt[];
  now: Date;
}

export interface RetainedMaintenanceNoLaunchProof {
  kind: "codex_pre_spawn_terminal_latch_v1";
  requestId: string;
  originalFingerprint: string;
  attemptedFingerprint: string;
}

// Closed legacy compatibility authority, not a version/digest supplied by an
// endpoint, caller or retained ticket. This reviewed producer latches the first
// restore error before constructing any supervised child, reuses that latch for
// the failed terminal suspend, and cannot return to command dispatch afterward.
// New artifacts must not be added automatically: new maintenance uses durable
// per-epoch ownership receipts instead of this legacy migration proof.
const REVIEWED_PRODUCER = {
  version: "0.3.0",
  digest:
    "sha256:3cb217996132fa0cbbb3fa169dacd4250e3318840ed15f3fa3d2961536f34ce9",
};
const PRE_SPAWN_FAILURE =
  "failed to resume Codex provider: failed to start supervised process codex: No such file or directory (os error 2)";
const KEYS = [
  "runnerInstanceId",
  "environmentLeaseId",
  "runId",
  "normalizedSessionId",
  "turnId",
  "itemId",
] as const;
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
const same = (a: unknown, b: unknown) =>
  canonicalNativeJson(a) === canonicalNativeJson(b);
function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error("invalid");
}
function commandIdentity(command: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(command).filter(
      ([key]) => key !== "status" && key !== "result",
    ),
  );
}
function unchangedExcept(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  allowed: string[],
) {
  const rest = (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value).filter(([key]) => !allowed.includes(key)),
    );
  requireProof(same(rest(before), rest(after)));
}

/** Pure proof of an exact pre-child failure, NOT proof that its runner exited.
 * A caller may only snapshot a NEW private directory: never reuse, move or
 * activate the attempted directory. The caller must separately prove its
 * source inventory, accepted run, exclusive current scope/DB lease and closed
 * old controller, recheck both fingerprints, and record new epoch ownership.
 * No path, process, clock, database, provider or filesystem operation occurs here.
 */
export function verifyRetainedMaintenanceNoLaunch(
  input: RetainedMaintenanceNoLaunchInput,
): RetainedMaintenanceNoLaunchProof | null {
  try {
    const { original, attempted, identity, requestId } = input;
    const now = input.now.getTime();
    requireProof(
      Number.isFinite(now) &&
        requestId.startsWith("native-cleanup:") &&
        requestId.length > 15,
    );
    for (const key of KEYS)
      requireProof(
        typeof identity[key] === "string" && identity[key].length > 0,
      );
    for (const snapshot of [original, attempted]) {
      requireProof(
        snapshot.fileSha256.length === 3 &&
          snapshot.fileSha256.every((hash) => /^[a-f0-9]{64}$/.test(hash)),
      );
      requireProof(
        snapshot.fingerprint ===
          createHash("sha256")
            .update(JSON.stringify(snapshot.fileSha256))
            .digest("hex"),
      );
      requireProof(
        snapshot.control.schema ===
          "paperclip.runner.durable.control-plane-state.v1",
      );
      requireProof(
        snapshot.runner.schema === "paperclip.runner.durable.state.v1",
      );
      requireProof(
        snapshot.provider.schema === "paperclip.runner.codex-provider-state.v1",
      );
      requireProof(same(snapshot.control.identity, identity));
      for (const key of KEYS)
        requireProof(snapshot.runner[key] === identity[key]);
    }
    requireProof(original.fingerprint !== attempted.fingerprint);
    unchangedExcept(original.control, attempted.control, [
      "tickets",
      "leases",
      "commands",
      "committedEvents",
      "ackedSourceSeq",
      "connectionCount",
      "commandDeliveryCounts",
      "freshBootstraps",
      "lastLeaseId",
      "lastLeaseExpiresAt",
    ]);
    unchangedExcept(original.runner, attempted.runner, [
      "lifecycle",
      "nextSourceSeq",
      "ackedSourceSeq",
      "lastControllerCommandSeq",
      "reconnectCount",
      "outbox",
      "processedCommands",
      "processedCommandFingerprints",
      "pendingTerminalDelivery",
      "diagnostics",
    ]);
    for (const key of ["connectionCount", "freshBootstraps"] as const)
      requireProof(
        Number.isSafeInteger(original.control[key]) &&
          attempted.control[key] === Number(original.control[key]) + 1,
      );
    requireProof(
      Number.isSafeInteger(original.runner.reconnectCount) &&
        attempted.runner.reconnectCount ===
          Number(original.runner.reconnectCount) + 1,
    );
    const diagnostics = array(original.runner.diagnostics);
    requireProof(
      diagnostics.length <= 32 &&
        diagnostics.every((value) => typeof value === "string"),
    );
    requireProof(
      same(
        attempted.runner.diagnostics,
        [
          ...diagnostics,
          "runner restored its durable identity after process recovery",
          `turn.stop command failed: ${PRE_SPAWN_FAILURE}`,
          `runner.suspend command failed: ${PRE_SPAWN_FAILURE}`,
        ].slice(-32),
      ),
    );
    requireProof(
      original.fileSha256[2] === attempted.fileSha256[2] &&
        same(original.provider, attempted.provider),
    );
    requireProof(
      record(original.provider.config).provider === "codex" &&
        record(original.provider.config).command === "codex",
    );
    requireProof(
      original.provider.lifecycle === "turn_active" &&
        Number.isSafeInteger(original.provider.providerProcessGeneration),
    );
    requireProof(
      typeof original.provider.threadId === "string" &&
        original.provider.threadId.length > 0,
    );
    requireProof(
      Object.keys(record(record(original.provider.toolBridge).pending))
        .length === 0,
    );
    requireProof(original.provider.ambiguousTurnStartPending !== true);
    for (const event of [
      ...array(original.provider.pendingEvents),
      ...array(original.provider.queuedEvents),
    ]) {
      requireProof(
        ![
          "semantic_tool.input",
          "mcp_app.tool_input",
          "runtime.input.requested",
          "runtime_request.created",
          "session.started",
          "session.resumed",
        ].includes(String(record(event).eventType)),
      );
    }

    const history = input.requestHistory.filter(
      (entry) => entry.kind === "native_cleanup_maintenance",
    );
    requireProof(
      history.length === 2 &&
        history.every(
          (entry) => entry.version === 1 && entry.requestId === requestId,
        ),
    );
    requireProof(
      history[0]!.phase === "started" &&
        history[0]!.sourceFingerprint === original.fingerprint,
    );
    requireProof(
      history[1]!.phase === "operator_required" &&
        history[1]!.code === "native_cleanup_maintenance_unproven",
    );
    const startedAt = Date.parse(String(history[0]!.startedAt));
    requireProof(Number.isFinite(startedAt) && startedAt < now);
    const credentials = (value: unknown) =>
      Object.entries(record(value)).map(([key, raw]) => {
        const credential = record(raw);
        requireProof(
          key === credential.credentialId && /^sha256:[a-f0-9]{64}$/.test(key),
        );
        requireProof(
          typeof credential.recordId === "string" &&
            credential.recordId.length > 0,
        );
        requireProof(
          typeof credential.authKeyDigest === "string" &&
            /^sha256:[a-f0-9]{64}$/.test(credential.authKeyDigest),
        );
        return credential;
      });
    const tickets = credentials(attempted.control.tickets);
    requireProof(tickets.length === 1);
    const ticket = tickets[0]!;
    requireProof(
      ticket.runnerVersion === REVIEWED_PRODUCER.version &&
        ticket.runnerDigest === REVIEWED_PRODUCER.digest &&
        same(ticket.identity, identity),
    );
    const usedAt = Date.parse(String(ticket.usedAt));
    const expiresAt = Date.parse(String(ticket.expiresAt));
    requireProof(
      Number.isFinite(usedAt) &&
        usedAt >= startedAt &&
        usedAt < expiresAt &&
        expiresAt <= now &&
        ticket.expiresAtUnixMs === expiresAt,
    );
    const leases = credentials(attempted.control.leases);
    requireProof(leases.length === 1);
    for (const lease of leases) {
      const expires = Date.parse(String(lease.expiresAt));
      requireProof(
        same(lease.identity, identity) &&
          Number.isFinite(expires) &&
          usedAt < expires &&
          expires <= now &&
          lease.expiresAtUnixMs === expires,
      );
      requireProof(
        lease.protocolVersion === 1 &&
          lease.revocationEpoch === 0 &&
          lease.revokedAt === null,
      );
      requireProof(
        typeof lease.leaseId === "string" &&
          lease.leaseId.length > 0 &&
          attempted.control.lastLeaseId === lease.leaseId &&
          attempted.control.lastLeaseExpiresAt === lease.expiresAt,
      );
    }

    const beforeCommands = array(original.control.commands).map(record);
    const afterCommands = array(attempted.control.commands).map(record);
    const pending = beforeCommands.filter(
      (command) => command.status === "pending",
    );
    requireProof(
      pending.length === 2 &&
        pending[0]!.type === "turn.stop" &&
        pending[1]!.type === "runner.suspend",
    );
    requireProof(
      beforeCommands.length === afterCommands.length &&
        beforeCommands.length >= 2,
    );
    requireProof(same(pending, beforeCommands.slice(-2)));
    const firstSeq = pending[0]!.controllerSeq;
    requireProof(
      Number.isSafeInteger(firstSeq) &&
        Number(firstSeq) > 0 &&
        pending[1]!.controllerSeq === Number(firstSeq) + 1,
    );
    requireProof(
      original.runner.lastControllerCommandSeq === Number(firstSeq) - 1 &&
        attempted.runner.lastControllerCommandSeq === Number(firstSeq) + 1,
    );
    const processedBefore = record(original.runner.processedCommands);
    const processedAfter = record(attempted.runner.processedCommands);
    const fingerprintsBefore = record(
      original.runner.processedCommandFingerprints,
    );
    const fingerprintsAfter = record(
      attempted.runner.processedCommandFingerprints,
    );
    const expectedProcessed = { ...processedBefore };
    const expectedFingerprints = { ...fingerprintsBefore };
    const expectedDeliveries = {
      ...record(original.control.commandDeliveryCounts),
    };
    for (let index = 0; index < beforeCommands.length; index++) {
      const before = beforeCommands[index]!;
      const after = afterCommands[index]!;
      requireProof(same(commandIdentity(before), commandIdentity(after)));
      if (before.status !== "pending") {
        requireProof(same(before, after));
        continue;
      }
      requireProof(
        typeof before.commandId === "string" &&
          !(before.commandId in processedBefore),
      );
      const result = {
        commandId: before.commandId,
        commandType: before.type,
        controllerSeq: before.controllerSeq,
        status: "failed",
        result: {
          code: "command_execution_failed",
          message: PRE_SPAWN_FAILURE,
        },
      };
      requireProof(after.status === "failed" && same(after.result, result));
      expectedProcessed[before.commandId] = result;
      // Rust's serde Command materializes absent Option fields as null before
      // hashing. The control-plane journal may omit these optional fields.
      expectedFingerprints[before.commandId] = nativeSha256({
        deadlineAt: null,
        precondition: null,
        ...commandIdentity(before),
      });
      const priorCount = expectedDeliveries[before.commandId] ?? 0;
      requireProof(Number.isSafeInteger(priorCount) && Number(priorCount) >= 0);
      expectedDeliveries[before.commandId] = Number(priorCount) + 1;
    }
    requireProof(
      same(processedAfter, expectedProcessed) &&
        same(fingerprintsAfter, expectedFingerprints),
    );
    requireProof(
      same(attempted.control.commandDeliveryCounts, expectedDeliveries),
    );
    requireProof(
      original.runner.pendingTerminalDelivery === null &&
        original.runner.lifecycle === "ready",
    );
    requireProof(
      attempted.runner.lifecycle === "suspended" &&
        array(attempted.runner.outbox).length === 0,
    );
    requireProof(attempted.runner.pendingProviderCleanup == null);
    requireProof(
      same(attempted.runner.pendingTerminalDelivery, {
        commandId: pending[1]!.commandId,
        commandType: "runner.suspend",
        controllerSeq: pending[1]!.controllerSeq,
        lifecycle: "suspended",
      }),
    );
    requireProof(
      original.runner.compactedThroughControllerSeq ===
        attempted.runner.compactedThroughControllerSeq,
    );
    requireProof(
      same(
        original.control.runAttachTemplate,
        attempted.control.runAttachTemplate,
      ),
    );

    const rawEvent = (value: unknown, committed: boolean) => {
      const wrapper = record(value);
      const envelope = record(wrapper.envelope);
      const raw = record(envelope.payload);
      requireProof(
        same(envelope, {
          protocol: "paperclip.runner",
          version: 1,
          kind: "event",
          ...identity,
          payload: raw,
        }),
      );
      const validation = validatePrpEvent(raw);
      requireProof(validation.ok);
      requireProof(
        raw.runId === identity.runId &&
          raw.normalizedSessionId === identity.normalizedSessionId &&
          raw.sourceInstanceId === identity.runnerInstanceId &&
          raw.sourceKind === "runner" &&
          raw.turnId === identity.turnId &&
          raw.itemId === identity.itemId,
      );
      requireProof(
        wrapper.sourceSeq === raw.sourceSeq &&
          wrapper.eventType === raw.eventType &&
          wrapper.priority === raw.priority,
      );
      if (committed)
        requireProof(
          wrapper.sourceEventId === raw.sourceEventId &&
            wrapper.deliveryCount === 1 &&
            wrapper.logicalEffectCount === 1,
        );
      return raw;
    };
    const beforeEvents = array(original.control.committedEvents).map((value) =>
      rawEvent(value, true),
    );
    const retainedEvents = array(original.runner.outbox).map((value) =>
      rawEvent(value, false),
    );
    const afterEvents = array(attempted.control.committedEvents).map((value) =>
      rawEvent(value, true),
    );
    requireProof(beforeEvents.length > 0 && retainedEvents.length > 0);
    requireProof(
      beforeEvents.at(-1)!.sourceSeq === original.runner.ackedSourceSeq &&
        original.control.ackedSourceSeq === original.runner.ackedSourceSeq,
    );
    const prefix = [...beforeEvents, ...retainedEvents];
    requireProof(
      afterEvents.length === prefix.length + 1 &&
        same(afterEvents.slice(0, -1), prefix),
    );
    const afterWrappers = array(attempted.control.committedEvents).map(record);
    requireProof(
      same(
        afterWrappers.slice(0, beforeEvents.length),
        original.control.committedEvents,
      ),
    );
    for (const [index, value] of array(original.runner.outbox).entries()) {
      const retained = record(value);
      const committed = afterWrappers[beforeEvents.length + index]!;
      requireProof(
        same(committed, {
          sourceSeq: retained.sourceSeq,
          sourceEventId: retainedEvents[index]!.sourceEventId,
          eventType: retained.eventType,
          priority: retained.priority,
          envelope: retained.envelope,
          deliveryCount: 1,
          logicalEffectCount: 1,
        }),
      );
    }
    requireProof(
      prefix.at(-1)!.sourceSeq === Number(original.runner.nextSourceSeq) - 1,
    );
    const reconciled = afterEvents.at(-1)!;
    requireProof(
      reconciled.eventType === "runner.reconciled" &&
        same(reconciled.payload, { outcome: "same_durable_session_resumed" }),
    );
    requireProof(reconciled.sourceSeq === original.runner.nextSourceSeq);
    requireProof(
      reconciled.sourceEventId ===
        `event_${identity.runnerInstanceId}_${String(reconciled.sourceSeq).padStart(16, "0")}`,
    );
    requireProof(
      attempted.runner.ackedSourceSeq === reconciled.sourceSeq &&
        attempted.control.ackedSourceSeq === reconciled.sourceSeq &&
        attempted.runner.nextSourceSeq === Number(reconciled.sourceSeq) + 1,
    );
    for (let index = 1; index < afterEvents.length; index++)
      requireProof(
        afterEvents[index]!.sourceSeq ===
          Number(afterEvents[index - 1]!.sourceSeq) + 1,
      );
    const delivered = [...retainedEvents, reconciled];
    requireProof(input.receipts.length === delivered.length);
    const bySequence = new Map(
      input.receipts.map((receipt) => [receipt.sourceSeq, receipt]),
    );
    requireProof(bySequence.size === input.receipts.length);
    for (const raw of delivered) {
      requireProof(
        ![
          "semantic_tool.input",
          "mcp_app.tool_input",
          "runtime.input.requested",
          "runtime_request.created",
          "session.started",
          "session.resumed",
          "harness.ready",
        ].includes(String(raw.eventType)),
      );
      const row = bySequence.get(Number(raw.sourceSeq));
      requireProof(
        row &&
          row.companyId === input.companyId &&
          row.agentId === input.agentId &&
          row.runId === identity.runId &&
          row.eventType === "native.cleanup.event" &&
          row.protocolSchemaVersion === 1,
      );
      const receipt = {
        schema: "paperclip.native_cleanup_event.v1",
        requestId,
        rawSourceInstanceId: identity.runnerInstanceId,
        rawSourceEventId: raw.sourceEventId,
        rawSourceSeq: raw.sourceSeq,
        rawEventType: raw.eventType,
        rawCanonicalSha256: nativeSha256(raw),
      };
      requireProof(
        row!.sourceInstanceId ===
          `${identity.runnerInstanceId}:cleanup:${requestId}` &&
          row!.sourceEventId === `cleanup:${requestId}:${raw.sourceEventId}` &&
          row!.sourcePayloadSha256 === nativeSha256(receipt) &&
          same(row!.payload, { nativeCleanupEvent: receipt }),
      );
    }
    return {
      kind: "codex_pre_spawn_terminal_latch_v1",
      requestId,
      originalFingerprint: original.fingerprint,
      attemptedFingerprint: attempted.fingerprint,
    };
  } catch {
    return null;
  }
}
