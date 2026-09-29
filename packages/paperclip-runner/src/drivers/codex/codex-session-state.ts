import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { normalizedEventId, type EventEpochTransition } from "../../control-plane/event-epochs.js";
import { type CodexUsageBaseline, codexRunUsage } from "./codex-usage-baseline.js";
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
import { NativeSessionProtocolIntegrityError } from "../../contracts/native-session-backend.js";
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
  CodexGoalAvailability,
  OpenedCodexThread,
  PendingRuntimeRequest,
} from "./codex-driver-types.js";
import { canonicalJson, record } from "./codex-driver-values.js";
import { NormalizedDeliveryWriter } from "../../control-plane/normalized-delivery-writer.js";
import type { CodexRpcServerRequest } from "./app-server-transport.js";
import { createCodexQuestionResponseContext, normalizeCodexQuestionSet } from "./codex-question-adapter.js";
import { CodexHistoryMap, CodexHistorySet } from "./codex-history-cache.js";

const durableScalars = ["sourceSequence", "sourceSequenceEpoch", "activeTurnId", "usageSnapshot", "codexUsageBaseline", "result", "resultFingerprint", "resultCallId", "resultTurnId", "protocolFailed", "protocolFailureCode", "protocolFailureMessage", "terminal", "dispositionOnlyRecoveryAvailable", "dispositionOnlyRecoveryConsumed", "dispositionOnlyRecoveryTurnId", "turnStarted", "turnStartPending", "notificationIdentityDiagnostics", "currentGoal", "interruptQueued", "steerSequence", "interruptSequence", "durableTerminal"] as const;
const durableMaps = ["terminalTurns", "workspaceChangesByTurn", "itemChannels", "lineageByThread", "acknowledgedSteeringCorrelations"] as const;

