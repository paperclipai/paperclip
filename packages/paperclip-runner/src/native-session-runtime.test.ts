import { describe, expect, it, vi } from "vitest";

import type { ControlPlanePort } from "./contracts/control-plane-port.js";
import type { NativeExecutionInputV1 } from "./contracts/native-execution.js";
import type {
  NativeSession,
  NativeSessionBackend,
  PersistedNativeSession,
} from "./contracts/native-session-backend.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "./protocol/replay-contract.js";
import { executeNativeSession } from "./native-session-runtime.js";

const identity = {
  runId: "run-recovery",
  sessionId: "session-recovery",
  companyId: "company-recovery",
  issueId: "issue-recovery",
  agentId: "agent-recovery",
};

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Recovered native work completed.",
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: true,
    criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }],
    remainingWork: [],
  },
  evidence: [],
  verification: [{ commandOrCheck: "recovery", status: "passed" }],
  attentionRequests: [],
  artifacts: [],
};

const terminal: PrpTerminalState = {
  schema: "paperclip.prp.terminal.v1",
  turnTerminalState: "completed",
  runTerminalState: "succeeded",
  reportedWorkDisposition: "done",
};

const input: NativeExecutionInputV1 = {
  schema: "paperclip.native-execution-input.v1",
  binding: {
    companyId: identity.companyId,
    runId: identity.runId,
    issueId: identity.issueId,
    agentId: identity.agentId,
    executionWorkspaceId: "workspace-recovery",
  },
  task: { identifier: "PAP-RECOVERY", title: "Recover native work", description: null, workMode: "standard" },
  workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
  session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1 },
  completionContract: {
    id: "contract-recovery",
    sha256: "contract-recovery-sha",
    schemaVersion: "paperclip.completion-contract.v1",
    contract: {
      revision: "1",
      objective: "Recover native work",
      criteria: [{ id: "objective", requirement: "Complete after recovery" }],
    },
  },
  interactionResponses: [],
  credentialBindings: [],
};

function controlEvent(
  sourceSeq: number,
  eventType: PrpEvent["eventType"],
  payload: Record<string, unknown>,
): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `control-recovery:${identity.runId}:${sourceSeq}`,
    sourceSeq,
    sourceInstanceId: "control-recovery",
    sourceKind: "control_plane",
    runId: identity.runId,
    normalizedSessionId: identity.sessionId,
    turnId: "turn-recovery",
    eventType,
    schemaVersion: 1,
    priority: 0,
    emittedAt: "2026-08-09T00:00:00.000Z",
    payload,
  };
}

function highestContiguous(events: PrpEvent[]): number {
  const sequences = new Set(events.map((event) => event.sourceSeq));
  let cursor = 0;
  while (sequences.has(cursor + 1)) cursor += 1;
  return cursor;
}

describe("executeNativeSession recovery", () => {
  it("continues a provider-reported active turn without starting a duplicate turn", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-recovery",
      identity,
      providerSessionId: "provider-recovery",
      cursor: "0",
      activeTurnId: null,
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const providerSnapshot: PersistedNativeSession = {
      ...checkpoint,
      cursor: "1",
      activeTurnId: "turn-recovery",
    };
    const terminalEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "provider-recovery:1",
      sourceSeq: 1,
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      runId: identity.runId,
      normalizedSessionId: identity.sessionId,
      turnId: "turn-recovery",
      eventType: "turn.completed",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:00.000Z",
      payload: {},
    };
    const bySource = new Map<string, PrpEvent[]>();
    const startTurn = vi.fn(async () => ({ turnId: "duplicate-turn" }));
    const openSession = vi.fn(async () => { throw new Error("must recover the provider session"); });
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield terminalEvent; },
      startTurn,
      async result() { return { result, terminal, turnId: "turn-recovery" }; },
      async snapshot() { return structuredClone(providerSnapshot); },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      openSession,
      async recoverSession() { return { recovered: true, session }; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession() {},
      async appendEvent(event) {
        const list = bySource.get(event.sourceInstanceId) ?? [];
        list.push(structuredClone(event));
        bySource.set(event.sourceInstanceId, list);
        return {
          cursor: list.length,
          highestContiguousSourceSeq: highestContiguous(list),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const list = bySource.get(replay.sourceInstanceId) ?? [];
        return {
          events: structuredClone(list.filter((event) => event.sourceSeq > replay.afterSourceSeq)),
          highestContiguousSourceSeq: highestContiguous(list),
        };
      },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).resolves.toMatchObject({ turnId: "turn-recovery", providerSessionId: "provider-recovery" });
    expect(openSession).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("recovers a completed checkpoint and appends only a missing control terminal fact", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-recovery",
      identity,
      providerSessionId: "provider-recovery",
      cursor: "4",
      semanticResult: result,
      terminal,
      activeTurnId: "turn-recovery",
      terminalTurns: [{ turnId: "turn-recovery", fingerprint: "terminal-fingerprint" }],
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const events = [controlEvent(1, "run.result.accepted", { result })];
    const checkpoints: PersistedNativeSession[] = [];
    const completeRun = vi.fn(async () => undefined);
    const startTurn = vi.fn(async () => ({ turnId: "unexpected-turn" }));
    const openSession = vi.fn(async () => {
      throw new Error("a recovered run must not open a second provider session");
    });
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() {},
      startTurn,
      async result() { return { result, terminal, turnId: "turn-recovery" }; },
      async snapshot() { return structuredClone(checkpoint); },
      async close() {},
    };
    const recoverSession = vi.fn(async () => ({ recovered: true, session }));
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      openSession,
      recoverSession,
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession(snapshot) { checkpoints.push(structuredClone(snapshot)); },
      async appendEvent(event) {
        events.push(structuredClone(event as PrpEvent));
        return {
          cursor: events.length,
          highestContiguousSourceSeq: highestContiguous(events),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const replayed = events.filter((event) => event.sourceSeq > replay.afterSourceSeq);
        return { events: structuredClone(replayed), highestContiguousSourceSeq: highestContiguous(events) };
      },
      completeRun,
    };

    const completed = await executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    });

    expect(openSession).not.toHaveBeenCalled();
    expect(recoverSession).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
    expect(events.map((event) => event.eventType)).toEqual(["run.result.accepted", "run.terminal"]);
    expect(events.map((event) => event.sourceSeq)).toEqual([1, 2]);
    expect(completeRun).toHaveBeenCalledOnce();
    expect(completed).toMatchObject({ nativeEventCount: 1, highestContiguousSourceSeq: 2 });
    expect(checkpoints.at(-1)).toMatchObject({ semanticResult: result, terminal });
  });
});
