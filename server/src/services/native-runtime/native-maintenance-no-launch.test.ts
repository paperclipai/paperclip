import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nativeSha256 } from "./canonical.js";
import {
  verifyRetainedMaintenanceNoLaunch,
  type RetainedMaintenanceNoLaunchInput,
  type RetainedMaintenanceSnapshot,
} from "./native-maintenance-no-launch.js";

const producerDigest =
  "sha256:3cb217996132fa0cbbb3fa169dacd4250e3318840ed15f3fa3d2961536f34ce9";
const spawnError =
  "failed to resume Codex provider: failed to start supervised process codex: No such file or directory (os error 2)";
const identity = {
  runnerInstanceId: "runner-1",
  environmentLeaseId: "environment-1",
  runId: "run-1",
  normalizedSessionId: "session-1",
  turnId: "turn-1",
  itemId: "item-1",
};
function event(
  seq: number,
  eventType: string,
  payload: Record<string, unknown>,
) {
  return {
    schema: "paperclip.prp.event.v1",
    schemaVersion: 1,
    sourceInstanceId: identity.runnerInstanceId,
    sourceEventId: `event_${identity.runnerInstanceId}_${String(seq).padStart(16, "0")}`,
    sourceSeq: seq,
    sourceKind: "runner",
    runId: identity.runId,
    normalizedSessionId: identity.normalizedSessionId,
    turnId: identity.turnId,
    itemId: identity.itemId,
    emittedAt: "2026-09-08T12:00:00.000Z",
    eventType,
    priority: 0,
    payload,
  };
}
function wrapped(raw: ReturnType<typeof event>) {
  return {
    sourceSeq: raw.sourceSeq,
    sourceEventId: raw.sourceEventId,
    eventType: raw.eventType,
    priority: raw.priority,
    envelope: {
      protocol: "paperclip.runner",
      version: 1,
      kind: "event",
      ...identity,
      payload: raw,
    },
    deliveryCount: 1,
    logicalEffectCount: 1,
  };
}
function seal(
  input: Omit<RetainedMaintenanceSnapshot, "fingerprint" | "fileSha256">,
) {
  const fileSha256 = [input.control, input.runner, input.provider].map(
    (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  ) as [string, string, string];
  return {
    ...input,
    fileSha256,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(fileSha256))
      .digest("hex"),
  };
}
function fixture(): RetainedMaintenanceNoLaunchInput {
  const oldEvent = event(1, "session.started", {
    processId: 101,
    providerSessionId: "thread-1",
  });
  const retained = event(2, "item.delta", { text: "already accepted answer" });
  const reconciled = event(3, "runner.reconciled", {
    outcome: "same_durable_session_resumed",
  });
  const commands = [
    {
      commandId: "attach",
      controllerSeq: 1,
      type: "run.attach",
      payload: {},
      status: "completed",
      result: { status: "completed" },
    },
    {
      commandId: "stop",
      controllerSeq: 2,
      type: "turn.stop",
      payload: { reason: "close" },
      status: "pending",
    },
    {
      commandId: "suspend",
      controllerSeq: 3,
      type: "runner.suspend",
      payload: {},
      status: "pending",
    },
  ];
  const original = seal({
    control: {
      schema: "paperclip.runner.durable.control-plane-state.v1",
      identity,
      commands,
      committedEvents: [wrapped(oldEvent)],
      ackedSourceSeq: 1,
      runAttachTemplate: { provider: "codex" },
    },
    runner: {
      schema: "paperclip.runner.durable.state.v1",
      ...identity,
      lifecycle: "ready",
      outbox: [wrapped(retained)],
      ackedSourceSeq: 1,
      nextSourceSeq: 3,
      lastControllerCommandSeq: 1,
      compactedThroughControllerSeq: 0,
      pendingTerminalDelivery: null,
      processedCommands: { attach: commands[0]!.result },
      processedCommandFingerprints: { attach: "old-fingerprint" },
    },
    provider: {
      schema: "paperclip.runner.codex-provider-state.v1",
      config: {
        provider: "codex",
        command: "codex",
        cwd: "/private/workspace",
      },
      lifecycle: "turn_active",
      providerProcessGeneration: 7,
      threadId: "thread-1",
      providerSessionId: "account-1",
      activeProviderTurnId: "provider-turn-1",
      pendingEvents: [{ eventType: "item.delta" }],
      queuedEvents: [],
      toolBridge: { pending: {} },
    },
  });
  const failedCommands = commands.map((command) =>
    command.status !== "pending"
      ? structuredClone(command)
      : {
          ...command,
          status: "failed",
          result: {
            commandId: command.commandId,
            commandType: command.type,
            controllerSeq: command.controllerSeq,
            status: "failed",
            result: { code: "command_execution_failed", message: spawnError },
          },
        },
  );
  const requestId = "native-cleanup:request-1";
  const attempted = seal({
    control: {
      ...structuredClone(original.control),
      commands: failedCommands,
      committedEvents: [
        wrapped(oldEvent),
        wrapped(retained),
        wrapped(reconciled),
      ],
      ackedSourceSeq: 3,
      tickets: {
        ticket: {
          identity,
          runnerVersion: "0.3.0",
          runnerDigest: producerDigest,
          usedAt: "2026-09-08T12:00:01.000Z",
          expiresAt: "2026-09-08T12:01:00.000Z",
          expiresAtUnixMs: Date.parse("2026-09-08T12:01:00.000Z"),
        },
      },
      leases: {
        lease: {
          identity,
          expiresAt: "2026-09-08T12:01:00.000Z",
          expiresAtUnixMs: Date.parse("2026-09-08T12:01:00.000Z"),
        },
      },
    },
    runner: {
      ...structuredClone(original.runner),
      lifecycle: "suspended",
      outbox: [],
      ackedSourceSeq: 3,
      nextSourceSeq: 4,
      lastControllerCommandSeq: 3,
      pendingTerminalDelivery: {
        commandId: "suspend",
        controllerSeq: 3,
        commandType: "runner.suspend",
        lifecycle: "suspended",
      },
      processedCommands: Object.fromEntries(
        failedCommands.map((command) => [command.commandId, command.result]),
      ),
      processedCommandFingerprints: {
        attach: "old-fingerprint",
        ...Object.fromEntries(
          commands.slice(-2).map((command) => [
            command.commandId,
            nativeSha256({
              deadlineAt: null,
              precondition: null,
              ...Object.fromEntries(
                Object.entries(command).filter(
                  ([key]) => key !== "status" && key !== "result",
                ),
              ),
            }),
          ]),
        ),
      },
    },
    provider: structuredClone(original.provider),
  });
  Object.assign(original.control, {
    connectionCount: 1,
    freshBootstraps: 1,
    commandDeliveryCounts: { attach: 1 },
  });
  Object.assign(attempted.control, {
    connectionCount: 2,
    freshBootstraps: 2,
    commandDeliveryCounts: { attach: 1, stop: 1, suspend: 1 },
  });
  original.runner.reconnectCount = 0;
  attempted.runner.reconnectCount = 1;
  original.runner.diagnostics = ["retained diagnostic"];
  attempted.runner.diagnostics = [
    "retained diagnostic",
    "runner restored its durable identity after process recovery",
    `turn.stop command failed: ${spawnError}`,
    `runner.suspend command failed: ${spawnError}`,
  ];
  const ticket = (
    attempted.control.tickets as Record<string, Record<string, unknown>>
  ).ticket!;
  Object.assign(ticket, {
    credentialId: "sha256:" + "1".repeat(64),
    recordId: "ticket-record",
    authKeyDigest: "sha256:" + "2".repeat(64),
  });
  attempted.control.tickets = { [String(ticket.credentialId)]: ticket };
  const lease = (
    attempted.control.leases as Record<string, Record<string, unknown>>
  ).lease!;
  Object.assign(lease, {
    credentialId: "sha256:" + "3".repeat(64),
    recordId: "lease-record",
    authKeyDigest: "sha256:" + "4".repeat(64),
    leaseId: "lease-1",
    protocolVersion: 1,
    revocationEpoch: 0,
    revokedAt: null,
  });
  attempted.control.leases = { [String(lease.credentialId)]: lease };
  attempted.control.lastLeaseId = lease.leaseId;
  attempted.control.lastLeaseExpiresAt = lease.expiresAt;
  // Real outbox entries carry source identity in the envelope, while the
  // committed control-plane wrapper duplicates sourceEventId for its index.
  delete (original.runner.outbox as Array<Record<string, unknown>>)[0]!
    .sourceEventId;
  delete (original.runner.outbox as Array<Record<string, unknown>>)[0]!
    .deliveryCount;
  delete (original.runner.outbox as Array<Record<string, unknown>>)[0]!
    .logicalEffectCount;
  (original.runner.outbox as Array<Record<string, unknown>>)[0]!.byteSize = 100;
  Object.assign(original, seal(original));
  Object.assign(attempted, seal(attempted));
  return {
    companyId: "company-1",
    agentId: "agent-1",
    identity,
    requestId,
    original,
    attempted,
    requestHistory: [
      {
        kind: "native_cleanup_maintenance",
        version: 1,
        phase: "started",
        requestId,
        sourceFingerprint: original.fingerprint,
        startedAt: "2026-09-08T12:00:00.000Z",
      },
      {
        kind: "native_cleanup_maintenance",
        version: 1,
        phase: "operator_required",
        requestId,
        code: "native_cleanup_maintenance_unproven",
      },
    ],
    receipts: [retained, reconciled].map((raw) => {
      const receipt = {
        schema: "paperclip.native_cleanup_event.v1",
        requestId,
        rawSourceInstanceId: identity.runnerInstanceId,
        rawSourceEventId: raw.sourceEventId,
        rawSourceSeq: raw.sourceSeq,
        rawEventType: raw.eventType,
        rawCanonicalSha256: nativeSha256(raw),
      };
      return {
        companyId: "company-1",
        agentId: "agent-1",
        runId: identity.runId,
        eventType: "native.cleanup.event",
        sourceInstanceId: `${identity.runnerInstanceId}:cleanup:${requestId}`,
        sourceEventId: `cleanup:${requestId}:${raw.sourceEventId}`,
        sourceSeq: raw.sourceSeq,
        sourcePayloadSha256: nativeSha256(receipt),
        protocolSchemaVersion: 1,
        payload: { nativeCleanupEvent: receipt },
      };
    }),
    now: new Date("2026-09-08T12:02:00.000Z"),
  };
}

