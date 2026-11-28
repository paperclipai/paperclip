import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi, type Mock } from "vitest";
import { DurablePrpControlPlane } from "../../src/control-plane/durable-prp-control-plane.js";
import {
  maintenanceReplaySnapshot,
  type MaintenanceReplaySnapshot,
  type WithheldTerminalFrame,
} from "./runnerd-settlement-assertions.js";

export const RETAINED_STATE_FILES = [
  "control-plane/control-plane-state.json",
  "runner/runner-state.json",
  "runner/codex-provider-state.json",
];

export async function seedRetainedOutboxAndProviderEvents(ctx: {
  original: string;
  copy: string;
  fakeState: string;
  fixtureRunner: string;
  identity: {
    runnerInstanceId: string;
    environmentLeaseId: string;
    runId: string;
    normalizedSessionId: string;
    turnId: string;
    itemId: string;
  };
  alreadyEnded: boolean;
  missingHome?: boolean;
  homeScoped?: boolean;
  completedTerminalAck?: "pending" | "completed" | "repeat";
}) {
  const {
    original,
    copy,
    fakeState,
    fixtureRunner,
    identity,
    alreadyEnded,
    missingHome,
    homeScoped,
    completedTerminalAck,
  } = ctx;
  if (alreadyEnded) {
    const providerState = JSON.parse(await readFile(fakeState, "utf8"));
    await writeFile(
      fakeState,
      JSON.stringify({ ...providerState, activeTurnId: null }),
    );
  }
  const builder = new DurablePrpControlPlane({
    stateDirectory: join(original, "control-plane"),
    identity,
    expectedRunnerVersion: "0.3.0",
    expectedRunnerDigest: `sha256:${createHash("sha256")
      .update(await readFile(fixtureRunner))
      .digest("hex")}`,
  });
  builder.queueCommand("turn.stop", {
    reason: "interrupted original close",
  });
  // The outbound-ACK row must reach its injected loss after retained event
  // commits finish. An already queued suspend starts the real two-second
  // ACK deadline behind that commit queue and can time out without ever
  // sending the frame this row is meant to withhold. Maintenance queues its
  // own suspend after draining; the other rows keep the old pending command.
  if (!missingHome && completedTerminalAck !== "completed") {
    builder.queueCommand("runner.suspend", {});
  }
  // Match the retained production split: runner-owned unacknowledged
  // output plus another full provider-owned prefix behind the old suspend.
  const runnerFile = join(original, "runner/runner-state.json");
  const runnerBefore = JSON.parse(await readFile(runnerFile, "utf8"));
  const template = builder.store.state.committedEvents[0]!.envelope.payload as Record<string, unknown>;
  for (let index = 0; index < 90; index++) {
    const sourceSeq = runnerBefore.nextSourceSeq++;
    const event = {
      ...template,
      sourceEventId: `maintenance-runner-${index}`,
      sourceSeq,
      eventType: "item.delta",
      priority: 2,
      payload: { provider: "codex", delta: `maintenance-runner-${index}` },
    };
    const envelope = {
      protocol: "paperclip.runner",
      version: 1,
      kind: "event",
      ...identity,
      payload: event,
    };
    runnerBefore.outbox.push({
      sourceSeq,
      priority: 2,
      eventType: "item.delta",
      envelope,
      byteSize: Buffer.byteLength(JSON.stringify(envelope)),
    });
  }
  runnerBefore.peakOutboxBytes = Math.max(
    runnerBefore.peakOutboxBytes,
    runnerBefore.outbox.reduce(
      (total: number, event: { byteSize: number }) => total + event.byteSize,
      0,
    ),
  );
  await writeFile(runnerFile, JSON.stringify(runnerBefore));
  const providerFile = join(original, "runner/codex-provider-state.json");
  const providerBefore = JSON.parse(await readFile(providerFile, "utf8"));
  expect(providerBefore.pendingEvents).toEqual([]);
  expect(providerBefore.queuedEvents).toEqual([]);
  for (let index = 0; index < 128; index++) {
    providerBefore.pendingEvents.push({
      executorEventId: `codex_provider_${String(providerBefore.nextProviderEventSeq++).padStart(16, "0")}`,
      eventType: "item.delta",
      priority: "p2",
      payload: {
        provider: "codex",
        delta: `maintenance-provider-${index}`,
      },
    });
  }
  await writeFile(providerFile, JSON.stringify(providerBefore));
  await cp(original, copy, { recursive: true });
  const originalProviderHome = homeScoped ? await readFile(fakeState) : null;
  if (missingHome) await rm(join(copy, "codex-home/fake-codex-state.json"));
  const bytes = await Promise.all(
    RETAINED_STATE_FILES.map((file) => readFile(join(original, file))),
  );
  const sourceFingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        bytes.map((value) => createHash("sha256").update(value).digest("hex")),
      ),
    )
    .digest("hex");
  return {
    providerProcessGeneration: providerBefore.providerProcessGeneration as number,
    originalProviderHome,
    bytes,
    sourceFingerprint,
  };
}

