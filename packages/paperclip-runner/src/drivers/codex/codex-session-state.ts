import type {
  HarnessRuntimeRequest,
  HarnessThreadGoal,
  HarnessThreadLineageEntry,
  PersistedHarnessSemanticResult,
  PersistedHarnessTurnTerminal,
} from "../../contracts/harness-driver.js";
import {
  HarnessCapabilityUnavailableError,
  HarnessReconciliationError,
  HarnessStaleTurnError,
  harnessRuntimeInputExpiredOutcome,
  harnessRuntimeRequestOutcome,
} from "../../contracts/harness-driver.js";
import type { CodexTaskEnvelope } from "../../contracts/codex.js";
import {
  validatePrpStructuredRunResult,
  type PrpEvent,
  type PrpStructuredRunResult,
} from "../../protocol/replay-contract.js";
import type { CodexAppServerTransport } from "./app-server-transport.js";
import { redactCodexDiagnostic } from "./app-server-transport.js";
import { safeCodexRequestResponse as safeRequestResponse } from "./codex-thread-normalization.js";
import type {
  CodexAppServerDriverOptions,
  CodexCapabilities,
  OpenedCodexThread,
  PendingRuntimeRequest,
} from "./codex-driver-types.js";
import { canonicalJson, record } from "./codex-driver-values.js";

class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<(value: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ value, done: false });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  clear(): void {
    this.#values = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export class CodexSessionState {
  readonly transport: CodexAppServerTransport;
  runId: string;
  readonly normalizedSessionId: string;
  readonly opened: OpenedCodexThread;
  readonly taskEnvelope: CodexTaskEnvelope;
  readonly conversationMode: "task" | "direct";
  readonly now: () => Date;
  readonly runnerInstanceId: string;
  readonly driverKind: string;
  readonly capabilities: CodexCapabilities;
  readonly dynamicTools: readonly Readonly<Record<string, unknown>>[];
  readonly dynamicToolHandler: CodexAppServerDriverOptions["dynamicToolHandler"];
  readonly eventQueue = new AsyncQueue<PrpEvent>();
  sourceSequence: number;
  activeTurnId: string | null;
  usageSnapshot: Record<string, unknown> | null = null;
  result: PrpStructuredRunResult | null = null;
  resultFingerprint: string | null = null;
  resultCallId: string | null = null;
  resultTurnId: string | null = null;
  turnStartPending = false;
  /**
   * Resolves once a pending turn/start settles, on the accepted path or on a
   * provider rejection. A terminal notification for that turn must wait on
   * this promise, so turn.accepted always precedes any terminal event for
   * the same turn even when the provider notifies the terminal turn before
   * the turn/start response arrives.
   */
  turnStartSettled: Promise<void> = Promise.resolve();
  protocolFailed = false;
  protocolFailureCode: string | null = null;
  protocolFailureMessage: string | null = null;
  terminal = false;
  dispositionOnlyRecoveryAvailable = false;
  dispositionOnlyRecoveryConsumed = false;
  dispositionOnlyRecoveryTurnId: string | null = null;
  turnStarted = false;
  readonly terminalTurns = new Map<string, string>();
  readonly workspaceChangesByTurn = new Map<string, Record<string, unknown>>();
  readonly emittedFileReferences = new Set<string>();
  readonly itemChannels = new Map<
    string,
    "progress" | "final" | "summary" | "detail" | "unknown"
  >();
  readonly pendingRuntimeRequestMap = new Map<string, PendingRuntimeRequest>();
  readonly lineageByThread = new Map<string, HarnessThreadLineageEntry>();
  currentGoal: HarnessThreadGoal | null = null;
  interruptQueued = false;
  steerSequence = 0;
  readonly acknowledgedSteeringCorrelations = new Map<string, string>();
  interruptSequence = 0;

