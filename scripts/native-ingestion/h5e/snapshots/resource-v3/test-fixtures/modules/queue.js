import { codexRunUsage } from "./codex-usage-baseline.js";
import { HarnessCapabilityUnavailableError, HarnessReconciliationError, HarnessStaleTurnError, harnessRuntimeInputExpiredOutcome, harnessRuntimeRequestOutcome, } from "../../contracts/harness-driver.js";
import { NativeSessionProtocolIntegrityError } from "../../contracts/native-session-backend.js";
import { validatePrpStructuredRunResult, } from "../../protocol/replay-contract.js";
import { redactCodexDiagnostic } from "./app-server-transport.js";
import { safeCodexRequestResponse as safeRequestResponse } from "./codex-thread-normalization.js";
import { canonicalJson } from "./codex-driver-values.js";
class AsyncQueue {
    #values = [];
    #waiters = [];
    #closed = false;
    #failure = null;
    push(value) {
        if (this.#closed)
            return;
        const waiter = this.#waiters.shift();
        if (waiter === undefined)
            this.#values.push(value);
        else
            waiter.resolve({ value, done: false });
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        for (const waiter of this.#waiters.splice(0))
            waiter.resolve({ value: undefined, done: true });
    }
    fail(error) {
        this.#failure ??= error;
        this.#closed = true;
        // Integrity failure takes precedence over a buffered semantic/terminal
        // suffix, including one whose consumer has not started reading yet.
        this.#values = [];
        for (const waiter of this.#waiters.splice(0))
            waiter.reject(this.#failure);
    }
    clear() {
        this.#values = [];
    }
    [Symbol.asyncIterator]() {
        return {
            next: async () => {
                if (this.#failure !== null)
                    throw this.#failure;
                const value = this.#values.shift();
                if (value !== undefined)
                    return { value, done: false };
                if (this.#closed)
                    return { value: undefined, done: true };
                return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
            },
        };
    }
}
export class CodexSessionState {
    transport;
    runId;
    normalizedSessionId;
    opened;
    taskEnvelope;
    conversationMode;
    now;
    runnerInstanceId;
    driverKind;
    capabilities;
    goalCapability;
    goalAvailability;
    goalReasonCode;
    goalReason;
    skillInputs;
    reasoningEffort;
    diagnosticEnvironment;
    dynamicTools;
    completionFeedback;
    dynamicToolHandler;
    eventQueue = new AsyncQueue();
    sourceSequence;
    activeTurnId;
    usageSnapshot = null;
    codexUsageBaseline = null;
    result = null;
    resultFingerprint = null;
    normalizeReplayPayload;
    resultCallId = null;
    resultTurnId = null;
    turnStartPending = false;
    pendingRunAttachment = null;
    /**
     * Resolves once a pending turn/start settles, on the accepted path or on a
     * provider rejection. A terminal notification for that turn must wait on
     * this promise, so turn.accepted always precedes any terminal event for
     * the same turn even when the provider notifies the terminal turn before
     * the turn/start response arrives.
     */
    turnStartSettled = Promise.resolve();
    protocolFailed = false;
    protocolFailureCode = null;
    protocolFailureMessage = null;
    protocolIntegrityFailure = null;
    terminal = false;
    dispositionOnlyRecoveryAvailable = false;
    dispositionOnlyRecoveryConsumed = false;
    dispositionOnlyRecoveryTurnId = null;
    turnStarted = false;
    terminalTurns = new Map();
    workspaceChangesByTurn = new Map();
    emittedFileReferences = new Set();
    itemChannels = new Map();
    pendingRuntimeRequestMap = new Map();
    notificationIdentityDiagnostics = 0;
    lineageByThread = new Map();
    currentGoal = null;
    interruptQueued = false;
    steerSequence = 0;
    acknowledgedSteeringCorrelations = new Map();
    interruptSequence = 0;
    constructor(input) {
        this.codexUsageBaseline = input.codexUsageBaseline ?? null;
        if (this.codexUsageBaseline)
            this.usageSnapshot = codexRunUsage(this.codexUsageBaseline);
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
        this.goalCapability = input.goalCapability;
        this.goalAvailability = input.goalAvailability;
        this.goalReasonCode = input.goalReasonCode;
        this.goalReason = input.goalReason;
        this.skillInputs = structuredClone(input.skillInputs ?? []);
        this.reasoningEffort = input.reasoningEffort;
        this.diagnosticEnvironment = input.diagnosticEnvironment ?? {};
        this.dynamicTools = input.dynamicTools;
        this.dynamicToolHandler = input.dynamicToolHandler;
        this.completionFeedback = input.completionFeedback;
        this.currentGoal = input.goal === undefined ? null : structuredClone(input.goal);
        for (const entry of input.lineage ?? [input.opened.lineage]) {
            this.lineageByThread.set(entry.threadId, structuredClone(entry));
        }
        if (!this.lineageByThread.has(input.opened.lineage.threadId)) {
            this.lineageByThread.set(input.opened.lineage.threadId, structuredClone(input.opened.lineage));
        }
        this.normalizeReplayPayload = input.normalizeReplayPayload;
        if (input.semanticResult) {
            const validation = validatePrpStructuredRunResult(input.semanticResult.result);
            if (!validation.ok ||
                canonicalJson(validation.result) !== input.semanticResult.fingerprint) {
                throw new HarnessReconciliationError("persisted semantic result fingerprint is invalid");
            }
            this.result = structuredClone(validation.result);
            this.resultFingerprint = input.semanticResult.fingerprint;
            this.resultCallId = input.semanticResult.callId ?? null;
            this.resultTurnId = input.semanticResult.turnId;
        }
        for (const terminal of input.terminalTurns ?? []) {
            if (!terminal.turnId ||
                !terminal.fingerprint ||
                this.terminalTurns.has(terminal.turnId)) {
                throw new HarnessReconciliationError("persisted terminal turn fingerprints are invalid");
            }
            this.terminalTurns.set(terminal.turnId, terminal.fingerprint);
        }
        if (this.activeTurnId && this.terminalTurns.has(this.activeTurnId)) {
            this.activeTurnId = null;
        }
        const dispositionOnlyRecoveryPreviouslyConsumed = input.dispositionOnlyRecoveryConsumed ?? false;
        const dispositionOnlyRecoveryTurnId = input.dispositionOnlyRecoveryTurnId ?? null;
        const settledSemanticResult = this.conversationMode === "task"
            && this.result !== null
            && this.resultTurnId !== null
            && this.terminalTurns.has(this.resultTurnId);
        const consumedResultlessRecovery = input.resumed
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
    requireActiveTurn(turnId, operation) {
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
    cancelPendingRequests(reason) {
        for (const pending of this.pendingRuntimeRequestMap.values()) {
            this.emit(pending.request.input === undefined ? "runtime_request.cancelled" : "runtime_request.expired", pending.request.input === undefined
                ? harnessRuntimeRequestOutcome(pending.request, { reason })
                : harnessRuntimeInputExpiredOutcome(pending.request, "provider_process_lost"), { turnId: pending.request.turnId, itemId: pending.request.itemId });
            pending.settle(safeRequestResponse(pending.request.method, "cancel"));
        }
        this.pendingRuntimeRequestMap.clear();
    }
    expirePendingInputRequestsAfterProviderLoss() {
        for (const [requestId, pending] of this.pendingRuntimeRequestMap) {
            if (pending.request.input === undefined)
                continue;
            this.emit("runtime_request.expired", harnessRuntimeInputExpiredOutcome(pending.request, "provider_process_lost"), { turnId: pending.request.turnId, itemId: pending.request.itemId });
            pending.settle(safeRequestResponse(pending.request.method, "cancel"));
            this.pendingRuntimeRequestMap.delete(requestId);
        }
    }
    notificationNamesActiveTurn(turnId, kind) {
        if (this.protocolFailed ||
            this.terminal ||
            turnId.length === 0 ||
            this.activeTurnId === null ||
            turnId !== this.activeTurnId) {
            this.failProtocol("turn_binding_mismatch", `Provider ${kind} did not name the active turn.`);
            return false;
        }
        return true;
    }
    requireCapability(operation) {
        if (!this.capabilities[operation])
            throw this.unsupported(operation, "capability not advertised");
    }
    unsupported(operation, detail) {
        this.rethrowProtocolIntegrity(detail);
        const error = new HarnessCapabilityUnavailableError(operation, redactCodexDiagnostic(String(detail)));
        this.diagnoseUnsupported(operation, error.message);
        return error;
    }
    diagnoseUnsupported(operation, detail = "operation is not available") {
        this.emit("harness.diagnostic", {
            code: "unsupported_operation",
            operation,
            message: redactCodexDiagnostic(detail),
        });
    }
    assertProtocolIntegrity() {
        if (this.protocolIntegrityFailure !== null)
            throw this.protocolIntegrityFailure;
    }
    rethrowProtocolIntegrity(error) {
        if (!(error instanceof NativeSessionProtocolIntegrityError))
            return;
        this.failProtocolIntegrity(error);
        this.assertProtocolIntegrity();
    }
    failProtocolIntegrity(error) {
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
    failProtocol(code, message) {
        if (this.protocolFailed)
            return;
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
            this.emit("turn.failed", { status: "failed", error: { code, message: this.protocolFailureMessage, recoverable: false } }, { turnId });
            this.terminalTurns.set(turnId, canonicalJson({ protocolFailure: code }));
            this.activeTurnId = null;
        }
        this.terminal = true;
        this.eventQueue.close();
        // Notification failure can initiate cleanup before the owning runtime joins
        // it. Observe this background rejection immediately so a deleted remote
        // sandbox cannot crash the controller. The transport retains its original
        // close promise: the owner's awaited session.close still receives any
        // cleanup failure and must not treat it as confirmed termination.
        void this.transport.close(`protocol_failure:${code}`).catch(() => undefined);
    }
    emit(eventType, payload, refs = {}) {
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
            priority: eventType === "run.result.proposed" || eventType === "auth.credentials.updated" ? 0 : 1,
            emittedAt: this.now().toISOString(),
            payload,
        });
    }
    emitGoalCapabilities() {
        this.emitV2("session.capabilities.updated", {
            sessionGoals: this.goalAvailability === "available" && this.capabilities.goals
                ? {
                    availability: "available",
                    actions: [...this.goalCapability.actions],
                    autonomousUpdates: this.goalCapability.autonomousUpdates,
                    persistentAcrossResume: this.goalCapability.persistentAcrossResume,
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
                    reasonCode: this.goalReasonCode ?? "codex_goal_api_unavailable",
                    reason: this.goalReason
                        ?? "This Codex app-server does not expose thread goals.",
                },
        });
    }
    emitGoalEvent(eventType, goal, extra = {}) {
        this.emitV2(eventType, {
            goal: goal === null
                ? null
                : normalizedGoalSnapshot(goal, this.activeTurnId !== null),
            ...extra,
        });
    }
    emitV2(eventType, payload) {
        const sourceSeq = ++this.sourceSequence;
        this.eventQueue.push({
            schema: "paperclip.prp.event.v2",
            sourceEventId: `${this.runnerInstanceId}:${this.runId}:${sourceSeq}`,
            sourceSeq,
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
        });
    }
}
function normalizedGoalSnapshot(goal, workingNow) {
    const isoTimestamp = (value) => {
        if (!Number.isFinite(value) || value <= 0)
            return null;
        const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
        const date = new Date(milliseconds);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };
    const status = goal.status === "usageLimited"
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
export function initializeCodexSessionEvents(state, input) {
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
        state.emit("runtime_request.cancelled", harnessRuntimeRequestOutcome(stale, { reason: "transport_recovered" }), { turnId: stale.turnId, itemId: stale.itemId });
    }
    state.emit("item.completed", {
        kind: "thread_lineage",
        text: `Root thread ${input.opened.threadId}`,
        lineage: input.opened.lineage,
    }, { itemId: `thread:${input.opened.threadId}` });
    state.emit("item.completed", {
        kind: "model",
        text: `${input.opened.context.model} (${input.opened.context.modelProvider})`,
        model: {
            name: input.opened.context.model,
            provider: input.opened.context.modelProvider,
            codexVersion: input.opened.context.codexVersion,
        },
    }, { itemId: `${input.opened.threadId}:model` });
}
//# sourceMappingURL=codex-session-state.js.map