export function attachWithheldTerminalAckSpy(ctx: {
  copy: string;
  files: string[];
  completedTerminalAck: "pending" | "completed" | "repeat";
  replayRetirements: MaintenanceReplaySnapshot[];
  withheldTerminalFrames: WithheldTerminalFrame[];
  recordEpoch: Mock<(receipt: Record<string, unknown>) => Promise<void>>;
  replaySpyRestorers: Array<() => void>;
}) {
  const {
    copy,
    files,
    completedTerminalAck,
    replayRetirements,
    withheldTerminalFrames,
    recordEpoch,
    replaySpyRestorers,
  } = ctx;
  const originalAttach = DurablePrpControlPlane.prototype.attachWireConnection;
  const attachSpy = vi
    .spyOn(DurablePrpControlPlane.prototype, "attachWireConnection")
    .mockImplementation(function (this: DurablePrpControlPlane, wire) {
      const epoch = replayRetirements.length;
      const direction =
        completedTerminalAck === "completed" ? "outbound" : "inbound";
      const inject =
        this.store.path === join(copy, files[0]!) &&
        (epoch === 0 || (completedTerminalAck === "repeat" && epoch === 1));
      let attachment: ReturnType<typeof originalAttach> | undefined;
      let withheld: WithheldTerminalFrame | undefined;
      const shouldWithhold = (candidate: typeof direction): boolean => {
        if (!inject || candidate !== direction || !attachment?.isAuthenticated())
          return false;
        if (withheld) {
          withheld.count += 1;
          return true;
        }
        const runner = JSON.parse(readFileSync(join(copy, files[1]!), "utf8"));
        const terminal = runner.pendingTerminalDelivery;
        if (
          terminal?.commandType !== "runner.suspend" ||
          terminal.lifecycle !== "suspended"
        )
          return false;
        const result = runner.processedCommands[terminal.commandId];
        if (
          result?.status !== "completed" ||
          result.result?.status !== "completed" ||
          result.commandType !== terminal.commandType ||
          result.controllerSeq !== terminal.controllerSeq
        )
          return false;
        const control = JSON.parse(readFileSync(this.store.path, "utf8"));
        const command = control.commands.find(
          (entry: { commandId: string }) => entry.commandId === terminal.commandId,
        );
        if (
          command?.type !== terminal.commandType ||
          command.controllerSeq !== terminal.controllerSeq ||
          command.status !== (direction === "inbound" ? "pending" : "completed")
        )
          return false;
        if (direction === "outbound") expect(command.result).toEqual(result);
        else expect(command.result ?? null).toBeNull();
        // Rust durably records this exact result before sending it.
        // Withhold transport delivery only after that handshake, not
        // after a guessed number of saves or an elapsed sleep. Pending
        // mode loses the result; completed mode loses its outbound ACK.
        // No retained journal/outbox bytes are removed or rewritten.
        withheld = {
          epoch,
          direction,
          commandId: terminal.commandId,
          controllerSeq: terminal.controllerSeq,
          count: 1,
        };
        withheldTerminalFrames.push(withheld);
        return true;
      };
      attachment = originalAttach.call(this, {
        sendJson(value) {
          if (!shouldWithhold("outbound")) wire.sendJson(value);
        },
        close: (code) => wire.close(code),
        onJson: (listener) =>
          wire.onJson((value) => {
            if (!shouldWithhold("inbound")) listener(value);
          }),
        onClose: (listener) => wire.onClose(listener),
      });
      return attachment;
    });
  replaySpyRestorers.push(() => attachSpy.mockRestore());
  recordEpoch.mockImplementation(async (receipt) => {
    if (receipt.phase !== "retired") return;
    const snapshot = maintenanceReplaySnapshot(copy);
    expect(snapshot.fingerprint).toBe(receipt.finalFingerprint);
    replayRetirements.push(snapshot);
  });
}
