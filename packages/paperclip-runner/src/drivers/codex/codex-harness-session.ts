import { randomUUID } from "node:crypto";

import type {
  HarnessGoalOperation,
  HarnessRuntimeRequest,
  HarnessRuntimeRequestHandoff,
  HarnessRuntimeRequestResolution,
  HarnessSession,
  HarnessThreadGoal,
  HarnessThreadLineageEntry,
  PersistedHarnessSession,
} from "../../contracts/harness-driver.js";
import {
  HarnessCapabilityUnavailableError,
  HarnessOperationAlreadyTerminalError,
  HarnessReconciliationError,
  HarnessStaleTurnError,
  harnessRuntimeInputExpiredOutcome,
  harnessRuntimeRequestOutcome,
  parseHarnessRuntimeRequestResolution,
} from "../../contracts/harness-driver.js";
import type { NativeUserMessage } from "../../contracts/types.js";
import {
  CODEX_RESULT_OUTPUT_SCHEMA,
  type CodexModelContextSnapshot,
} from "../../contracts/codex.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { boundedCodexPayload as boundedPayload } from "./codex-boundaries.js";
import {
  CodexRpcError,
  redactCodexDiagnostic,
} from "./app-server-transport.js";
import { runtimeRequestResponse } from "./codex-question-adapter.js";
import {
  CODEX_PLANNING_PERMISSION_PROFILE as PLANNING_PERMISSION_PROFILE,
  CODEX_SKILLLESS_PERMISSION_PROFILE as SKILLLESS_PERMISSION_PROFILE,
} from "./codex-security-config.js";
import {
  parseCodexThreadGoal as parseThreadGoal,
  safeCodexRequestResponse as safeRequestResponse,
} from "./codex-thread-normalization.js";
import {
  CodexSessionState,
  initializeCodexSessionEvents,
  type CodexSessionStateInput,
} from "./codex-session-state.js";
import { pumpNotifications } from "./codex-session-notifications.js";
import { handleServerRequest } from "./codex-session-server-requests.js";
import {
  mapTerminalTurn,
  terminalReplayConflict,
} from "./codex-session-terminal.js";
import { boundedText, record, text, userInput } from "./codex-driver-values.js";

