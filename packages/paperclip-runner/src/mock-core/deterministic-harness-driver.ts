import {
  type HarnessDriver,
  type HarnessDriverConfigValidation,
  type HarnessDriverDescriptor,
  type HarnessSession,
  type HarnessSessionRecoveryResult,
  type HarnessTranscriptSnapshot,
  type OpenHarnessSessionInput,
  type PersistedHarnessSession,
} from "../contracts/harness-driver.js";
import {
  createPrpSemanticToolInputEnvelope,
  createPrpSemanticToolResultEnvelope,
} from "../protocol/semantic-tool-receipts.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../protocol/replay-contract.js";

export const DETERMINISTIC_HARNESS_DRIVER_CONFIG_SCHEMA =
  "paperclip-runner/deterministic-harness-driver-config/v1" as const;

export interface DeterministicHarnessDriverConfig {
  schema: typeof DETERMINISTIC_HARNESS_DRIVER_CONFIG_SCHEMA;
  scenario: "semantic-tool-success";
}

const DEFAULT_CONFIG: DeterministicHarnessDriverConfig = {
  schema: DETERMINISTIC_HARNESS_DRIVER_CONFIG_SCHEMA,
  scenario: "semantic-tool-success",
};

function parseConfig(value: unknown): HarnessDriverConfigValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      config: null,
      issues: [{ path: "/", code: "type", message: "config must be an object" }],
    };
  }
  const config = value as Record<string, unknown>;
  if (config.schema !== DETERMINISTIC_HARNESS_DRIVER_CONFIG_SCHEMA) {
    return {
      ok: false,
      config: null,
      issues: [{
        path: "/schema",
        code: "unsupported_schema",
        message: `schema must be ${DETERMINISTIC_HARNESS_DRIVER_CONFIG_SCHEMA}`,
      }],
    };
  }
  if (config.scenario !== "semantic-tool-success") {
    return {
      ok: false,
      config: null,
      issues: [{
        path: "/scenario",
        code: "unsupported_scenario",
        message: "scenario must be semantic-tool-success",
      }],
    };
  }
  return { ok: true, config: structuredClone(config), issues: [] };
}

/** Provider-free fake used by packed consumers and App/Evals conformance. */
export class DeterministicHarnessDriver implements HarnessDriver {
  readonly #config: DeterministicHarnessDriverConfig;

  constructor(config: DeterministicHarnessDriverConfig = DEFAULT_CONFIG) {
    const validation = parseConfig(config);
    if (!validation.ok) throw new Error(validation.issues[0]?.message ?? "invalid config");
    this.#config = structuredClone(config);
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    return {
      kind: "paperclip-deterministic",
      displayName: "Paperclip deterministic harness driver",
      version: "1.0.0",
      protocolVersion: "prp.v1",
      capabilities: {
        resume: true,
        typedEvents: true,
        steering: false,
        interruption: true,
        structuredResult: true,
        read: true,
        reconciliation: true,
        usage: true,
        dynamicTools: true,
        runtimeRequestResolution: false,
        goals: false,
        threadLineage: false,
        unsupported: ["steering", "runtimeRequestResolution", "goals", "threadLineage"],
      },
    };
  }

