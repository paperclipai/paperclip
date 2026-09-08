import { describe, expect, it, vi } from "vitest";

import type { HarnessDriver, HarnessSession, PersistedHarnessSession } from "../contracts/harness-driver.js";
import type { PrpEvent, PrpStructuredRunResult, PrpTerminalState } from "../protocol/replay-contract.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Backend adapter completed.",
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: true,
    criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }],
    remainingWork: [],
  },
  evidence: [],
  verification: [{ commandOrCheck: "fake", status: "passed" }],
  attentionRequests: [],
  artifacts: [],
};

const providerIdentity = {
  kind: "acpx" as const,
  normalizedSessionId: "session-1",
  acpxRecordId: "driver-1",
  backendSessionId: "backend-1",
  agentSessionId: "provider-1",
  profileDigest: "sha256:profile",
  workspaceDigest: "sha256:workspace",
  requestedModel: "claude-sonnet-4-20250514",
  effectiveModel: "claude-sonnet-4-20250514",
  providerLifetimeFenceCandidates: [60_001, 60_002, 60_003] as const,
};

function prpEvent(sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `fake:${sourceSeq}`,
    sourceSeq,
    sourceInstanceId: "fake",
    sourceKind: "runner",
    runId: "run-1",
    normalizedSessionId: "session-1",
    turnId: "turn-1",
    eventType,
    schemaVersion: 1,
    priority: 0,
    emittedAt: `2026-08-09T00:00:0${sourceSeq}.000Z`,
    payload,
  };
}

const runtimeResolutions: unknown[] = [];

class FakeHarnessSession implements HarnessSession {
  ids() { return { driverSessionId: "driver-1", providerSessionId: "provider-1" }; }
  async *events() {
    yield prpEvent(1, "run.result.proposed", result);
    yield prpEvent(2, "turn.completed", { status: "completed" });
  }
  async startTurn() { return { turnId: "turn-1" }; }
  async resolveRuntimeRequest(input: unknown) {
    runtimeResolutions.push(structuredClone(input));
  }
  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: "fake",
      driverSessionId: "driver-1",
      providerSessionId: "provider-1",
      providerIdentity,
      providerRecoveryPolicy: "allow_replacement_after_governed_wait",
      semanticResult: { result, fingerprint: "fingerprint", turnId: "turn-1" },
      lastSourceSequence: 2,
    };
  }
  async close() {}
}

const driver: HarnessDriver = {
  async descriptor() {
    return {
      kind: "fake",
      displayName: "Fake harness",
      version: "1",
      capabilities: {
        resume: false,
        typedEvents: true,
        steering: false,
        interruption: false,
        structuredResult: true,
      },
    };
  },
  async openSession() { return new FakeHarnessSession(); },
};

