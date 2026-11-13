import { HarnessReconciliationError } from "../../contracts/harness-driver.js";
import { readProviderFailure } from "../../contracts/provider-failure.generated.js";
import { codexProviderFailure } from "./provider-failure.js";
import { isNativeRestartInterruption } from "../../contracts/native-session-backend.js";
import type { PrpStructuredRunResult } from "../../protocol/replay-contract.js";
import { boundedCodexPayload as boundedPayload, isRetainableCodexPayload } from "./codex-boundaries.js";
import type { CodexSessionState } from "./codex-session-state.js";
import type {
  SemanticResultAdmission,
  TerminalReplayConflict,
} from "./codex-driver-types.js";
import {
  RUNNERD_CANONICAL_ITEM,
  canonicalJson,
  record,
  terminalState,
  text,
  tryParseResult,
} from "./codex-driver-values.js";

export function captureResultFromItem(
  state: CodexSessionState,
  item: Record<string, unknown>,
  turnId: string,
): boolean {
  if (state.conversationMode === "direct") return true;
  // Runnerd is the semantic authority for its canonical PRP stream. Its
  // normalized activity items can still contain schema-shaped assistant
  // text after paperclip_finish, but re-parsing that text here would create
  // a second, potentially conflicting result from one provider turn.
  if ((item as Record<PropertyKey, unknown>)[RUNNERD_CANONICAL_ITEM] === true)
    return true;
  if (
    text(item.type) !== "agentMessage" ||
    !isRetainableCodexPayload(item.text)
  )
    return true;
  const result = tryParseResult(item.text);
  if (result !== null && isRetainableCodexPayload(result)) {
    const admission = admitResult(state, result, text(item.id), turnId);
    if (admission === "conflict") {
      state.failProtocol(
        "conflicting_semantic_result",
        "Provider agentMessage supplied a different schema-valid semantic result after one was committed.",
      );
      return false;
    }
  }
  return true;
}

export function admitResult(
  state: CodexSessionState,
    result: PrpStructuredRunResult,
    itemId: string,
    turnId?: string,
  ): SemanticResultAdmission {
    const fingerprint = canonicalJson(result);
    if (state.resultFingerprint !== null) {
      const same = state.normalizeReplayPayload
        ? replayFingerprint(state, JSON.parse(state.resultFingerprint)) === replayFingerprint(state, result)
        : state.resultFingerprint === fingerprint;
      return same ? "identical" : "conflict";
    }
    state.result = structuredClone(result);
    state.resultFingerprint = fingerprint;
    state.resultCallId = itemId || null;
    state.resultTurnId = turnId || state.activeTurnId;
    result.verification.forEach((verification, index) => {
      state.emit(
        "item.completed",
        {
          kind: "verification",
          text: `${verification.status}: ${verification.commandOrCheck}`,
          verification,
        },
        {
          turnId: turnId || state.activeTurnId || undefined,
          itemId: `${itemId || "semantic-result"}:verification:${index + 1}`,
        },
      );
    });
    state.emit("run.result.proposed", result, {
      turnId: turnId || state.activeTurnId || undefined,
      itemId: itemId || undefined,
    });
    return "committed";
  }

function finalize(
  state: CodexSessionState,turnStatus: string): void {
  if (state.conversationMode === "direct" || state.conversationMode === "prepared") return;
    if (state.currentGoal?.status === "active") return;
    if (state.terminal) return;
    if (state.result === null) {
      state.emit("harness.diagnostic", {
        code: "semantic_result_missing",
        message: `Turn ${turnStatus} without a schema-valid semantic proposal; recovery is required.`,
      });
    }
    state.terminal = true;
  }

/**
 * ACPX closes, rather than restores, a turn that a restart interrupted after
 * the runner had recorded its accepted semantic result.
 */
const ACPX_RESTART_CLOSED_TURN_CODE = "acpx_active_turn_recovery_closed";

/**
 * The restored runner reports a turn lost on restore when it cannot prove the
 * turn's outcome itself, and ACPX closes the turn when its runner already
 * recorded the accepted result. In both cases a restart lost only the provider
 * turn. When Paperclip already holds the semantic result this exact turn
 * proposed, that result is the turn's outcome: the turn settles as completed
 * instead of failing the run and rerunning finished work. Live notifications
 * and recovery reads use the same rule. Any other terminal, or a lost turn
 * without a held result, is returned unchanged.
 */
