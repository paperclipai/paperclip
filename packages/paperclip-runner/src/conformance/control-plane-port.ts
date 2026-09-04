import type {
  CompleteControlPlaneRunInput,
  ControlPlanePort,
  OpenControlPlaneRunInput,
} from "../contracts/control-plane-port.js";
import type { PrpEvent, PrpStructuredRunResult, PrpTerminalState } from "../protocol/replay-contract.js";

export interface ControlPlanePortConformanceSnapshot {
  eventCount: number;
  highestContiguousSourceSeq: number;
  duplicateDisposition: "duplicate";
  terminalReplayIdempotent: boolean;
  openBindingRejected: boolean;
  eventIdMutationRejected: boolean;
  eventSequenceMutationRejected: boolean;
  replayBindingRejected: boolean;
  resultMutationRejected: boolean;
}

export interface ControlPlanePortConformanceHarness {
  port: ControlPlanePort;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export const CONTROL_PLANE_CONFORMANCE_OPEN: OpenControlPlaneRunInput = {
  identity: {
    runId: "00000000-0000-4000-8000-000000000006",
    sessionId: "00000000-0000-4000-8000-000000000007",
    companyId: "00000000-0000-4000-8000-000000000001",
    issueId: "00000000-0000-4000-8000-000000000003",
    agentId: "00000000-0000-4000-8000-000000000002",
  },
  backendKind: "mock",
  sourceInstanceId: "00000000-0000-4000-8000-000000000005",
};

export const CONTROL_PLANE_CONFORMANCE_RESULT: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Standalone conformance task completed.",
  completionClaim: {
    contractRevision: "standalone-v1",
    objectiveSatisfied: true,
    criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: ["event:2"] }],
    remainingWork: [],
  },
  evidence: [{ kind: "event", ref: "event:2" }],
  verification: [{ commandOrCheck: "standalone-conformance", status: "passed", artifactRef: "event:2" }],
  attentionRequests: [],
  artifacts: [],
};

export const CONTROL_PLANE_CONFORMANCE_TERMINAL: PrpTerminalState = {
  schema: "paperclip.prp.terminal.v1",
  turnTerminalState: "completed",
  runTerminalState: "succeeded",
  reportedWorkDisposition: "done",
};

function event(sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `00000000-0000-4000-8000-000000000005:event:${sourceSeq}`,
    sourceSeq,
    sourceInstanceId: "00000000-0000-4000-8000-000000000005",
    sourceKind: "runner",
    runId: CONTROL_PLANE_CONFORMANCE_OPEN.identity.runId,
    normalizedSessionId: CONTROL_PLANE_CONFORMANCE_OPEN.identity.sessionId,
    turnId: "turn-standalone-conformance",
    eventType,
    schemaVersion: 1,
    priority: eventType === "run.terminal" ? 0 : 1,
    emittedAt: `2026-08-09T00:00:0${sourceSeq}.000Z`,
    payload,
  };
}

export const CONTROL_PLANE_CONFORMANCE_EVENTS = [
  event(1, "session.started", { backend: "mock" }),
  event(2, "run.result.proposed", CONTROL_PLANE_CONFORMANCE_RESULT),
  event(3, "run.terminal", CONTROL_PLANE_CONFORMANCE_TERMINAL as unknown as Record<string, unknown>),
] as const;

export async function runControlPlanePortConformance(
  harness: ControlPlanePortConformanceHarness,
): Promise<ControlPlanePortConformanceSnapshot> {
  await harness.start?.();
  try {
    await harness.port.openRun(CONTROL_PLANE_CONFORMANCE_OPEN);
    let openBindingRejected = false;
    try {
      await harness.port.openRun({
        ...CONTROL_PLANE_CONFORMANCE_OPEN,
        identity: { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, issueId: "forged-issue" },
      });
    } catch {
      openBindingRejected = true;
    }
    if (!openBindingRejected) throw new Error("mismatched run binding was accepted");
    const first = await harness.port.appendEvent(CONTROL_PLANE_CONFORMANCE_EVENTS[0]);
    if (first.disposition !== "committed" || first.highestContiguousSourceSeq !== 1) {
      throw new Error("first event did not commit at cursor 1");
    }
    const gap = await harness.port.appendEvent(CONTROL_PLANE_CONFORMANCE_EVENTS[2]);
    if (gap.highestContiguousSourceSeq !== 1) throw new Error("source gap was hidden");
    const recovered = await harness.port.appendEvent(CONTROL_PLANE_CONFORMANCE_EVENTS[1]);
    if (recovered.highestContiguousSourceSeq !== 3) throw new Error("source gap did not recover");
    const duplicate = await harness.port.appendEvent(CONTROL_PLANE_CONFORMANCE_EVENTS[1]);
    if (duplicate.disposition !== "duplicate") throw new Error("identical duplicate was not idempotent");
    let eventIdMutationRejected = false;
    try {
      await harness.port.appendEvent({
        ...CONTROL_PLANE_CONFORMANCE_EVENTS[1],
        payload: { mutated: true },
      });
    } catch {
      eventIdMutationRejected = true;
    }
    if (!eventIdMutationRejected) throw new Error("mutated event id replay was accepted");
    let eventSequenceMutationRejected = false;
    try {
      await harness.port.appendEvent({
        ...CONTROL_PLANE_CONFORMANCE_EVENTS[1],
        sourceEventId: "00000000-0000-4000-8000-000000000005:mutated-sequence-two",
        payload: { mutated: true },
      });
    } catch {
      eventSequenceMutationRejected = true;
    }
    if (!eventSequenceMutationRejected) throw new Error("mutated source sequence replay was accepted");

    const replay = await harness.port.replayEvents({
      runId: CONTROL_PLANE_CONFORMANCE_OPEN.identity.runId,
      sourceInstanceId: "00000000-0000-4000-8000-000000000005",
      afterSourceSeq: 1,
      limit: 10,
    });
    if (replay.events.map((entry) => entry.sourceSeq).join(",") !== "2,3") {
      throw new Error("exclusive replay cursor returned the wrong event set");
    }
    let replayBindingRejected = false;
    try {
      await harness.port.replayEvents({
        runId: "forged-run",
        sourceInstanceId: "00000000-0000-4000-8000-000000000005",
        afterSourceSeq: 0,
        limit: 10,
      });
    } catch {
      replayBindingRejected = true;
    }
    if (!replayBindingRejected) throw new Error("mismatched replay binding was accepted");

    const completion: CompleteControlPlaneRunInput = {
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      turnId: "turn-standalone-conformance",
      callerResultId: "result-standalone-conformance",
      callerDedupeKey: "dedupe-standalone-conformance",
    };
    await harness.port.completeRun(completion);
    await harness.port.completeRun(completion);
    let resultMutationRejected = false;
    try {
      await harness.port.completeRun({
        ...completion,
        result: { ...completion.result, summary: "mutated result replay" },
      });
    } catch {
      resultMutationRejected = true;
    }
    if (!resultMutationRejected) throw new Error("mutated result replay was accepted");
    return {
      eventCount: replay.highestContiguousSourceSeq,
      highestContiguousSourceSeq: replay.highestContiguousSourceSeq,
      duplicateDisposition: duplicate.disposition,
      terminalReplayIdempotent: true,
      openBindingRejected,
      eventIdMutationRejected,
      eventSequenceMutationRejected,
      replayBindingRejected,
      resultMutationRejected,
    };
  } finally {
    await harness.stop?.();
  }
}