describe("retained pre-spawn terminal latch proof", () => {
  it("proves only a new-copy continuation and does not mutate either source", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    expect(verifyRetainedMaintenanceNoLaunch(input)).toEqual({
      kind: "codex_pre_spawn_terminal_latch_v1",
      requestId: input.requestId,
      originalFingerprint: input.original.fingerprint,
      attemptedFingerprint: input.attempted.fingerprint,
    });
    expect(JSON.stringify(input)).toBe(before);
  });
  it("requires the producer's explicit nullable command fingerprint", () => {
    const input = fixture();
    const command = (
      input.original.control.commands as Record<string, unknown>[]
    )[1]!;
    (
      input.attempted.runner.processedCommandFingerprints as Record<
        string,
        unknown
      >
    ).stop = nativeSha256(
      Object.fromEntries(
        Object.entries(command).filter(
          ([key]) => key !== "status" && key !== "result",
        ),
      ),
    );
    Object.assign(input.attempted, seal(input.attempted));
    expect(verifyRetainedMaintenanceNoLaunch(input)).toBeNull();
  });
  it("accepts the producer's capped diagnostic tail and unordered database receipts", () => {
    const input = fixture();
    input.original.runner.diagnostics = Array.from(
      { length: 32 },
      (_, index) => `retained-${index}`,
    );
    input.attempted.runner.diagnostics = [
      ...(input.original.runner.diagnostics as string[]),
      ...(input.attempted.runner.diagnostics as string[]).slice(-3),
    ].slice(-32);
    input.receipts = [...input.receipts].reverse();
    Object.assign(input.original, seal(input.original));
    Object.assign(input.attempted, seal(input.attempted));
    input.requestHistory[0]!.sourceFingerprint = input.original.fingerprint;
    expect(verifyRetainedMaintenanceNoLaunch(input)?.kind).toBe(
      "codex_pre_spawn_terminal_latch_v1",
    );
  });
  it.each([
    [
      "outer event identity",
      (x: RetainedMaintenanceNoLaunchInput) => {
        (
          (
            x.attempted.control.committedEvents as Array<
              Record<string, unknown>
            >
          )[1]!.envelope as Record<string, unknown>
        ).environmentLeaseId = "foreign-environment";
      },
    ],
    [
      "outer event kind",
      (x: RetainedMaintenanceNoLaunchInput) => {
        (
          (
            x.attempted.control.committedEvents as Array<
              Record<string, unknown>
            >
          )[2]!.envelope as Record<string, unknown>
        ).kind = "command";
      },
    ],
    [
      "original wrapper delivery count",
      (x: RetainedMaintenanceNoLaunchInput) => {
        (
          x.attempted.control.committedEvents as Array<Record<string, unknown>>
        )[0]!.deliveryCount = 2;
      },
    ],
    [
      "new logical effects",
      (x: RetainedMaintenanceNoLaunchInput) => {
        (
          x.attempted.control.committedEvents as Array<Record<string, unknown>>
        )[1]!.logicalEffectCount = 2;
      },
    ],
    [
      "arbitrary diagnostic",
      (x: RetainedMaintenanceNoLaunchInput) => {
        (x.attempted.runner.diagnostics as string[]).push(
          "provider actually started",
        );
      },
    ],
    [
      "reordered diagnostics",
      (x: RetainedMaintenanceNoLaunchInput) => {
        (x.attempted.runner.diagnostics as string[]).reverse();
      },
    ],
    [
      "missing diagnostic",
      (x: RetainedMaintenanceNoLaunchInput) => {
        (x.attempted.runner.diagnostics as string[]).pop();
      },
    ],
    [
      "lease pointer",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.attempted.control.lastLeaseId = "foreign-lease";
      },
    ],
    [
      "lease expiry pointer",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.attempted.control.lastLeaseExpiresAt = "2026-09-08T12:00:59.000Z";
      },
    ],
    [
      "lease credential key",
      (x: RetainedMaintenanceNoLaunchInput) => {
        const value = Object.values(x.attempted.control.leases as object)[0];
        x.attempted.control.leases = { wrong: value };
      },
    ],
  ] as const)("denies resealed %s", (_name, mutate) => {
    const input = fixture();
    mutate(input);
    Object.assign(input.original, seal(input.original));
    Object.assign(input.attempted, seal(input.attempted));
    input.requestHistory[0]!.sourceFingerprint = input.original.fingerprint;
    expect(verifyRetainedMaintenanceNoLaunch(input)).toBeNull();
  });
  it.each([
    [
      "unknown producer",
      (x: RetainedMaintenanceNoLaunchInput) => {
        (
          Object.values(x.attempted.control.tickets as object)[0] as Record<
            string,
            unknown
          >
        ).runnerDigest = "sha256:" + "a".repeat(64);
      },
    ],
    [
      "live ticket",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.now = new Date("2026-09-08T12:00:30.000Z");
      },
    ],
    [
      "provider change",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.attempted.provider.providerProcessGeneration = 8;
      },
    ],
    [
      "pending terminal fence missing",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.attempted.runner.pendingTerminalDelivery = null;
      },
    ],
    [
      "missing receipt",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.receipts = x.receipts.slice(1);
      },
    ],
    [
      "duplicate receipt",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.receipts = [...x.receipts, x.receipts[0]!];
      },
    ],
    [
      "altered receipt",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.receipts[0]!.sourcePayloadSha256 = "b".repeat(64);
      },
    ],
    [
      "foreign company",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.receipts[0]!.companyId = "other-company";
      },
    ],
    [
      "later maintenance attempt",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.requestHistory = [
          ...x.requestHistory,
          {
            kind: "native_cleanup_maintenance",
            phase: "started",
            requestId: "later",
          },
        ];
      },
    ],
    [
      "wrong source fingerprint",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.original.fingerprint = "f".repeat(64);
      },
    ],
    [
      "ambiguous spawn error",
      (x: RetainedMaintenanceNoLaunchInput) => {
        const commands = x.attempted.control.commands as Array<
          Record<string, unknown>
        >;
        (
          (commands[1]!.result as Record<string, unknown>).result as Record<
            string,
            unknown
          >
        ).message = "provider startup timed out";
      },
    ],
    [
      "changed original command",
      (x: RetainedMaintenanceNoLaunchInput) => {
        (
          x.attempted.control.commands as Array<Record<string, unknown>>
        )[0]!.payload = { changed: true };
      },
    ],
    [
      "new turn command",
      (x: RetainedMaintenanceNoLaunchInput) => {
        (x.attempted.control.commands as unknown[]).push({
          type: "turn.start",
          status: "pending",
        });
      },
    ],
    [
      "unflushed runner events",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.attempted.runner.outbox = [wrapped(event(4, "item.delta", {}))];
      },
    ],
    [
      "changed identity",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.attempted.runner.runId = "foreign-run";
      },
    ],
    [
      "new executor receipt",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.attempted.runner.executorEventReceipts = { unexpected: "receipt" };
      },
    ],
    [
      "changed runner backpressure",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.attempted.runner.backpressure = { enabled: false };
      },
    ],
    [
      "extra reconnect",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.attempted.runner.reconnectCount = 2;
      },
    ],
    [
      "extra command delivery",
      (x: RetainedMaintenanceNoLaunchInput) => {
        (
          x.attempted.control.commandDeliveryCounts as Record<string, unknown>
        ).stop = 2;
      },
    ],
    [
      "new control authority field",
      (x: RetainedMaintenanceNoLaunchInput) => {
        x.attempted.control.unrecognizedAuthority = { permit: true };
      },
    ],
  ] as const)("denies %s", (_name, mutate) => {
    const input = fixture();
    mutate(input);
    expect(verifyRetainedMaintenanceNoLaunch(input)).toBeNull();
  });
});
