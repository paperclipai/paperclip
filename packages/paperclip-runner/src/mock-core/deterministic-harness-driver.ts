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
  #nextSourceSeq = 1;

  constructor(
    input: OpenHarnessSessionInput,
    config: DeterministicHarnessDriverConfig,
    snapshot?: PersistedHarnessSession,
  ) {
    this.#input = structuredClone(input);
    this.#config = structuredClone(config);
    this.#turnId = snapshot?.activeTurnId ?? snapshot?.semanticResult?.turnId ?? null;
    this.#semanticResult = snapshot?.semanticResult?.result ?? null;
  }

  ids() {
    return {
      driverSessionId: `driver_${this.#input.normalizedSessionId}`,
      providerSessionId: null,
      displayId: this.#input.normalizedSessionId,
    };
  }

  async *events(): AsyncIterable<PrpEvent> {
    for (const event of this.#events) yield structuredClone(event);
  }

  async startTurn(input: { message: { role: "user"; text: string } }): Promise<{ turnId: string }> {
    this.#assertOpen();
    if (this.#turnId !== null) throw new Error("deterministic session accepts one turn");
    this.#turnId = `turn_${this.#input.runId}`;
    this.#active = true;
    this.#events.push(
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
    this.#events.push(
      this.#event("mcp_app.tool_input", { semantic_tool: inputEnvelope }, { itemId }),
      this.#event("mcp_app.tool_result", { semantic_tool: resultEnvelope }, { itemId }),
    );
    this.#semanticResult = completedResult();
    const terminal = completedTerminal();
    this.#events.push(
      this.#event("run.result.proposed", this.#semanticResult),
      this.#event("turn.completed", {}),
      this.#event("run.terminal", terminal, { turn: false }),
    );
    this.#active = false;
    return { turnId: this.#turnId };
  }

  async interrupt(input: { turnId?: string; reason?: string }): Promise<void> {
    this.#assertOpen();
    if (!this.#active || this.#turnId === null) throw new Error("no active turn to interrupt");
    if (input.turnId !== undefined && input.turnId !== this.#turnId) {
      throw new Error(`turn ${input.turnId} is not active`);
    }
    this.#events.push(
      this.#event("turn.interrupted", { reason: input.reason ?? "interrupted" }),
      this.#event("run.terminal", cancelledTerminal(), { turn: false }),
    );
    this.#active = false;
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
      complete: true,
      eventCount: this.#events.length,
      events: structuredClone(this.#events),
      omissionReason: null,
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
      lastSourceSequence: this.#events.length,
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

function completedTerminal(): PrpTerminalState {
  return {
    schema: "paperclip.prp.terminal.v1",
    turnTerminalState: "completed",
    runTerminalState: "succeeded",
    reportedWorkDisposition: "done",
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