class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }> = [];
  #closed = false;
  #failure: Error | null = null;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter.resolve({ value, done: false });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0))
      waiter.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    this.#failure ??= error;
    this.#closed = true;
    // Integrity failure takes precedence over a buffered semantic/terminal
    // suffix, including one whose consumer has not started reading yet.
    this.#values = [];
    for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#failure);
  }

  clear(): void {
    this.#values = [];
  }

  discard(predicate: (value: T) => boolean): void {
    this.#values = this.#values.filter((value) => !predicate(value));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.#failure !== null) throw this.#failure;
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve, reject) =>
          this.#waiters.push({ resolve, reject }),
        );
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
  readonly goalCapability: NonNullable<
    CodexAppServerDriverOptions["goalCapability"]
  >;
  readonly goalAvailability: CodexGoalAvailability;
  readonly goalReasonCode: string | null;
  readonly goalReason: string | null;
  readonly skillInputs: NonNullable<CodexAppServerDriverOptions["skillInputs"]>;
  readonly dynamicTools: readonly Readonly<Record<string, unknown>>[];
  readonly completionFeedback: CodexAppServerDriverOptions["completionFeedback"];
  readonly dynamicToolHandler: CodexAppServerDriverOptions["dynamicToolHandler"];
  readonly eventQueue = new AsyncQueue<PrpEvent>();
  deliveryWriter: NormalizedDeliveryWriter | null = null;
  deliveryRestored = false;
  durableTerminal: { event: PrpEvent; semanticFingerprint: string | null } | null = null;
  readonly pendingRuntimeRequestSources = new Map<string, CodexRpcServerRequest>();
  sourceSequence: number;
  sourceSequenceEpoch: string | null = null;
  readonly capturedEventIds = new AsyncLocalStorage<string[]>();
  activeTurnId: string | null;
  usageSnapshot: Record<string, unknown> | null = null;
  codexUsageBaseline: CodexUsageBaseline | null = null;
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
  protocolIntegrityFailure: NativeSessionProtocolIntegrityError | null = null;
  terminal = false;
  dispositionOnlyRecoveryAvailable = false;
  dispositionOnlyRecoveryConsumed = false;
  dispositionOnlyRecoveryTurnId: string | null = null;
  turnStarted = false;
  terminalTurns: Map<string, string> = new Map();
  readonly workspaceChangesByTurn = new Map<string, Record<string, unknown>>();
  emittedFileReferences: Set<string> | CodexHistorySet = new Set();
  readonly itemChannels = new Map<
    string,
    "progress" | "final" | "summary" | "detail" | "unknown"
  >();
  readonly pendingRuntimeRequestMap = new Map<string, PendingRuntimeRequest>();
  notificationIdentityDiagnostics = 0;
  lineageByThread: Map<string, HarnessThreadLineageEntry> = new Map();
  currentGoal: HarnessThreadGoal | null = null;
  interruptQueued = false;
  steerSequence = 0;
  acknowledgedSteeringCorrelations: Map<string, string> = new Map();
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
    codexUsageBaseline?: CodexUsageBaseline;
    dispositionOnlyRecoveryConsumed?: boolean;
    dispositionOnlyRecoveryTurnId?: string | null;
    stalePendingRuntimeRequests?: HarnessRuntimeRequest[];
    lineage?: HarnessThreadLineageEntry[];
    goal?: HarnessThreadGoal | null;
    sourceSequence: number;
    sourceEpoch?: string;
    now: () => Date;
    runnerInstanceId: string;
    driverKind: string;
    capabilities: CodexCapabilities;
    goalCapability: NonNullable<CodexAppServerDriverOptions["goalCapability"]>;
    goalAvailability: CodexGoalAvailability;
    goalReasonCode: string | null;
    goalReason: string | null;
    skillInputs?: CodexAppServerDriverOptions["skillInputs"];
    dynamicTools: readonly Readonly<Record<string, unknown>>[];
    completionFeedback?: CodexAppServerDriverOptions["completionFeedback"];
    dynamicToolHandler?: CodexAppServerDriverOptions["dynamicToolHandler"];
  }) {
    this.codexUsageBaseline = input.codexUsageBaseline ?? null;
    if (this.codexUsageBaseline) this.usageSnapshot = codexRunUsage(this.codexUsageBaseline);
    this.transport = input.transport;
    this.runId = input.runId;
    this.sourceSequence = 0;
    this.normalizedSessionId = input.normalizedSessionId;
    this.opened = input.opened;
    this.taskEnvelope = input.taskEnvelope;
    this.conversationMode = input.conversationMode;
    this.activeTurnId = input.activeTurnId ?? null;
    this.sourceSequence = input.sourceSequence;
    this.sourceSequenceEpoch = input.sourceEpoch ?? null;
    this.now = input.now;
    this.runnerInstanceId = input.runnerInstanceId;
    this.driverKind = input.driverKind;
    this.capabilities = input.capabilities;
    this.goalCapability = input.goalCapability;
    this.goalAvailability = input.goalAvailability;
    this.goalReasonCode = input.goalReasonCode;
    this.goalReason = input.goalReason;
    this.skillInputs = structuredClone(input.skillInputs ?? []);
    this.dynamicTools = input.dynamicTools;
    this.dynamicToolHandler = input.dynamicToolHandler;
    this.completionFeedback = input.completionFeedback;
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
    this.initializeDelivery();
  }

  initializeDelivery(): void {
    const port = this.transport.normalizedDelivery?.();
    if (!port) return;
    const saved = port.load();
    if (saved) {
      const state = saved.driver;
      if (state.schema !== "paperclip.codex.reducer.v1" || state.runId !== this.runId || state.sessionId !== this.normalizedSessionId || state.threadId !== this.opened.threadId) throw new HarnessReconciliationError("normalized reducer binding mismatch");
      const scalars = record(state.scalars);
      for (const key of durableScalars) {
        if (key === "sourceSequenceEpoch" && !(key in scalars)) continue; // Retained pre-epoch reducer.
        if (!(key in scalars)) throw new HarnessReconciliationError(`normalized reducer lacks ${key}`);
        (this as unknown as Record<string, unknown>)[key] = structuredClone(scalars[key]);
      }
      if (this.sourceSequence !== saved.produced || (this.sourceSequenceEpoch ?? undefined) !== saved.producedEpoch) throw new HarnessReconciliationError("normalized reducer cursor mismatch");
      for (const key of durableMaps) {
        const entries = state[key];
        if (!Array.isArray(entries)) throw new HarnessReconciliationError(`normalized reducer lacks ${key}`);
        const target = this[key] as Map<string, unknown>;
        target.clear();
        for (const [id, value] of entries) target.set(id, structuredClone(value));
      }
      this.emittedFileReferences.clear();
      if (!Array.isArray(state.emittedFileReferences) || !Array.isArray(state.pendingRequests)) throw new HarnessReconciliationError("invalid normalized reducer collections");
      for (const id of state.emittedFileReferences) this.emittedFileReferences.add(id);
      for (const pending of state.pendingRequests) {
        const request = pending.request as HarnessRuntimeRequest;
        const source = pending.source as CodexRpcServerRequest;
        if (!source || String(source.id) !== request.requestId || source.method !== request.method) throw new HarnessReconciliationError("normalized runtime request binding mismatch");
        const responseContext = createCodexQuestionResponseContext();
        normalizeCodexQuestionSet(source.method, source.params, responseContext);
        this.pendingRuntimeRequestSources.set(request.requestId, source);
        // Runnerd owns resolution delivery; the vanished controller's JS
        // promise grants no authority and needs no reconstructed callback.
        this.pendingRuntimeRequestMap.set(request.requestId, { request, responseContext, settle: () => {} });
      }
      this.deliveryRestored = true;
    }
    if (port.history) {
      this.lineageByThread = new CodexHistoryMap("lineage", port.history, this.lineageByThread, saved !== null || this.lineageByThread instanceof CodexHistoryMap,
        ({ threadId, providerSessionId, parentThreadId, depth }) => ({ threadId, providerSessionId, parentThreadId, depth }),
        (value) => ({ ...value as Pick<HarnessThreadLineageEntry, "threadId" | "providerSessionId" | "parentThreadId" | "depth">, nickname: null, role: null, status: "unknown" }));
      this.terminalTurns = new CodexHistoryMap("terminal", port.history, this.terminalTurns, saved !== null);
      this.acknowledgedSteeringCorrelations = new CodexHistoryMap("steering", port.history, this.acknowledgedSteeringCorrelations, saved !== null || this.acknowledgedSteeringCorrelations instanceof CodexHistoryMap);
      this.emittedFileReferences = new CodexHistorySet(port.history, this.emittedFileReferences, saved !== null || this.emittedFileReferences instanceof CodexHistorySet);
    }
    this.deliveryWriter = new NormalizedDeliveryWriter(port, () => this.deliveryCheckpoint(), (event) => this.eventQueue.push(event), (error) => {
      this.eventQueue.fail(error);
      void this.transport.detachControllerForRestart?.().catch(() => undefined);
    }, () => [
      ...(this.lineageByThread instanceof CodexHistoryMap ? this.lineageByThread.takeReceipts() : []),
      ...(this.terminalTurns instanceof CodexHistoryMap ? this.terminalTurns.takeReceipts() : []),
      ...(this.acknowledgedSteeringCorrelations instanceof CodexHistoryMap ? this.acknowledgedSteeringCorrelations.takeReceipts() : []),
      ...(this.emittedFileReferences instanceof CodexHistorySet ? this.emittedFileReferences.map.takeReceipts() : []),
    ]);
  }

  async prefetchHistory(collection: "terminal" | "file" | "steering" | "lineage", keys: string[]): Promise<void> {
    const cache = collection === "lineage" ? this.lineageByThread : collection === "terminal" ? this.terminalTurns : collection === "steering" ? this.acknowledgedSteeringCorrelations
      : this.emittedFileReferences instanceof CodexHistorySet ? this.emittedFileReferences.map : null;
    if (!(cache instanceof CodexHistoryMap)) return;
    await this.deliveryWriter?.flush();
    await cache.prefetch(keys);
  }

  deliveryCheckpoint(): Record<string, unknown> {
    for (const id of this.pendingRuntimeRequestSources.keys()) if (!this.pendingRuntimeRequestMap.has(id)) this.pendingRuntimeRequestSources.delete(id);
    return JSON.parse(JSON.stringify({
      schema: "paperclip.codex.reducer.v1", runId: this.runId, sessionId: this.normalizedSessionId, threadId: this.opened.threadId,
      scalars: Object.fromEntries(durableScalars.map((key) => [key, this[key]])),
      ...Object.fromEntries(durableMaps.map((key) => [key, [...this[key]]])),
      emittedFileReferences: [...this.emittedFileReferences],
      pendingRequests: [...this.pendingRuntimeRequestMap].map(([id, pending]) => ({ request: pending.request, source: this.pendingRuntimeRequestSources.get(id) })),
    })) as Record<string, unknown>;
  }

  publishEvent(event: PrpEvent): void {
    this.capturedEventIds.getStore()?.push(event.sourceEventId);
    if (["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType)) this.durableTerminal = {
      event: JSON.parse(JSON.stringify(event)) as PrpEvent, semanticFingerprint: this.resultFingerprint,
    };
    if (this.deliveryWriter) this.deliveryWriter.emit(event);
    else this.eventQueue.push(event);
  }

  closeEvents(): void {
    if (!this.deliveryWriter) this.eventQueue.close();
    else void Promise.resolve().then(() => this.deliveryWriter!.flush()).then(() => this.eventQueue.close(), (error) => this.eventQueue.fail(error));
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
    this.rethrowProtocolIntegrity(detail);
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

  assertProtocolIntegrity(): void {
    if (this.protocolIntegrityFailure !== null)
      throw this.protocolIntegrityFailure;
  }

  rethrowProtocolIntegrity(error: unknown): void {
    if (!(error instanceof NativeSessionProtocolIntegrityError)) return;
    this.failProtocolIntegrity(error);
    this.assertProtocolIntegrity();
  }

  failProtocolIntegrity(error: NativeSessionProtocolIntegrityError): void {
    this.protocolIntegrityFailure ??= error;
    this.protocolFailed = true;
    this.protocolFailureCode = this.protocolIntegrityFailure.code;
    this.protocolFailureMessage = this.protocolIntegrityFailure.message;
    this.terminal = true;
    this.result = null;
    this.resultFingerprint = null;
    this.resultCallId = null;
    this.resultTurnId = null;
    // Fail the stream before settling pending local RPCs: a synthetic input
    // expiration or terminal event must not turn corruption into a safe wait.
    this.eventQueue.fail(this.protocolIntegrityFailure);
    this.cancelPendingRequests("protocol_integrity_failed");
    // The owning runtime still performs and awaits exact transport cleanup.
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
        { status: "failed", error: { code, message: this.protocolFailureMessage, recoverable: false } },
        { turnId },
      );
      this.terminalTurns.set(turnId, canonicalJson({ protocolFailure: code }));
      this.activeTurnId = null;
    }
    this.terminal = true;
    this.closeEvents();
    // Notification failure can initiate cleanup before the owning runtime joins
    // it. Observe this background rejection immediately so a deleted remote
    // sandbox cannot crash the controller. The transport retains its original
    // close promise: the owner's awaited session.close still receives any
    // cleanup failure and must not treat it as confirmed termination.
    void this.transport.close(`protocol_failure:${code}`).catch(() => undefined);
  }

  private allocateSource(): Pick<PrpEvent, "sourceEventId" | "sourceSeq" | "sourceEpoch" | "sourceEpochTransition"> {
    const limit = this.deliveryWriter?.port.eventEpochs?.limit;
    let transition: EventEpochTransition | undefined;
    if (limit !== undefined && this.sourceSequence >= limit) {
      transition = { schema: "paperclip.prp.event-epoch.v1", runId: this.runId, transitionId: randomUUID(),
        fromEpoch: this.sourceSequenceEpoch, nextEpoch: randomUUID(), finalOrdinal: this.sourceSequence };
      this.sourceSequenceEpoch = transition.nextEpoch;
      this.sourceSequence = 0;
    }
    if (!Number.isSafeInteger(this.sourceSequence) || this.sourceSequence >= Number.MAX_SAFE_INTEGER) throw new HarnessReconciliationError("normalized source sequence requires epoch support");
    const sourceSeq = ++this.sourceSequence;
    return { sourceEventId: normalizedEventId(this.runnerInstanceId, this.runId, sourceSeq, this.sourceSequenceEpoch ?? undefined), sourceSeq,
      ...(this.sourceSequenceEpoch ? { sourceEpoch: this.sourceSequenceEpoch } : {}), ...(transition ? { sourceEpochTransition: transition } : {}) };
  }

  emit(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown>,
    refs: { turnId?: string; itemId?: string } = {},
  ): void {
    const source = this.allocateSource();
    this.publishEvent({
      schema: "paperclip.prp.event.v1",
      ...source,
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

  emitGoalCapabilities(): void {
    this.emitV2("session.capabilities.updated", {
      sessionGoals:
        this.goalAvailability === "available" && this.capabilities.goals
          ? {
              availability: "available",
              actions: [...this.goalCapability.actions],
              autonomousUpdates: this.goalCapability.autonomousUpdates,
              persistentAcrossResume:
                this.goalCapability.persistentAcrossResume,
              maxObjectiveChars: this.goalCapability.maxObjectiveChars,
              tokenBudgetControl: this.goalCapability.tokenBudgetControl,
              usageReporting: this.goalCapability.usageReporting,
            }
          : {
              availability: this.goalAvailability,
              actions: [],
              autonomousUpdates: false,
              persistentAcrossResume: false,
              maxObjectiveChars: 4_000,
              tokenBudgetControl: false,
              usageReporting: false,
              reasonCode:
                this.goalReasonCode ?? "codex_goal_api_unavailable",
              reason:
                this.goalReason
                ?? "This Codex app-server does not expose thread goals.",
            },
    });
  }

  emitGoalEvent(
    eventType:
      | "session.goal.snapshot"
      | "session.goal.updated"
      | "session.goal.cleared",
    goal: HarnessThreadGoal | null,
    extra: Record<string, unknown> = {},
  ): void {
    this.emitV2(eventType, {
      goal:
        goal === null
          ? null
          : normalizedGoalSnapshot(goal, this.activeTurnId !== null),
      ...extra,
    });
  }

  private emitV2(
    eventType:
      | "session.capabilities.updated"
      | "session.goal.snapshot"
      | "session.goal.updated"
      | "session.goal.cleared",
    payload: Record<string, unknown>,
  ): void {
    const source = this.allocateSource();
    this.publishEvent({
      schema: "paperclip.prp.event.v2",
      ...source,
      sourceInstanceId: this.runnerInstanceId,
      sourceKind: "runner",
      runId: this.runId,
      normalizedSessionId: this.normalizedSessionId,
      ...(this.activeTurnId ? { turnId: this.activeTurnId } : {}),
      eventType,
      schemaVersion: 2,
      priority: 0,
      emittedAt: this.now().toISOString(),
      payload,
    } as PrpEvent);
  }
}

function normalizedGoalSnapshot(
  goal: HarnessThreadGoal,
  workingNow: boolean,
): Record<string, unknown> {
  const isoTimestamp = (value: number): string | null => {
    if (!Number.isFinite(value) || value <= 0) return null;
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const status =
    goal.status === "usageLimited"
      ? "usage_limited"
      : goal.status === "budgetLimited"
        ? "budget_limited"
        : goal.status;
  return {
    objective: goal.objective,
    status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    elapsedSeconds: goal.timeUsedSeconds,
    iterations: 0,
    lastReason: null,
    createdAt: isoTimestamp(goal.createdAt),
    updatedAt: isoTimestamp(goal.updatedAt),
    completedAt: goal.status === "complete" ? isoTimestamp(goal.updatedAt) : null,
    workingNow,
  };
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
    state.emitGoalCapabilities();
    state.emitGoalEvent("session.goal.snapshot", state.currentGoal, {
      workingNow: state.activeTurnId !== null,
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
