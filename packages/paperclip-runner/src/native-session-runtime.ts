import { randomUUID } from "node:crypto";

import type { ControlPlanePort } from "./contracts/control-plane-port.js";
import type { NativeExecutionInputV1, NativeSessionExecutionResult } from "./contracts/native-execution.js";
import { buildNativeModelEnvelope, parseNativeExecutionInput } from "./contracts/native-execution.js";
import type { NativeSession, NativeSessionBackend } from "./contracts/native-session-backend.js";
import type { PrpEvent, PrpTerminalState } from "./protocol/replay-contract.js";

export interface ExecuteNativeSessionOptions {
  input: NativeExecutionInputV1;
  backend: NativeSessionBackend;
  controlPlane: ControlPlanePort;
  runnerInstanceId: string;
  controlPlaneInstanceId: string;
  timeoutMs?: number;
  onSession?: (session: NativeSession | null) => void;
}

function isTurnTerminal(event: PrpEvent): boolean {
  return ["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType);
}

function terminalFromEvent(event: PrpEvent, disposition: PrpTerminalState["reportedWorkDisposition"]): PrpTerminalState {
  const states = event.eventType === "turn.completed"
    ? { turnTerminalState: "completed" as const, runTerminalState: "succeeded" as const }
    : event.eventType === "turn.failed"
      ? { turnTerminalState: "failed" as const, runTerminalState: "failed" as const }
      : event.eventType === "turn.interrupted"
        ? { turnTerminalState: "interrupted" as const, runTerminalState: "cancelled" as const }
        : { turnTerminalState: "cancelled" as const, runTerminalState: "cancelled" as const };
  return { schema: "paperclip.prp.terminal.v1", ...states, reportedWorkDisposition: disposition };
}

async function consumeTurn(session: NativeSession, controlPlane: ControlPlanePort, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let eventCount = 0;
        let highestContiguousSourceSeq = 0;
        for await (const event of session.events()) {
          const receipt = await controlPlane.appendEvent(event);
          eventCount += receipt.disposition === "committed" ? 1 : 0;
          highestContiguousSourceSeq = Math.max(highestContiguousSourceSeq, receipt.highestContiguousSourceSeq);
          if (isTurnTerminal(event)) return { event, eventCount, highestContiguousSourceSeq };
        }
        throw new Error("native event stream closed before a turn terminal fact");
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`native session timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Package-owned normalized session loop. Paperclip supplies persistence and
 * authority through ControlPlanePort; provider/session behavior stays here.
 */
export async function executeNativeSession(options: ExecuteNativeSessionOptions): Promise<NativeSessionExecutionResult> {
  const input = parseNativeExecutionInput(options.input);
  const descriptor = await options.backend.descriptor();
  const persistedSession = await options.controlPlane.loadSessionCheckpoint?.() ?? null;
  const normalizedSessionId = persistedSession?.identity.sessionId
    ?? input.session.normalizedSessionId
    ?? randomUUID();
  await options.controlPlane.openRun({
    identity: {
      runId: input.binding.runId,
      sessionId: normalizedSessionId,
      companyId: input.binding.companyId,
      issueId: input.binding.issueId,
      agentId: input.binding.agentId,
    },
    backendKind: descriptor.kind,
    sourceInstanceId: options.runnerInstanceId,
  });

  const identity = {
    runId: input.binding.runId,
    sessionId: normalizedSessionId,
    companyId: input.binding.companyId,
    issueId: input.binding.issueId,
    agentId: input.binding.agentId,
  };
  if (
    persistedSession
    && (
      persistedSession.identity.runId !== identity.runId
      || persistedSession.identity.companyId !== identity.companyId
      || persistedSession.identity.issueId !== identity.issueId
      || persistedSession.identity.agentId !== identity.agentId
      || persistedSession.identity.sessionId !== identity.sessionId
    )
  ) throw new Error("native_session_checkpoint_binding_mismatch");
  let recovered = false;
  let session: NativeSession;
  if (persistedSession) {
    if (!options.backend.recoverSession) {
      throw new Error("native_session_recovery_unavailable: refusing to open a second provider session");
    }
    const recovery = await options.backend.recoverSession(persistedSession);
    if (!recovery.recovered || !recovery.session) {
      throw new Error(`native_session_recovery_failed: ${recovery.reason ?? "unknown"}`);
    }
    session = recovery.session;
    recovered = true;
  } else {
    session = await options.backend.openSession({
      identity,
      workingDirectory: input.workspace.cwd,
    });
  }
  options.onSession?.(session);
  try {
    const checkpoint = async () => {
      if (options.controlPlane.checkpointSession) {
        await options.controlPlane.checkpointSession(await session.snapshot());
      }
    };
    const recoveredSnapshot = await session.snapshot();
    await options.controlPlane.checkpointSession?.(recoveredSnapshot);

    let consumed = { event: null as PrpEvent | null, eventCount: 0, highestContiguousSourceSeq: 0 };
    const completionSnapshot = recoveredSnapshot.semanticResult && recoveredSnapshot.terminal
      ? recoveredSnapshot
      : persistedSession;
    let completed = completionSnapshot?.semanticResult && completionSnapshot.terminal
      ? {
          result: completionSnapshot.semanticResult,
          terminal: completionSnapshot.terminal,
          turnId: completionSnapshot.activeTurnId ?? null,
        }
      : null;
    if (!completed) {
      const consuming = consumeTurn(session, options.controlPlane, options.timeoutMs ?? 900_000);
      const recoveredActiveTurnId = recoveredSnapshot.activeTurnId ?? persistedSession?.activeTurnId ?? null;
      if (!recovered || !recoveredActiveTurnId) {
        await session.startTurn({
          message: { role: "user", text: JSON.stringify(buildNativeModelEnvelope(input)) },
        });
        await checkpoint();
      }
      const terminalEvent = await consuming;
      consumed = terminalEvent;
      completed = await session.result();
      await checkpoint();
    }
    if (completed === null) throw new Error("native_finalization_missing: session returned no semantic result");
    let terminal: PrpTerminalState;
    if (completionSnapshot?.semanticResult && completionSnapshot.terminal) {
      terminal = completionSnapshot.terminal;
    } else {
      terminal = terminalFromEvent(consumed.event!, completed.result.reportedWorkDisposition);
    }
    const eventTurnId = completed.turnId
      ?? persistedSession?.activeTurnId
      ?? persistedSession?.terminalTurns?.at(-1)?.turnId
      ?? consumed.event?.turnId;
    const controlEvent = (
      sourceSeq: number,
      eventType: PrpEvent["eventType"],
      payload: Record<string, unknown>,
    ): PrpEvent => ({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${options.controlPlaneInstanceId}:${input.binding.runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: options.controlPlaneInstanceId,
      sourceKind: "control_plane",
      runId: input.binding.runId,
      normalizedSessionId,
      ...(eventTurnId ? { turnId: eventTurnId } : {}),
      eventType,
      schemaVersion: 1,
      priority: 0,
      emittedAt: new Date().toISOString(),
      payload,
    });
    const expectedControlEvents = [
      controlEvent(1, "run.result.accepted", { result: completed.result }),
      controlEvent(2, "run.terminal", terminal as unknown as Record<string, unknown>),
    ];
    const controlReplay = await options.controlPlane.replayEvents({
      runId: input.binding.runId,
      sourceInstanceId: options.controlPlaneInstanceId,
      afterSourceSeq: 0,
      limit: 10,
    });
    const replayBySequence = new Map(controlReplay.events.map((event) => [event.sourceSeq, event]));
    for (const existing of controlReplay.events) {
      const expected = expectedControlEvents[existing.sourceSeq - 1];
      if (
        expected === undefined
        || existing.eventType !== expected.eventType
        || canonicalJson(existing.payload) !== canonicalJson(expected.payload)
      ) {
        throw new Error(`native_control_event_replay_conflict:${existing.sourceSeq}`);
      }
    }
    consumed.highestContiguousSourceSeq = Math.max(
      consumed.highestContiguousSourceSeq,
      controlReplay.highestContiguousSourceSeq,
    );
    for (const event of expectedControlEvents) {
      if (replayBySequence.has(event.sourceSeq)) continue;
      const receipt = await options.controlPlane.appendEvent(event);
      consumed.eventCount += receipt.disposition === "committed" ? 1 : 0;
      consumed.highestContiguousSourceSeq = Math.max(
        consumed.highestContiguousSourceSeq,
        receipt.highestContiguousSourceSeq,
      );
    }
    await options.controlPlane.completeRun({
      result: completed.result,
      terminal,
      turnId: completed.turnId,
      callerResultId: `${options.runnerInstanceId}:${input.binding.runId}:result`,
      callerDedupeKey: `${input.binding.runId}:${input.completionContract.sha256}`,
    });
    const snapshot = await session.snapshot();
    await options.controlPlane.checkpointSession?.({
      ...snapshot,
      semanticResult: completed.result,
      terminal,
    });
    return {
      result: completed.result,
      terminal,
      turnId: completed.turnId,
      normalizedSessionId,
      providerSessionId: snapshot.providerSessionId ?? null,
      driverKind: descriptor.name,
      driverVersion: descriptor.version,
      nativeEventCount: consumed.eventCount,
      highestContiguousSourceSeq: consumed.highestContiguousSourceSeq,
      usage: null,
    };
  } finally {
    options.onSession?.(null);
    await session.close({ reason: "native session execution complete" });
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