export function settleRestoreLostTurnWithHeldResult(
  state: CodexSessionState,
  turn: Record<string, unknown>,
  turnId = text(turn.id),
): Record<string, unknown> {
  const restartLost = isNativeRestartInterruption(turn.error) ||
    record(turn.error).code === ACPX_RESTART_CLOSED_TURN_CODE;
  if (text(turn.status) !== "failed" || !restartLost ||
      state.result === null || turnId.length === 0 || state.resultTurnId !== turnId) {
    return turn;
  }
  return { ...turn, status: "completed", error: null };
}

/**
 * A replay of an already committed terminal matches when either the terminal
 * as reported or its settled form matches. A checkpoint from before the
 * restart-loss rule can hold the reported failure with the same held result;
 * that is the same terminal, not a conflicting one.
 */
export function settledTerminalReplayConflict(
  state: CodexSessionState,
  reported: Record<string, unknown>,
  settled: Record<string, unknown>,
  expectedFingerprint: string,
): TerminalReplayConflict | null {
  const conflict = terminalReplayConflict(state, settled, expectedFingerprint);
  if (conflict === null || settled === reported) return conflict;
  return terminalReplayConflict(state, reported, expectedFingerprint) === null ? null : conflict;
}

export function mapTerminalTurn(
  state: CodexSessionState,
    turn: Record<string, unknown>,
    fallbackTurnId: string,
    reconciling = false,
  ): void {
    const turnId = text(turn.id, fallbackTurnId || state.activeTurnId || "");
    const reported = turn;
    turn = settleRestoreLostTurnWithHeldResult(state, turn, turnId);
    const status = text(turn.status, "completed");
    const previous = state.terminalTurns.get(turnId);
    if (previous !== undefined) {
      const conflict = settledTerminalReplayConflict(state, reported, turn, previous);
      if (conflict !== null) {
        if (reconciling) {
          throw new HarnessReconciliationError(
            `previously terminal turn ${turnId} ${conflict.message}`,
          );
        }
        state.failProtocol(
          conflict.code,
          `Provider terminal for turn ${turnId} ${conflict.message}.`,
        );
      }
      return;
    }
    const candidate = resultFromTurn(state, turn);
    if (candidate !== null) {
      const admission = admitResult(state,
        candidate,
        text(resultItemFromTurn(state, turn)?.id),
        turnId,
      );
      if (admission === "conflict") {
        const message = `terminal turn ${turnId} contains a conflicting semantic result`;
        if (reconciling) throw new HarnessReconciliationError(message);
        state.failProtocol(
          "conflicting_semantic_result",
          `Provider ${message}.`,
        );
        return;
      }
    }
    state.terminalTurns.set(turnId, terminalFingerprint(state, turn));
    const workspace = state.workspaceChangesByTurn.get(turnId);
    if (workspace !== undefined) {
      state.emit(
        "workspace.diff.recorded",
        { ...workspace, source: "runner_verified", complete: true },
        {
          turnId,
          itemId: `${turnId}:workspace`,
        },
      );
    }
    const eventType =
      status === "failed"
        ? "turn.failed"
        : status === "interrupted"
          ? "turn.interrupted"
          : status === "cancelled"
            ? "turn.cancelled"
            : "turn.completed";
    state.cancelPendingRequests("turn_terminal");
    state.activeTurnId = null;
    state.turnStarted = false;
    const providerFailure = status === "failed" ? readProviderFailure(record(turn.error).providerFailure)
      ?? (state.driverKind === "codex_app_server" ? codexProviderFailure(turn.error, "turn", state.diagnosticEnvironment) : null) : null;
    const payload = boundedPayload({ status, error: turn.error ?? null });
    if (providerFailure) {
      payload.status = status;
      payload.error = { ...record(payload.error), providerFailure };
    }
    state.emit(eventType, payload, { turnId });
    finalize(state, status);
    if (status === "failed" && isNativeRestartInterruption(turn.error) && state.result === null &&
        (!state.dispositionOnlyRecoveryConsumed || state.dispositionOnlyRecoveryTurnId === turnId)) {
      // Orchestration may use the paid restart attempt for one same-thread
      // continuation. Its accepted turn id uses the existing durable marker.
      // A later restart that loses that continuation turn itself leaves its
      // outcome unknown too, so the next admitted restart attempt may
      // continue again; the provider attempt budget bounds the repeats.
      // Reset the marker so that continuation is submitted, checkpointed and
      // adopted after a crash exactly like the first one.
      state.dispositionOnlyRecoveryConsumed = false;
      state.dispositionOnlyRecoveryTurnId = null;
      state.terminal = false;
      state.dispositionOnlyRecoveryAvailable = true;
    } else if (eventType === "turn.completed" && state.result === null && state.conversationMode === "task" &&
        state.currentGoal?.status !== "active" && state.restartContinuationTurnId === turnId &&
        state.dispositionOnlyRecoveryConsumed && state.dispositionOnlyRecoveryTurnId === turnId) {
      // The restart continuation only borrowed the marker. It ended without a
      // result (for example, the agent said it would wait for a background
      // command), so the one disposition request it displaced is still owed.
      // That request is not a continuation and consumes the marker for good.
      state.restartContinuationTurnId = null;
      state.dispositionOnlyRecoveryConsumed = false;
      state.dispositionOnlyRecoveryTurnId = null;
      state.terminal = false;
      state.dispositionOnlyRecoveryAvailable = true;
    }
  }