  constructor(input: {
    transport: CodexAppServerTransport;
    runId: string;
    normalizedSessionId: string;
    opened: OpenedCodexThread;
    taskEnvelope: CodexTaskEnvelope;
    conversationMode: "task" | "direct";
    resumed: boolean;
    activeTurnId?: string | null;
    semanticResult?: PersistedHarnessSemanticResult | null;
    terminalTurns?: PersistedHarnessTurnTerminal[];
    dispositionOnlyRecoveryConsumed?: boolean;
    dispositionOnlyRecoveryTurnId?: string | null;
    stalePendingRuntimeRequests?: HarnessRuntimeRequest[];
    lineage?: HarnessThreadLineageEntry[];
    goal?: HarnessThreadGoal | null;
    sourceSequence: number;
    now: () => Date;
    runnerInstanceId: string;
    driverKind: string;
    capabilities: CodexCapabilities;
    dynamicTools: readonly Readonly<Record<string, unknown>>[];
    dynamicToolHandler?: CodexAppServerDriverOptions["dynamicToolHandler"];
  }) {
    this.transport = input.transport;
    this.runId = input.runId;
    this.sourceSequence = 0;
    this.normalizedSessionId = input.normalizedSessionId;
    this.opened = input.opened;
    this.taskEnvelope = input.taskEnvelope;
    this.conversationMode = input.conversationMode;
    this.activeTurnId = input.activeTurnId ?? null;
    this.sourceSequence = input.sourceSequence;
    this.now = input.now;
    this.runnerInstanceId = input.runnerInstanceId;
    this.driverKind = input.driverKind;
    this.capabilities = input.capabilities;
    this.dynamicTools = input.dynamicTools;
    this.dynamicToolHandler = input.dynamicToolHandler;
    this.currentGoal = input.goal === undefined ? null : structuredClone(input.goal);
    for (const entry of input.lineage ?? [input.opened.lineage]) {
      this.lineageByThread.set(entry.threadId, structuredClone(entry));
    }
    if (!this.lineageByThread.has(input.opened.lineage.threadId)) {
      this.lineageByThread.set(
        input.opened.lineage.threadId,
        structuredClone(input.opened.lineage),
      );
    }
    if (input.semanticResult) {
      const validation = validatePrpStructuredRunResult(
        input.semanticResult.result,
      );
      if (
        !validation.ok ||
        canonicalJson(validation.result) !== input.semanticResult.fingerprint
      ) {
        throw new HarnessReconciliationError(
          "persisted semantic result fingerprint is invalid",
        );
      }
      this.result = structuredClone(validation.result);
      this.resultFingerprint = input.semanticResult.fingerprint;
      this.resultCallId = input.semanticResult.callId ?? null;
      this.resultTurnId = input.semanticResult.turnId;
    }
    for (const terminal of input.terminalTurns ?? []) {
      if (
        !terminal.turnId ||
        !terminal.fingerprint ||
        this.terminalTurns.has(terminal.turnId)
      ) {
        throw new HarnessReconciliationError(
          "persisted terminal turn fingerprints are invalid",
        );
      }
      this.terminalTurns.set(terminal.turnId, terminal.fingerprint);
    }
    if (this.activeTurnId && this.terminalTurns.has(this.activeTurnId)) {
      this.activeTurnId = null;
    }
    const dispositionOnlyRecoveryPreviouslyConsumed =
      input.dispositionOnlyRecoveryConsumed ?? false;
    const dispositionOnlyRecoveryTurnId =
      input.dispositionOnlyRecoveryTurnId ?? null;
    const settledSemanticResult =
      this.conversationMode === "task"
      && this.result !== null
      && this.resultTurnId !== null
      && this.terminalTurns.has(this.resultTurnId);
    const consumedResultlessRecovery =
      input.resumed
      && this.conversationMode === "task"
      && this.result === null
      && this.activeTurnId === null
      && dispositionOnlyRecoveryPreviouslyConsumed;
    // Once the one-shot disposition allowance was consumed, only affirmative
    // provider history can release it or recover its active turn. Missing or
    // malformed history is ambiguous, so a reconstructed session with no
    // active turn must remain closed to further provider submissions. A bound
    // terminal fingerprint is stronger completion evidence, but it is not
    // required to preserve ownership across an ambiguous crash boundary.
    this.terminal = settledSemanticResult || consumedResultlessRecovery;
    this.dispositionOnlyRecoveryAvailable =
      input.resumed &&
      this.conversationMode === "task" &&
      this.terminalTurns.size > 0 &&
      this.result === null &&
      !dispositionOnlyRecoveryPreviouslyConsumed;
    // Recovery itself does not consume the allowance. A checkpoint can occur
    // before startTurn, and consuming it here would strand the run if the
    // process crashed at that boundary. startTurn consumes it in memory; a
    // later recovery adopts provider evidence for an accepted, uncheckpointed
    // turn before deciding whether another submission is safe.
    this.dispositionOnlyRecoveryConsumed =
      dispositionOnlyRecoveryPreviouslyConsumed;
    this.dispositionOnlyRecoveryTurnId = dispositionOnlyRecoveryTurnId;
  }

  requireActiveTurn(turnId: string, operation: string): void {
    if (this.activeTurnId !== turnId) {
      this.emit("harness.diagnostic", {
        code: "stale_turn_rejected",
        operation,
        turnId,
        activeTurnId: this.activeTurnId,
        message: `Rejected ${operation} for a stale turn identity.`,
      });
      throw new HarnessStaleTurnError(turnId);
    }
  }