  async validateConfig(config: unknown): Promise<HarnessDriverConfigValidation> {
    return parseConfig(config);
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    return new DeterministicHarnessSession(input, this.#config);
  }

  async recoverSession(
    snapshot: PersistedHarnessSession,
  ): Promise<HarnessSessionRecoveryResult> {
    if (
      snapshot.driverKind !== "paperclip-deterministic"
      || snapshot.runId === undefined
      || snapshot.normalizedSessionId === undefined
    ) {
      return { recovered: false, reason: "snapshot does not belong to the deterministic driver" };
    }
    return {
      recovered: true,
      session: new DeterministicHarnessSession({
        runId: snapshot.runId,
        normalizedSessionId: snapshot.normalizedSessionId,
        workingDirectory: "/deterministic/recovered",
      }, this.#config, snapshot),
    };
  }
}

class DeterministicHarnessSession implements HarnessSession {
  readonly #input: OpenHarnessSessionInput;
  readonly #config: DeterministicHarnessDriverConfig;
  #events: PrpEvent[] = [];
  #semanticResult: PrpStructuredRunResult | null = null;
  #turnId: string | null = null;
  #closed = false;
  #active = false;
  #recoveredActiveTurn = false;
  #recoveredTurnSettled = false;
  #nextSourceSeq = 1;
  readonly #transcriptOmissionReason: string | null;
  readonly #eventWaiters = new Set<() => void>();

  constructor(
    input: OpenHarnessSessionInput,
    config: DeterministicHarnessDriverConfig,
    snapshot?: PersistedHarnessSession,
  ) {
    this.#input = structuredClone(input);
    this.#config = structuredClone(config);
    this.#turnId = snapshot?.activeTurnId ?? snapshot?.semanticResult?.turnId ?? null;
    this.#semanticResult = snapshot?.semanticResult?.result ?? null;
    this.#active = snapshot?.activeTurnId !== null && snapshot?.activeTurnId !== undefined;
    this.#recoveredActiveTurn = this.#active;
    this.#nextSourceSeq = (snapshot?.lastSourceSequence ?? 0) + 1;
    this.#transcriptOmissionReason = snapshot === undefined
      ? null
      : "pre_recovery_events_not_reconstructed";
  }

  ids() {
    return {
      driverSessionId: `driver_${this.#input.normalizedSessionId}`,
      providerSessionId: null,
      displayId: this.#input.normalizedSessionId,
    };
  }

  async *events(): AsyncIterable<PrpEvent> {
    if (this.#recoveredActiveTurn && this.#active && this.#turnId !== null) {
      // The deterministic fake has no provider process that can continue an
      // in-flight turn after reconstruction. Produce one conservative terminal
      // outcome when consumption resumes so the native loop cannot wait until
      // its global timeout. An explicit interrupt issued before consumption
      // still wins and supplies its own reason.
      if (!this.#settleRecoveredSemanticResult()) {
        this.#recoveredActiveTurn = false;
        this.#semanticResult = interruptedResult(
          this.#input.runId,
          "The deterministic provider was unavailable after active-turn recovery.",
        );
        this.#appendEvents(
          this.#event("run.result.proposed", this.#semanticResult),
          this.#event("turn.interrupted", {
            reason: "deterministic_active_turn_recovered_without_live_producer",
          }),
          this.#event("run.terminal", cancelledTerminal(), { turn: false }),
        );
        this.#recoveredTurnSettled = true;
      }
      this.#active = false;
    }
    let index = 0;
    while (true) {
      while (index < this.#events.length) {
        const event = this.#events[index++]!;
        yield structuredClone(event);
        if (event.eventType === "run.terminal") return;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => this.#eventWaiters.add(resolve));
    }
  }

  async startTurn(input: { message: { role: "user"; text: string } }): Promise<{ turnId: string }> {
    this.#assertOpen();
    if (this.#turnId !== null) throw new Error("deterministic session accepts one turn");
    this.#turnId = `turn_${this.#input.runId}`;
    this.#active = true;
    this.#appendEvents(
      this.#event("session.started", {}, { turn: false }),
      this.#event("turn.started", { message: input.message.text }),
    );
    if (input.message.text.includes("[conformance:interrupt]")) {
      return { turnId: this.#turnId };
    }

    const itemId = `item_${this.#input.runId}`;
    const callId = `call_${this.#input.runId}`;
    const correlation = {
      runId: this.#input.runId,
      normalizedSessionId: this.#input.normalizedSessionId,
      turnId: this.#turnId,
      itemId,
    };
    const inputEnvelope = createPrpSemanticToolInputEnvelope({
      operationId: "finish_task",
      callId,
      correlation,
      idempotencyKey: `finish_${this.#input.runId}`,
      content: { summary: "Deterministic conformance complete." },
    });
    const resultEnvelope = createPrpSemanticToolResultEnvelope({
      operationId: "finish_task",
      callId,
      correlation,
      idempotencyKey: `finish_${this.#input.runId}`,
      content: { disposition: "applied", status: "done" },
      outcome: "succeeded",
      code: "applied",
      retryable: false,
      authorizationBoundary: "active_task",
      auditReceiptId: `audit_${this.#input.runId}`,
    });
    this.#appendEvents(
      this.#event("mcp_app.tool_input", { semantic_tool: inputEnvelope }, { itemId }),
      this.#event("mcp_app.tool_result", { semantic_tool: resultEnvelope }, { itemId }),
    );
    this.#semanticResult = completedResult();
    const terminal = completedTerminal();
    this.#appendEvents(
      this.#event("run.result.proposed", this.#semanticResult),
      this.#event("turn.completed", {}),
      this.#event("run.terminal", terminal, { turn: false }),
    );
    this.#active = false;
    return { turnId: this.#turnId };
  }

  async interrupt(input: { turnId?: string; reason?: string }): Promise<void> {
    this.#assertOpen();
    if (this.#turnId === null) throw new Error("no active turn to interrupt");
    if (input.turnId !== undefined && input.turnId !== this.#turnId) {
      throw new Error(`turn ${input.turnId} is not active`);
    }
    // Event consumption can conservatively settle a reconstructed turn before
    // its first event is yielded. Treat a concurrent interrupt as an
    // idempotent acknowledgement once that recovered terminal is committed,
    // rather than making cancellation depend on iterator scheduling.
    if (!this.#active) {
      if (this.#recoveredTurnSettled) return;
      throw new Error("no active turn to interrupt");
    }
    if (this.#settleRecoveredSemanticResult()) return;
    this.#semanticResult = interruptedResult(
      this.#input.runId,
      input.reason ?? "The deterministic turn was interrupted.",
    );
    this.#appendEvents(
      this.#event("run.result.proposed", this.#semanticResult),
      this.#event("turn.interrupted", { reason: input.reason ?? "interrupted" }),
      this.#event("run.terminal", cancelledTerminal(), { turn: false }),
    );
    this.#active = false;
  }

  #settleRecoveredSemanticResult(): boolean {
    if (
      !this.#recoveredActiveTurn
      || !this.#active
      || this.#turnId === null
      || this.#semanticResult === null
    ) return false;
    this.#recoveredActiveTurn = false;
    // A result-first checkpoint can still carry activeTurnId when the
    // terminal checkpoint lagged behind the provider work. Preserve the
    // authoritative result even if cancellation races event consumption.
    if (this.#semanticResult.reportedWorkDisposition === "yielded") {
      this.#appendEvents(
        this.#event("run.result.proposed", this.#semanticResult),
        this.#event("turn.interrupted", {
          reason: "deterministic_active_turn_recovered_with_yielded_result",
        }),
        this.#event("run.terminal", cancelledTerminal(), { turn: false }),
      );
    } else {
      this.#appendEvents(
        this.#event("run.result.proposed", this.#semanticResult),
        this.#event("turn.completed", {}),
        this.#event(
          "run.terminal",
          completedTerminal(this.#semanticResult.reportedWorkDisposition),
          { turn: false },
        ),
      );
    }
    this.#recoveredTurnSettled = true;
    this.#active = false;
    return true;
  }

  async read(): Promise<Record<string, unknown>> {
    return { scenario: this.#config.scenario, eventCount: this.#events.length };
  }

  async reconcile(): Promise<Record<string, unknown>> {
    return { active: this.#active, closed: this.#closed, eventCount: this.#events.length };
  }

  async usage(): Promise<Record<string, unknown>> {
    return {
      inputTokens: this.#turnId === null ? 0 : 12,
      outputTokens: this.#semanticResult === null ? 0 : 8,
      totalTokens: this.#turnId === null ? 0 : this.#semanticResult === null ? 12 : 20,
      requestCount: this.#turnId === null ? 0 : 1,
      cost: { currency: "USD", amountMicros: 0 },
    };
  }

  async transcript(): Promise<HarnessTranscriptSnapshot> {
    return {
      schema: "paperclip-runner/harness-transcript/v1",
      complete: this.#transcriptOmissionReason === null,
      eventCount: this.#events.length,
      events: structuredClone(this.#events),
      omissionReason: this.#transcriptOmissionReason,
    };
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: "paperclip-deterministic",
      driverSessionId: `driver_${this.#input.normalizedSessionId}`,
      providerSessionId: null,
      runId: this.#input.runId,
      normalizedSessionId: this.#input.normalizedSessionId,
      activeTurnId: this.#active ? this.#turnId : null,
      lastSourceSequence: this.#nextSourceSeq - 1,
      semanticResult: this.#semanticResult === null || this.#turnId === null
        ? null
        : {
            result: structuredClone(this.#semanticResult),
            fingerprint: JSON.stringify(this.#semanticResult),
            turnId: this.#turnId,
          },
      terminalTurns: this.#events.some((event) => event.eventType === "run.terminal") && this.#turnId !== null
        ? [{ turnId: this.#turnId, fingerprint: `terminal_${this.#input.runId}` }]
        : [],
    };
  }

  async close(input: { reason: string; force?: boolean }): Promise<void> {
    if (this.#closed) return;
    if (this.#active) {
      await this.interrupt({ reason: input.reason });
    }
    this.#closed = true;
    this.#notifyEventWaiters();
  }

  #appendEvents(...events: PrpEvent[]): void {
    this.#events.push(...events);
    this.#notifyEventWaiters();
  }

  #notifyEventWaiters(): void {
    for (const resolve of this.#eventWaiters) resolve();
    this.#eventWaiters.clear();
  }

  #event(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown> | PrpStructuredRunResult | PrpTerminalState,
    options: { itemId?: string; turn?: boolean } = {},
  ): PrpEvent {
    const sourceSeq = this.#nextSourceSeq++;
    return {
      schema: "paperclip.prp.event.v1",
      sourceEventId: `event_${this.#input.runId}_${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: `runner_${this.#input.runId}`,
      sourceKind: "runner",
      runId: this.#input.runId,
      normalizedSessionId: this.#input.normalizedSessionId,
      ...(options.turn === false || this.#turnId === null ? {} : { turnId: this.#turnId }),
      ...(options.itemId === undefined ? {} : { itemId: options.itemId }),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.terminal" || eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: new Date(Date.UTC(2026, 7, 11, 12, 0, sourceSeq)).toISOString(),
      payload: structuredClone(payload),
    } as PrpEvent;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("deterministic session is closed");
  }
}

function completedResult(): PrpStructuredRunResult {
  return {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: "done",
    summary: "Deterministic harness-driver conformance completed.",
    completionClaim: {
      contractRevision: "harness-driver-conformance-v1",
      objectiveSatisfied: true,
      criteria: [],
      remainingWork: [],
    },
    evidence: [],
    verification: [{ commandOrCheck: "deterministic harness flow", status: "passed" }],
    attentionRequests: [],
    artifacts: [],
  };
}

function completedTerminal(
  disposition: PrpTerminalState["reportedWorkDisposition"] = "done",
): PrpTerminalState {
  return {
    schema: "paperclip.prp.terminal.v1",
    turnTerminalState: "completed",
    runTerminalState: "succeeded",
    reportedWorkDisposition: disposition,
  };
}

function interruptedResult(runId: string, summary: string): PrpStructuredRunResult {
  return {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: "yielded",
    summary,
    completionClaim: {
      contractRevision: "harness-driver-conformance-v1",
      objectiveSatisfied: false,
      criteria: [],
      remainingWork: [{
        description: "Resume the interrupted work in a live provider session.",
        blocksCompletion: true,
      }],
    },
    evidence: [],
    verification: [],
    attentionRequests: [],
    artifacts: [],
    continuation: {
      kind: "same_agent",
      summary: "Resume the interrupted deterministic turn.",
      idempotencyKey: `resume_deterministic_${runId}`,
    },
  };
}

function cancelledTerminal(): PrpTerminalState {
  return {
    schema: "paperclip.prp.terminal.v1",
    turnTerminalState: "interrupted",
    runTerminalState: "cancelled",
    reportedWorkDisposition: "yielded",
  };
}