function replayFingerprint(state: CodexSessionState, value: unknown): string {
  const payload = { value };
  return canonicalJson(state.normalizeReplayPayload?.(payload) ?? payload);
}

function terminalFingerprint(
  state: CodexSessionState,
    turn: Record<string, unknown>,
    semanticResult: PrpStructuredRunResult | null = state.result,
  ): string {
    return canonicalJson({
      terminalState: terminalState(text(turn.status, "completed")),
      error: turn.error ?? null,
      result: semanticResult,
    });
  }

export function terminalReplayConflict(
  state: CodexSessionState,
    turn: Record<string, unknown>,
    expectedFingerprint: string,
  ): TerminalReplayConflict | null {
    const turnId = text(turn.id);
    const candidate = resultFromTurn(state, turn);
    if (
      candidate !== null &&
      state.resultFingerprint !== null &&
      state.resultTurnId === turnId &&
      (state.normalizeReplayPayload
        ? replayFingerprint(state, candidate) !== replayFingerprint(state, JSON.parse(state.resultFingerprint))
        : canonicalJson(candidate) !== state.resultFingerprint)
    ) {
      return {
        code: "conflicting_semantic_result",
        message: "contains a conflicting semantic result",
      };
    }
    const semanticResult = state.resultTurnId === turnId
      ? state.result
      : candidate;
    const actualFingerprint = terminalFingerprint(state, turn, semanticResult);
    if (state.normalizeReplayPayload
      ? replayFingerprint(state, JSON.parse(actualFingerprint)) !== replayFingerprint(state, JSON.parse(expectedFingerprint))
      : actualFingerprint !== expectedFingerprint) {
      return {
        code: "conflicting_turn_terminal",
        message: "changed from its committed terminal fingerprint",
      };
    }
    if (candidate !== null && state.result === null) {
      admitResult(state,
        candidate,
        text(resultItemFromTurn(state, turn)?.id),
        turnId,
      );
    }
    return null;
  }

function resultItemFromTurn(
  state: CodexSessionState,
    turn: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (!Array.isArray(turn.items)) return null;
    return (
      turn.items
        .map(record)
        .reverse()
        .find(
          (value) =>
            text(value.type) === "agentMessage" &&
            isRetainableCodexPayload(value.text) &&
            tryParseResult(value.text) !== null,
        ) ?? null
    );
  }

function resultFromTurn(
  state: CodexSessionState,
    turn: Record<string, unknown>,
  ): PrpStructuredRunResult | null {
    const item = resultItemFromTurn(state, turn);
    return item === null ? null : tryParseResult(item.text);
  }