  cancelPendingRequests(reason: string): void {
    for (const pending of this.pendingRuntimeRequestMap.values()) {
      this.emit(
        pending.request.input === undefined ? "runtime_request.cancelled" : "runtime_request.expired",
        pending.request.input === undefined
          ? harnessRuntimeRequestOutcome(pending.request, { reason })
          : harnessRuntimeInputExpiredOutcome(pending.request, "provider_process_lost"),
        { turnId: pending.request.turnId, itemId: pending.request.itemId },
      );
      pending.settle(safeRequestResponse(pending.request.method, "cancel"));
    }
    this.pendingRuntimeRequestMap.clear();
  }

  expirePendingInputRequestsAfterProviderLoss(): void {
    for (const [requestId, pending] of this.pendingRuntimeRequestMap) {
      if (pending.request.input === undefined) continue;
      this.emit(
        "runtime_request.expired",
        harnessRuntimeInputExpiredOutcome(pending.request, "provider_process_lost"),
        { turnId: pending.request.turnId, itemId: pending.request.itemId },
      );
      pending.settle(safeRequestResponse(pending.request.method, "cancel"));
      this.pendingRuntimeRequestMap.delete(requestId);
    }
  }

  notificationNamesActiveTurn(turnId: string, kind: string): boolean {
    if (
      this.protocolFailed ||
      this.terminal ||
      turnId.length === 0 ||
      this.activeTurnId === null ||
      turnId !== this.activeTurnId
    ) {
      this.failProtocol(
        "turn_binding_mismatch",
        `Provider ${kind} did not name the active turn.`,
      );
      return false;
    }
    return true;
  }

  requireCapability(operation: keyof CodexCapabilities): void {
    if (!this.capabilities[operation])
      throw this.unsupported(operation, "capability not advertised");
  }

  unsupported(
    operation: string,
    detail: unknown,
  ): HarnessCapabilityUnavailableError {
    const error = new HarnessCapabilityUnavailableError(
      operation,
      redactCodexDiagnostic(String(detail)),
    );
    this.diagnoseUnsupported(operation, error.message);
    return error;
  }

  diagnoseUnsupported(
    operation: string,
    detail = "operation is not available",
  ): void {
    this.emit("harness.diagnostic", {
      code: "unsupported_operation",
      operation,
      message: redactCodexDiagnostic(detail),
    });
  }

  failProtocol(code: string, message: string): void {
    if (this.protocolFailed) return;
    this.protocolFailed = true;
    this.protocolFailureCode = code;
    this.protocolFailureMessage = redactCodexDiagnostic(message);
    this.cancelPendingRequests("protocol_failed");
    this.emit("session.failed", {
      code,
      message: redactCodexDiagnostic(message),
      recoverable: false,
    });
    if (!this.terminal && this.activeTurnId !== null) {
      const turnId = this.activeTurnId;
      this.emit(
        "turn.failed",
        { status: "failed", error: { code } },
        { turnId },
      );
      this.terminalTurns.set(turnId, canonicalJson({ protocolFailure: code }));
      this.activeTurnId = null;
    }
    this.terminal = true;
    this.eventQueue.close();
    void this.transport.close(`protocol_failure:${code}`);
  }

  emit(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown>,
    refs: { turnId?: string; itemId?: string } = {},
  ): void {
    const sourceSeq = ++this.sourceSequence;
    this.eventQueue.push({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.runnerInstanceId}:${this.runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: this.runnerInstanceId,
      sourceKind: "runner",
      runId: this.runId,
      normalizedSessionId: this.normalizedSessionId,
      ...(refs.turnId ? { turnId: refs.turnId } : {}),
      ...(refs.itemId ? { itemId: refs.itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: this.now().toISOString(),
      payload,
    });
  }
}

export type CodexSessionStateInput = ConstructorParameters<typeof CodexSessionState>[0];

export function initializeCodexSessionEvents(
  state: CodexSessionState,
  input: CodexSessionStateInput,
): void {
    state.emit(input.resumed ? "session.resumed" : "session.started", {
      driverSessionId: input.opened.threadId,
      providerSessionId: input.opened.providerSessionId,
      context: input.opened.context,
    });
    for (const stale of input.stalePendingRuntimeRequests ?? []) {
      state.emit(
        "runtime_request.cancelled",
        harnessRuntimeRequestOutcome(stale, { reason: "transport_recovered" }),
        { turnId: stale.turnId, itemId: stale.itemId },
      );
    }
    state.emit(
      "item.completed",
      {
        kind: "thread_lineage",
        text: `Root thread ${input.opened.threadId}`,
        lineage: input.opened.lineage,
      },
      { itemId: `thread:${input.opened.threadId}` },
    );
    state.emit(
      "item.completed",
      {
        kind: "model",
        text: `${input.opened.context.model} (${input.opened.context.modelProvider})`,
        model: {
          name: input.opened.context.model,
          provider: input.opened.context.modelProvider,
          codexVersion: input.opened.context.codexVersion,
        },
      },
      { itemId: `${input.opened.threadId}:model` },
    );
}