export class CodexHarnessSession
  extends CodexSessionState
  implements HarnessSession
{
  constructor(input: CodexSessionStateInput) {
    super(input);
    this.transport.setServerRequestHandler((request) =>
      handleServerRequest(this, request),
    );
    initializeCodexSessionEvents(this, input);
    if (this.terminal) {
      this.eventQueue.close();
    } else {
      void pumpNotifications(this);
    }
  }

  ids(): ReturnType<HarnessSession["ids"]> {
    return {
      driverSessionId: this.opened.threadId,
      providerSessionId: this.opened.providerSessionId,
      displayId: this.opened.threadId,
    };
  }

  async attachRun(input: { runId: string }): Promise<void> {
    const transportOwnsQuiescence = this.transport.attachRun !== undefined;
    if (
      this.turnStartPending ||
      (!transportOwnsQuiescence &&
        (this.activeTurnId !== null || this.pendingRuntimeRequestMap.size > 0))
    ) {
      throw new Error("codex_run_attach_busy");
    }
    if (!input.runId) throw new Error("codex_run_attach_invalid");
    await this.transport.attachRun?.({
      runId: input.runId,
      turnId: `turn_attachment_${randomUUID().replaceAll("-", "")}`,
      itemId: `item_attachment_${randomUUID().replaceAll("-", "")}`,
    });
    if (transportOwnsQuiescence) {
      // Runnerd's attachment contract performs two durable readiness probes,
      // drains the settled provider tail, and rotates authority atomically.
      // Its proof supersedes host reducer state that can remain stale when a
      // semantic-result consumer stops before the interrupt terminal arrives.
      // Drop only the prior run's already-proven-settled buffered suffix.
      this.activeTurnId = null;
      this.pendingRuntimeRequestMap.clear();
      this.eventQueue.clear();
    }
    this.runId = input.runId;
    this.result = null;
    this.resultFingerprint = null;
    this.resultCallId = null;
    this.resultTurnId = null;
    this.dispositionOnlyRecoveryConsumed = false;
    this.dispositionOnlyRecoveryTurnId = null;
    this.terminal = false;
    this.terminalTurns.clear();
    this.turnStarted = false;
    this.protocolFailed = false;
    this.protocolFailureCode = null;
    this.protocolFailureMessage = null;
    this.emit("run.attached", { runId: input.runId, sameSession: true });
  }

  contextSnapshot(): CodexModelContextSnapshot {
    return structuredClone(this.opened.context);
  }

  events(): AsyncIterable<PrpEvent> {
    return this.eventQueue;
  }

  async startTurn(input: {
    message: NativeUserMessage;
    requestedCollaborationMode?: "default" | "plan";
  }): Promise<{
    turnId: string;
    effectiveCollaborationMode: "default" | "plan";
  }> {
    if (
      this.terminal ||
      this.protocolFailed ||
      this.activeTurnId !== null ||
      this.turnStartPending
    ) {
      throw this.unsupported(
        "turn start",
        this.protocolFailureCode === null
          ? "session cannot start another turn"
          : `session failed protocol validation: ${this.protocolFailureCode} (${this.protocolFailureMessage ?? "no detail"})`,
      );
    }
    const dispositionOnlyRecovery = this.dispositionOnlyRecoveryAvailable;
    const taskText =
      this.conversationMode === "direct"
        ? input.message.text
        : dispositionOnlyRecovery
          ? input.message.text
          : JSON.stringify({
              task: this.taskEnvelope,
              message: input.message.text,
            });
    const effectiveCollaborationMode = this.opened.context.collaborationMode;
    if (
      input.requestedCollaborationMode &&
      input.requestedCollaborationMode !== effectiveCollaborationMode
    ) {
      throw new Error(
        `collaboration_mode_mismatch: requested ${input.requestedCollaborationMode}, effective ${effectiveCollaborationMode}`,
      );
    }
    if (dispositionOnlyRecovery) {
      // Prevent a second submission in this process. The resulting accepted
      // turn id is checkpointed by orchestration; if the process dies before
      // that checkpoint, recoverSession adopts the provider-side turn.
      this.dispositionOnlyRecoveryAvailable = false;
      this.dispositionOnlyRecoveryConsumed = true;
      this.dispositionOnlyRecoveryTurnId = null;
    }
    // The submitted text is part of the canonical record so a tracer can show
    // the operator's own message without keeping shadow state next to the
    // reducer.
    this.emit("turn.submitted", {
      envelopeSchema: this.taskEnvelope.schema,
      text: input.message.text,
      requestedCollaborationMode:
        input.requestedCollaborationMode ?? effectiveCollaborationMode,
      effectiveCollaborationMode,
    });
    this.turnStartPending = true;
    let releaseTurnStartSettled: () => void = () => {};
    this.turnStartSettled = new Promise((resolve) => {
      releaseTurnStartSettled = resolve;
    });
    let response: Record<string, unknown>;
    const requestedMode = this.opened.context.collaborationMode;
    try {
      response = await this.transport.request("turn/start", {
        threadId: this.opened.threadId,
        cwd: this.opened.context.workingDirectory,
        permissions:
          requestedMode === "plan"
            ? PLANNING_PERMISSION_PROFILE
            : SKILLLESS_PERMISSION_PROFILE,
        runtimeWorkspaceRoots: [this.opened.context.workingDirectory],
        ...(this.opened.collaborationMode === null
          ? {}
          : { collaborationMode: this.opened.collaborationMode }),
        input: [userInput({ role: "user", text: taskText })],
        ...(this.conversationMode === "direct"
          ? {}
          : { outputSchema: CODEX_RESULT_OUTPUT_SCHEMA }),
      });
    } catch (error) {
      // A turn/started notification can arrive and mark a turn active while
      // turn/start is still pending. The turn/start request just rejected,
      // so no turn was accepted. Roll that optimistic state back so a
      // terminal notification for it cannot pass the active-turn check below
      // and release a terminal event for a turn that was never accepted.
      this.activeTurnId = null;
      this.turnStarted = false;
      if (dispositionOnlyRecovery) {
        if (error instanceof CodexRpcError) {
          // A JSON-RPC error is a definite provider rejection: no turn was
          // accepted, so the one-shot recovery allowance remains available.
          this.dispositionOnlyRecoveryAvailable = true;
          this.dispositionOnlyRecoveryConsumed = false;
          this.dispositionOnlyRecoveryTurnId = null;
        } else {
          // A transport failure is ambiguous. Recovery must inspect the
          // provider thread before deciding whether this submission landed.
          this.terminal = true;
        }
      }
      throw error;
    } finally {
      this.turnStartPending = false;
      // Release a terminal notification that arrived and parked itself
      // while this turn/start was in flight. This runs before turn.accepted
      // below, in the same synchronous continuation, so a released waiter
      // never observes the terminal turn ahead of turn.accepted.
      releaseTurnStartSettled();
    }
    const turn = record(response.turn);
    const turnId = text(turn.id);
    if (turnId.length === 0)
      throw new Error("Codex turn response omitted turn.id");
    if (this.activeTurnId !== null && this.activeTurnId !== turnId) {
      this.failProtocol(
        "turn_start_mismatch",
        "turn/start response disagreed with turn/started",
      );
      throw new Error("Codex turn identity changed during start");
    }
    this.activeTurnId ??= turnId;
    if (dispositionOnlyRecovery) {
      this.dispositionOnlyRecoveryTurnId = turnId;
    }
    this.emit("turn.accepted", { turnId }, { turnId });
    if (this.interruptQueued) {
      this.interruptQueued = false;
      await this.#sendInterrupt(turnId, "queued_before_start");
    }
    return {
      turnId,
      effectiveCollaborationMode,
    };
  }

  async steer(input: {
    turnId: string;
    message: NativeUserMessage;
    correlationId?: string;
  }): Promise<void> {
    this.requireCapability("steering");
    this.requireActiveTurn(input.turnId, "steering");
    if (input.correlationId) {
      const acknowledgedTurnId = this.acknowledgedSteeringCorrelations.get(
        input.correlationId,
      );
      if (acknowledgedTurnId) {
        if (acknowledgedTurnId !== input.turnId)
          throw new HarnessOperationAlreadyTerminalError("steering");
        return;
      }
    }
    try {
      await this.transport.request("turn/steer", {
        threadId: this.opened.threadId,
        input: [userInput(input.message)],
        expectedTurnId: input.turnId,
        correlationId: input.correlationId,
      });
      if (this.activeTurnId !== input.turnId) {
        throw new HarnessOperationAlreadyTerminalError("steering");
      }
      if (input.correlationId) {
        this.acknowledgedSteeringCorrelations.set(
          input.correlationId,
          input.turnId,
        );
      }
      this.emit(
        "item.completed",
        {
          kind: "steering_acknowledgement",
          text: "Steering acknowledged for the active turn.",
          status: "acknowledged",
        },
        {
          turnId: input.turnId,
          itemId: input.correlationId
            ? `${input.turnId}:steer:${input.correlationId}`
            : `${input.turnId}:steer:${++this.steerSequence}`,
        },
      );
    } catch (error) {
      if (error instanceof HarnessOperationAlreadyTerminalError) throw error;
      const detail = redactCodexDiagnostic(String(error));
      if (/unsupported|unavailable|capability|method not found/i.test(detail)) {
        throw this.unsupported("steering", detail);
      }
      // Steering rejection is a retryable operation failure, not evidence
      // that the provider lacks the capability. Preserve that distinction for
      // the control plane while keeping provider diagnostics redacted.
      throw new Error(detail);
    }
  }

  async interrupt(input: { turnId?: string; reason?: string }): Promise<void> {
    this.requireCapability("interruption");
    if (this.turnStartPending && this.activeTurnId === null) {
      this.interruptQueued = true;
      this.emit(
        "item.completed",
        {
          kind: "interrupt_acknowledgement",
          text: "Interrupt queued until the provider assigns the turn identity.",
          status: "queued",
        },
        { itemId: `interrupt:queued:${++this.interruptSequence}` },
      );
      return;
    }
    if (this.terminal || this.activeTurnId === null) {
      throw new HarnessOperationAlreadyTerminalError("interruption");
    }
    const turnId = input.turnId ?? this.activeTurnId;
    this.requireActiveTurn(turnId, "interruption");
    await this.#sendInterrupt(turnId, input.reason);
  }

  async #sendInterrupt(turnId: string, reason?: string): Promise<void> {
    try {
      await this.transport.request("turn/interrupt", {
        threadId: this.opened.threadId,
        turnId,
      });
      if (this.activeTurnId !== turnId) {
        throw new HarnessOperationAlreadyTerminalError("interruption");
      }
      this.emit(
        "item.completed",
        {
          kind: "interrupt_acknowledgement",
          text: "Interrupt accepted for the active turn.",
          status: "acknowledged",
          reason: boundedText(reason),
        },
        {
          turnId,
          itemId: `${turnId}:interrupt:${++this.interruptSequence}`,
        },
      );
    } catch (error) {
      if (error instanceof HarnessOperationAlreadyTerminalError) throw error;
      throw this.unsupported("interruption", error);
    }
  }

  pendingRuntimeRequests(): HarnessRuntimeRequest[] {
    return [...this.pendingRuntimeRequestMap.values()].map(({ request }) =>
      structuredClone(request),
    );
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    this.requireCapability("runtimeRequestResolution");
    const pending = this.pendingRuntimeRequestMap.get(input.requestId);
    if (pending === undefined) {
      throw new HarnessCapabilityUnavailableError(
        "runtime request resolution",
        `request ${input.requestId} is no longer pending`,
      );
    }
    if (
      pending.request.turnId !== input.turnId ||
      this.activeTurnId !== input.turnId
    ) {
      throw new HarnessStaleTurnError(input.turnId);
    }
    const resolution = parseHarnessRuntimeRequestResolution(
      pending.request.requestKind,
      input.resolution,
      pending.request.input,
    );
    if (pending.settlingResolution !== undefined) {
      throw new HarnessCapabilityUnavailableError(
        "runtime request resolution",
        `request ${input.requestId} is already settling`,
      );
    }
    pending.settlingResolution = structuredClone(resolution);
    const response = runtimeRequestResponse(
      pending.request,
      resolution,
      pending.responseContext,
    );
    try {
      await this.transport.resolveRuntimeRequest?.({
        requestId: input.requestId,
        turnId: input.turnId,
        resolution,
      });
    } catch (error) {
      if (this.pendingRuntimeRequestMap.get(input.requestId) === pending) {
        pending.settlingResolution = undefined;
      }
      throw error;
    }
    if (!this.pendingRuntimeRequestMap.delete(input.requestId)) return;
    this.emit(
      "runtime_request.resolved",
      harnessRuntimeRequestOutcome(pending.request, {
        action: resolution.action,
        ...(resolution.action === "submit" && "response" in resolution
          ? { response: resolution.response }
          : {}),
      }),
      { turnId: input.turnId, itemId: pending.request.itemId },
    );
    pending.settle(response);
  }

  handoffRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    reason: "durable_handoff";
    signal: AbortSignal;
  }): HarnessRuntimeRequestHandoff {
    if (input.signal.aborted) {
      return { result: "already_settled", cleanup: Promise.resolve() };
    }
    this.requireCapability("runtimeRequestResolution");
    const pending = this.pendingRuntimeRequestMap.get(input.requestId);
    if (
      pending === undefined ||
      pending.request.input === undefined ||
      pending.request.turnId !== input.turnId ||
      this.activeTurnId !== input.turnId ||
      pending.settlingResolution !== undefined
    )
      return { result: "already_settled", cleanup: Promise.resolve() };
    if (!this.pendingRuntimeRequestMap.delete(input.requestId)) {
      return { result: "already_settled", cleanup: Promise.resolve() };
    }
    this.emit(
      "runtime_request.expired",
      harnessRuntimeInputExpiredOutcome(pending.request, input.reason),
      { turnId: input.turnId, itemId: pending.request.itemId },
    );
    pending.settle(safeRequestResponse(pending.request.method, "cancel"));
    const cleanup = Promise.allSettled([
      Promise.resolve().then(() =>
        this.transport.resolveRuntimeRequest?.({
          requestId: input.requestId,
          turnId: input.turnId,
          resolution: { action: "cancel" },
        }),
      ),
      Promise.resolve().then(() =>
        this.transport.request("turn/interrupt", {
          threadId: this.opened.threadId,
          turnId: input.turnId,
        }),
      ),
    ]).then(() => undefined);
    return { result: "handed_off", cleanup };
  }

  async goal(input: HarnessGoalOperation): Promise<HarnessThreadGoal | null> {
    this.requireCapability("goals");
    let method: string;
    let params: Record<string, unknown> = { threadId: this.opened.threadId };
    if (input.action === "get") {
      method = "thread/goal/get";
    } else if (input.action === "clear") {
      method = "thread/goal/clear";
    } else {
      method = "thread/goal/set";
      if (input.action === "set") {
        params = {
          ...params,
          objective: input.objective,
          status: "active",
          ...(input.tokenBudget !== undefined
            ? { tokenBudget: input.tokenBudget }
            : {}),
        };
      } else {
        params = {
          ...params,
          status: input.action === "pause" ? "paused" : "active",
        };
      }
    }
    try {
      const response = await this.transport.request(method, params);
      const goal =
        input.action === "clear" ? null : parseThreadGoal(response.goal);
      if (!["get", "clear"].includes(input.action) && goal === null) {
        throw new Error(`${method} omitted its goal`);
      }
      this.currentGoal = goal;
      const kind = input.action === "clear" ? "goal_cleared" : "goal";
      this.emit(
        "item.completed",
        {
          kind,
          text:
            goal === null
              ? input.action === "clear"
                ? "Thread goal cleared."
                : "No thread goal is configured."
              : `Thread goal ${goal.status}: ${goal.objective}`,
          action: input.action,
          goal,
        },
        { itemId: `${this.opened.threadId}:goal:${this.sourceSequence + 1}` },
      );
      return goal === null ? null : structuredClone(goal);
    } catch (error) {
      throw this.unsupported(`goal ${input.action}`, error);
    }
  }

  lineage(): HarnessThreadLineageEntry[] {
    return [...this.lineageByThread.values()].map((entry) =>
      structuredClone(entry),
    );
  }

  async read(): Promise<Record<string, unknown>> {
    this.requireCapability("read");
    try {
      return await this.transport.request("thread/read", {
        threadId: this.opened.threadId,
        includeTurns: true,
      });
    } catch (error) {
      throw this.unsupported("read", error);
    }
  }

  async reconcile(): Promise<Record<string, unknown>> {
    this.requireCapability("reconciliation");
    const snapshot = await this.read();
    const thread = record(snapshot.thread);
    if (text(thread.id) !== this.opened.threadId) {
      throw new HarnessReconciliationError(
        "thread/read returned a different driver session",
      );
    }
    const providerSessionId = text(thread.sessionId);
    if (
      this.opened.providerSessionId !== null &&
      providerSessionId !== this.opened.providerSessionId
    ) {
      throw new HarnessReconciliationError(
        "thread/read returned a different provider session",
      );
    }
    const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : [];
    const reconciledUsage = boundedPayload(
      record(thread.tokenUsage ?? snapshot.tokenUsage),
    );
    if (Object.keys(reconciledUsage).length > 0)
      this.usageSnapshot = reconciledUsage;
    const activeTurns = turns.filter(
      (turn) => text(turn.status) === "inProgress",
    );
    const expectedTurnId = this.activeTurnId;
    const unexpectedActive = activeTurns.find(
      (turn) => text(turn.id) !== expectedTurnId,
    );
    if (unexpectedActive !== undefined) {
      throw new HarnessReconciliationError(
        `thread/read exposed active turn ${text(unexpectedActive.id)} instead of persisted active turn ${expectedTurnId ?? "none"}`,
      );
    }

    let reconciledTerminalTurnId: string | null = null;
    if (expectedTurnId !== null) {
      const expectedTurn = turns.find(
        (turn) => text(turn.id) === expectedTurnId,
      );
      if (expectedTurn === undefined) {
        throw new HarnessReconciliationError(
          `persisted active turn ${expectedTurnId} is missing from thread/read`,
        );
      }
      const status = text(expectedTurn.status);
      if (status === "inProgress") {
        this.activeTurnId = expectedTurnId;
      } else if (
        ["completed", "failed", "interrupted", "cancelled"].includes(status)
      ) {
        reconciledTerminalTurnId = expectedTurnId;
        mapTerminalTurn(this, expectedTurn, expectedTurnId, true);
      } else {
        throw new HarnessReconciliationError(
          `persisted active turn ${expectedTurnId} has unreconcilable status ${status || "missing"}`,
        );
      }
    }

    for (const [turnId, fingerprint] of this.terminalTurns) {
      const observed = turns.find((turn) => text(turn.id) === turnId);
      if (observed === undefined) continue;
      if (
        !["completed", "failed", "interrupted", "cancelled"].includes(
          text(observed.status),
        )
      ) {
        throw new HarnessReconciliationError(
          `previously terminal turn ${turnId} is no longer terminal in thread/read`,
        );
      }
      const conflict = terminalReplayConflict(this, observed, fingerprint);
      if (conflict !== null) {
        throw new HarnessReconciliationError(
          `previously terminal turn ${turnId} ${conflict.message}`,
        );
      }
    }
    this.emit("session.reconciled", {
      providerSessionId: this.opened.providerSessionId,
      turnCount: turns.length,
      activeTurnId: this.activeTurnId,
      terminalTurnId: reconciledTerminalTurnId,
    });
    return snapshot;
  }

  async usage(): Promise<Record<string, unknown> | null> {
    this.requireCapability("usage");
    return this.usageSnapshot === null
      ? null
      : structuredClone(this.usageSnapshot);
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: this.driverKind,
      driverSessionId: this.opened.threadId,
      providerSessionId: this.opened.providerSessionId,
      ...(this.opened.providerIdentity === undefined
        ? {}
        : { providerIdentity: structuredClone(this.opened.providerIdentity) }),
      runId: this.runId,
      normalizedSessionId: this.normalizedSessionId,
      activeTurnId: this.activeTurnId,
      semanticResult:
        this.result === null ||
        this.resultFingerprint === null ||
        this.resultTurnId === null
          ? null
          : {
              result: structuredClone(this.result),
              fingerprint: this.resultFingerprint,
              callId: this.resultCallId,
              turnId: this.resultTurnId,
            },
      terminalTurns: [...this.terminalTurns].map(([turnId, fingerprint]) => ({
        turnId,
        fingerprint,
      })),
      dispositionOnlyRecoveryConsumed: this.dispositionOnlyRecoveryConsumed,
      dispositionOnlyRecoveryTurnId: this.dispositionOnlyRecoveryTurnId,
      pendingRuntimeRequests: this.pendingRuntimeRequests(),
      goal:
        this.currentGoal === null ? null : structuredClone(this.currentGoal),
      lineage: this.lineage(),
      lastSourceSequence: this.sourceSequence,
    };
  }

  async close(input?: { reason: string }): Promise<void> {
    this.cancelPendingRequests("session_closed");
    this.eventQueue.close();
    await this.transport.close(input?.reason);
  }

  async detachControllerForRestart(): Promise<void> {
    if (this.transport.detachControllerForRestart === undefined) return;
    await this.transport.detachControllerForRestart();
  }
}