describe("HarnessDriverBackend", () => {
  it("rejects and closes a provider session without a durable provider identity", async () => {
    let closed = false;
    class MissingProviderIdentitySession extends FakeHarnessSession {
      override ids() {
        return {
          driverSessionId: "driver-missing-provider",
          providerSessionId: null,
        };
      }

      override async close() {
        closed = true;
      }
    }
    const incompleteDriver: HarnessDriver = {
      ...driver,
      async openSession() {
        return new MissingProviderIdentitySession();
      },
    };
    const backend = new HarnessDriverBackend(incompleteDriver);

    await expect(backend.openSession({
      identity: {
        runId: "run-incomplete",
        sessionId: "session-incomplete",
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
      workingDirectory: "/workspace",
    })).rejects.toThrow(
      "provider_initialize_protocol_error: provider=fake stage=session.open missing durable provider session identity",
    );
    expect(closed).toBe(true);
  });

  it("rejects and closes a recovered session without a durable provider identity", async () => {
    let closed = false;
    class MissingRecoveredIdentitySession extends FakeHarnessSession {
      override ids() {
        return {
          driverSessionId: "driver-missing-recovered-provider",
          providerSessionId: null,
        };
      }

      override async close() {
        closed = true;
      }
    }
    const incompleteDriver: HarnessDriver = {
      ...driver,
      async recoverSession() {
        return {
          recovered: true,
          session: new MissingRecoveredIdentitySession(),
        };
      },
    };
    const backend = new HarnessDriverBackend(incompleteDriver);

    await expect(backend.recoverSession({
      backendKind: "runner",
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      identity: {
        runId: "run-recover-incomplete",
        sessionId: "session-recover-incomplete",
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
      cursor: "0",
    }, {
      signal: new AbortController().signal,
    })).rejects.toThrow(
      "provider_initialize_protocol_error: provider=fake stage=session.recover missing durable provider session identity",
    );
    expect(closed).toBe(true);
  });

  it("normalizes harness events, result, terminal, and snapshot", async () => {
    const backend = new HarnessDriverBackend(driver);
    const session = await backend.openSession({
      identity: { runId: "run-1", sessionId: "session-1", companyId: "company-1", issueId: "issue-1", agentId: "agent-1" },
      workingDirectory: "/workspace",
    });
    const events: PrpEvent[] = [];
    for await (const event of session.events()) events.push(event);
    expect(events).toHaveLength(2);
    await expect(session.result()).resolves.toMatchObject({ result, turnId: "turn-1", terminal: { runTerminalState: "succeeded" } });
    await expect(session.snapshot()).resolves.toMatchObject({
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      providerIdentity,
      providerRecoveryPolicy: "allow_replacement_after_governed_wait",
    });
  });

  it("passes the persisted harness driver kind through recovery", async () => {
    let recoveredDriverKind: string | null = null;
    let recoveredProviderIdentity: PersistedHarnessSession["providerIdentity"];
    let recoveredDispositionAllowance: boolean | undefined;
    const recoveryDriver: HarnessDriver = {
      ...driver,
      async recoverSession(snapshot) {
        recoveredDriverKind = snapshot.driverKind;
        recoveredProviderIdentity = snapshot.providerIdentity;
        recoveredDispositionAllowance =
          snapshot.dispositionOnlyRecoveryConsumed;
        return { recovered: true, session: new FakeHarnessSession() };
      },
    };
    const backend = new HarnessDriverBackend(recoveryDriver);
    const recovery = await backend.recoverSession({
      backendKind: "runner",
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      providerIdentity,
      providerRecoveryPolicy: "allow_replacement_after_governed_wait",
      dispositionOnlyRecoveryConsumed: true,
      identity: { runId: "run-2", sessionId: "session-1", companyId: "company-1", issueId: "issue-1", agentId: "agent-1" },
    }, {
      signal: new AbortController().signal,
    });
    expect(recovery.recovered).toBe(true);
    expect(recoveredDriverKind).toBe("fake");
    expect(recoveredProviderIdentity).toEqual(providerIdentity);
    expect(recoveredDispositionAllowance).toBe(true);
  });

  it("preserves a consumed disposition allowance in native snapshots", async () => {
    class ConsumedRecoverySession extends FakeHarnessSession {
      override async snapshot(): Promise<PersistedHarnessSession> {
        return {
          ...(await super.snapshot()),
          dispositionOnlyRecoveryConsumed: true,
        };
      }
    }
    const backend = new HarnessDriverBackend({
      ...driver,
      async openSession() {
        return new ConsumedRecoverySession();
      },
    });
    const session = await backend.openSession({
      identity: {
        runId: "run-consumed-recovery",
        sessionId: "session-1",
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
    });

    await expect(session.snapshot()).resolves.toMatchObject({
      dispositionOnlyRecoveryConsumed: true,
    });
  });

  it("forwards the native bootstrap signal to the harness driver", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const backend = new HarnessDriverBackend({
      ...driver,
      async openSession(input) {
        receivedSignal = input.signal;
        return new FakeHarnessSession();
      },
    });

    await backend.openSession({
      identity: { runId: "run-signal", sessionId: "session-signal", companyId: "company-1", issueId: "issue-1", agentId: "agent-1" },
      workingDirectory: "/workspace",
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  it("forwards the native recovery signal to the harness driver", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const backend = new HarnessDriverBackend({
      ...driver,
      async recoverSession(_snapshot, options) {
        receivedSignal = options.signal;
        return { recovered: true, session: new FakeHarnessSession() };
      },
    });

    const recovery = await backend.recoverSession({
      backendKind: "runner",
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      providerIdentity,
      identity: { runId: "run-recover-signal", sessionId: "session-1", companyId: "company-1", issueId: "issue-1", agentId: "agent-1" },
    }, {
      signal: controller.signal,
    });

    expect(recovery.recovered).toBe(true);
    expect(receivedSignal).toBe(controller.signal);
  });

  it("does not resurrect a settled turn across repeated backend recovery", async () => {
    const terminal: PrpTerminalState = {
      schema: "paperclip.prp.terminal.v1",
      turnTerminalState: "completed",
      runTerminalState: "succeeded",
      reportedWorkDisposition: "done",
    };
    const recoveredSnapshots: PersistedHarnessSession[] = [];

    class SettledRecoveredSession extends FakeHarnessSession {
      readonly #snapshot: PersistedHarnessSession;

      constructor(snapshot: PersistedHarnessSession) {
        super();
        this.#snapshot = structuredClone(snapshot);
      }

      override async *events() {
        // Model the deterministic driver's recovery rule: only an active turn
        // produces a reconstructed result/terminal sequence.
        if (this.#snapshot.activeTurnId === null || this.#snapshot.activeTurnId === undefined) return;
        yield prpEvent(3, "run.result.proposed", result);
        yield prpEvent(4, "turn.completed", { status: "completed" });
        yield prpEvent(5, "run.terminal", terminal);
      }

      override async snapshot(): Promise<PersistedHarnessSession> {
        return structuredClone(this.#snapshot);
      }
    }

    const recoveryDriver: HarnessDriver = {
      ...driver,
      async recoverSession(snapshot) {
        recoveredSnapshots.push(structuredClone(snapshot));
        return { recovered: true, session: new SettledRecoveredSession(snapshot) };
      },
    };
    const backend = new HarnessDriverBackend(recoveryDriver);
    const settledSnapshot = {
      backendKind: "runner" as const,
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      identity: {
        runId: "run-1",
        sessionId: "session-1",
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
      cursor: "2",
      semanticResult: result,
      terminal,
      activeTurnId: null,
      terminalTurns: [{ turnId: "turn-1", fingerprint: "terminal-1" }],
    };

    const firstRecovery = await backend.recoverSession(settledSnapshot, {
      signal: new AbortController().signal,
    });
    expect(firstRecovery.recovered).toBe(true);
    const firstSession = firstRecovery.session!;
    const firstRecoveredSnapshot = await firstSession.snapshot();
    expect(firstRecoveredSnapshot).toMatchObject({
      activeTurnId: null,
      semanticResult: result,
      terminal,
    });
    await expect(firstSession.result()).resolves.toEqual({
      result,
      terminal,
      turnId: "turn-1",
    });

    const secondRecovery = await backend.recoverSession(firstRecoveredSnapshot, {
      signal: new AbortController().signal,
    });
    expect(secondRecovery.recovered).toBe(true);
    const secondSession = secondRecovery.session!;
    await expect(secondSession.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      semanticResult: result,
      terminal,
    });
    const replayedEvents: PrpEvent[] = [];
    for await (const event of secondSession.events()) replayedEvents.push(event);
    expect(replayedEvents.filter((event) =>
      event.eventType === "run.result.proposed" || event.eventType === "run.terminal"
    )).toEqual([]);
    expect(recoveredSnapshots.map((snapshot) => snapshot.activeTurnId)).toEqual([null, null]);

    await secondSession.close({ reason: "double recovery complete" });
    await firstSession.close({ reason: "first recovery complete" });
  });

  it("allows only the run id to change when a harness session is attached", async () => {
    const attachedRunIds: string[] = [];
    class AttachableHarnessSession extends FakeHarnessSession {
      async attachRun(input: { runId: string }) {
        attachedRunIds.push(input.runId);
      }
    }
    const backend = new HarnessDriverBackend({
      ...driver,
      async openSession() { return new AttachableHarnessSession(); },
    });
    const originalIdentity = {
      runId: "run-1",
      sessionId: "session-1",
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
    };
    const session = await backend.openSession({
      identity: originalIdentity,
      workingDirectory: "/workspace",
    });

    for (const identity of [
      { ...originalIdentity, runId: "run-forged-company", companyId: "company-2" },
      { ...originalIdentity, runId: "run-forged-issue", issueId: "issue-2" },
      { ...originalIdentity, runId: "run-forged-agent", agentId: "agent-2" },
      { ...originalIdentity, runId: "run-forged-session", sessionId: "session-2" },
    ]) {
      await expect(session.attachRun?.({ identity })).rejects.toThrow(
        "native_session_attach_binding_mismatch",
      );
      expect(session.identity()).toEqual(originalIdentity);
    }
    expect(attachedRunIds).toEqual([]);

    await expect(session.attachRun?.({
      identity: { ...originalIdentity, runId: "run-2" },
    })).resolves.toBeUndefined();
    expect(attachedRunIds).toEqual(["run-2"]);
    expect(session.identity()).toEqual({ ...originalIdentity, runId: "run-2" });
  });

  it("restores a persisted terminal before the recovered stream is consumed", async () => {
    const recoveryDriver: HarnessDriver = {
      ...driver,
      async recoverSession() {
        return { recovered: true, session: new FakeHarnessSession() };
      },
    };
    const backend = new HarnessDriverBackend(recoveryDriver);
    const terminal = {
      schema: "paperclip.prp.terminal.v1" as const,
      turnTerminalState: "completed" as const,
      runTerminalState: "succeeded" as const,
      reportedWorkDisposition: "done" as const,
    };
    const recovery = await backend.recoverSession({
      backendKind: "runner",
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      identity: {
        runId: "run-terminal-recovery",
        sessionId: "session-1",
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
      semanticResult: result,
      terminal,
      activeTurnId: "turn-1",
      terminalTurns: [
        { turnId: "turn-1", fingerprint: "terminal-fingerprint" },
      ],
    }, {
      signal: new AbortController().signal,
    });

    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery.session!.snapshot()).resolves.toMatchObject({
      semanticResult: result,
      terminal,
    });
    await expect(recovery.session!.result()).resolves.toEqual({
      result,
      terminal,
      turnId: "turn-1",
    });
  });

  it("reconstructs a missing top-level terminal from a completed semantic turn", async () => {
    const recoveryDriver: HarnessDriver = {
      ...driver,
      async recoverSession() {
        return { recovered: true, session: new FakeHarnessSession() };
      },
    };
    const backend = new HarnessDriverBackend(recoveryDriver);
    const semanticFingerprint = canonicalTestJson(result);
    const recovery = await backend.recoverSession({
      backendKind: "runner",
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      identity: {
        runId: "run-terminal-inference",
        sessionId: "session-1",
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
      semanticResult: result,
      terminal: null,
      activeTurnId: null,
      terminalTurns: [
        {
          turnId: "turn-1",
          fingerprint: JSON.stringify({
            status: "completed",
            semanticResult: semanticFingerprint,
          }),
        },
      ],
    }, {
      signal: new AbortController().signal,
    });

    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery.session!.result()).resolves.toEqual({
      result,
      terminal: {
        schema: "paperclip.prp.terminal.v1",
        turnTerminalState: "completed",
        runTerminalState: "succeeded",
        reportedWorkDisposition: "done",
      },
      turnId: "turn-1",
    });
  });

  it("does not pair a recovered semantic result with another turn's terminal", async () => {
    let recoveredPersisted: PersistedHarnessSession | null = null;
    class RecoveredHarnessSession extends FakeHarnessSession {
      override async snapshot(): Promise<PersistedHarnessSession> {
        if (recoveredPersisted === null) throw new Error("missing recovered snapshot");
        return structuredClone(recoveredPersisted);
      }
    }
    const recoveryDriver: HarnessDriver = {
      ...driver,
      async recoverSession(snapshot) {
        recoveredPersisted = snapshot;
        return { recovered: true, session: new RecoveredHarnessSession() };
      },
    };
    const backend = new HarnessDriverBackend(recoveryDriver);
    const semanticFingerprint = canonicalTestJson(result);
    const recovery = await backend.recoverSession({
      backendKind: "runner",
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      identity: {
        runId: "run-cross-turn-terminal",
        sessionId: "session-1",
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
      semanticResult: result,
      terminal: {
        schema: "paperclip.prp.terminal.v1",
        turnTerminalState: "cancelled",
        runTerminalState: "cancelled",
        reportedWorkDisposition: "yielded",
      },
      activeTurnId: null,
      terminalTurns: [
        {
          turnId: "turn-with-result",
          fingerprint: JSON.stringify({
            status: "completed",
            semanticResult: semanticFingerprint,
          }),
        },
        {
          turnId: "later-cancelled-turn",
          fingerprint: JSON.stringify({ status: "cancelled" }),
        },
      ],
    }, {
      signal: new AbortController().signal,
    });

    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery.session!.result()).resolves.toEqual({
      result,
      terminal: {
        schema: "paperclip.prp.terminal.v1",
        turnTerminalState: "completed",
        runTerminalState: "succeeded",
        reportedWorkDisposition: "done",
      },
      turnId: "turn-with-result",
    });
  });

  it("rejects oversized terminal history before inspecting the semantic result", async () => {
    const recoverSession = vi.fn(async () => ({
      recovered: true,
      session: new FakeHarnessSession(),
    }));
    const backend = new HarnessDriverBackend({ ...driver, recoverSession });
    const inaccessibleResult = new Proxy(result, {
      ownKeys() {
        throw new Error("semantic result must not be inspected");
      },
    });

    await expect(backend.recoverSession({
      backendKind: "runner",
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      identity: {
        runId: "run-oversized-terminals",
        sessionId: "session-1",
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
      semanticResult: inaccessibleResult,
      terminalTurns: Array.from({ length: 4_097 }, (_, index) => ({
        turnId: `turn-${index}`,
        fingerprint: "terminal",
      })),
    }, {
      signal: new AbortController().signal,
    })).resolves.toEqual({
      recovered: false,
      reason: "persisted harness terminal history exceeds its recovery limit",
    });
    expect(recoverSession).not.toHaveBeenCalled();
  });

  it("rejects an oversized semantic result before canonicalization", async () => {
    const recoverSession = vi.fn(async () => ({
      recovered: true,
      session: new FakeHarnessSession(),
    }));
    const backend = new HarnessDriverBackend({ ...driver, recoverSession });

    await expect(backend.recoverSession({
      backendKind: "runner",
      driverKind: "fake",
      sessionId: "driver-1",
      providerSessionId: "provider-1",
      identity: {
        runId: "run-oversized-semantic-result",
        sessionId: "session-1",
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
      semanticResult: {
        ...result,
        summary: "x".repeat(8 * 1024 * 1024),
      },
      terminalTurns: [],
    }, {
      signal: new AbortController().signal,
    })).resolves.toEqual({
      recovered: false,
      reason: "persisted harness semantic result exceeds its recovery limit",
    });
    expect(recoverSession).not.toHaveBeenCalled();
  });

  it("delegates native runtime-request resolutions to the harness session", async () => {
    runtimeResolutions.length = 0;
    const backend = new HarnessDriverBackend(driver);
    const session = await backend.openSession({
      identity: {
        runId: "run-1",
        sessionId: "session-1",
        companyId: "company-1",
        issueId: "issue-1",
        agentId: "agent-1",
      },
      workingDirectory: "/workspace",
    });

    await session.resolveRuntimeRequest?.({
      requestId: "permission-1",
      turnId: "turn-1",
      resolution: { action: "accept_for_session" },
    });

    expect(runtimeResolutions).toEqual([
      {
        requestId: "permission-1",
        turnId: "turn-1",
        resolution: { action: "accept_for_session" },
      },
    ]);
  });

  it("emits one non-replayable input expiration and terminal wait after provider loss", async () => {
    const questionSet = {
      schema: "paperclip.question_set.v1" as const,
      questions: [{ id: "target", prompt: "Which target?", required: true, answerMode: "text" as const }],
    };
    class LostProviderSession extends FakeHarnessSession {
      override async *events() {
        yield prpEvent(1, "runtime_request.created", { request: {
          schema: "paperclip.runtime_request.v2",
          requestKind: "runtime",
          requestId: "input-1",
          type: "input",
          status: "pending",
          prompt: "Which target?",
          input: questionSet,
          turnId: "turn-1",
          itemId: "input-1",
        } });
        throw new Error("provider transport lost");
      }
      override async snapshot(): Promise<PersistedHarnessSession> {
        return { driverKind: "fake", driverSessionId: "driver-1", lastSourceSequence: 1 };
      }
    }
    const backend = new HarnessDriverBackend({ ...driver, async openSession() { return new LostProviderSession(); } });
    const session = await backend.openSession({
      identity: { runId: "run-1", sessionId: "session-1", companyId: "company-1", issueId: "issue-1", agentId: "agent-1" },
      workingDirectory: "/workspace",
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { eventType: "runtime_request.created" } });
    await expect(iterator.next()).resolves.toMatchObject({ value: {
      eventType: "runtime_request.expired",
      sourceSeq: 2,
      payload: {
        requestId: "input-1",
        reason: "provider_process_lost",
        replayAllowed: false,
        request: { input: questionSet },
      },
    } });
    await expect(iterator.next()).resolves.toMatchObject({ value: {
      eventType: "turn.interrupted",
      sourceSeq: 3,
      payload: { reason: "provider_process_lost" },
    } });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it("does not synthesize a fallback after the input was already resolved", async () => {
    class ResolvedThenLostSession extends FakeHarnessSession {
      override async *events() {
        yield prpEvent(1, "runtime_request.created", { request: {
          schema: "paperclip.runtime_request.v2",
          requestKind: "runtime",
          requestId: "input-1",
          type: "input",
          status: "pending",
          prompt: "Which target?",
          input: { schema: "paperclip.question_set.v1", questions: [{ id: "target", prompt: "Which target?", required: true, answerMode: "text" }] },
        } });
        yield prpEvent(2, "runtime_request.resolved", { requestId: "input-1", action: "submit" });
        throw new Error("provider transport lost after resolution");
      }
    }
    const backend = new HarnessDriverBackend({ ...driver, async openSession() { return new ResolvedThenLostSession(); } });
    const session = await backend.openSession({
      identity: { runId: "run-1", sessionId: "session-1", companyId: "company-1", issueId: "issue-1", agentId: "agent-1" },
      workingDirectory: "/workspace",
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow("provider transport lost after resolution");
  });

  it("does not synthesize a fallback after explicit run cancellation", async () => {
    class CancelledProviderSession extends FakeHarnessSession {
      override async *events() {
        yield prpEvent(1, "runtime_request.created", { request: {
          schema: "paperclip.runtime_request.v2",
          requestKind: "runtime",
          requestId: "input-1",
          type: "input",
          status: "pending",
          prompt: "Which target?",
          input: { schema: "paperclip.question_set.v1", questions: [{ id: "target", prompt: "Which target?", required: true, answerMode: "text" }] },
        } });
        throw new Error("provider stopped after cancellation");
      }
      async interrupt() {}
    }
    const backend = new HarnessDriverBackend({ ...driver, async openSession() { return new CancelledProviderSession(); } });
    const session = await backend.openSession({
      identity: { runId: "run-1", sessionId: "session-1", companyId: "company-1", issueId: "issue-1", agentId: "agent-1" },
      workingDirectory: "/workspace",
    });
    const iterator = session.events()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { eventType: "runtime_request.created" } });
    await session.cancel({
      reason: "operator cancelled the run",
      signal: new AbortController().signal,
    }).cleanup;
    await expect(iterator.next()).rejects.toThrow("provider stopped after cancellation");
  });
});

function canonicalTestJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalTestJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalTestJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
