import { HarnessReconciliationError } from "../../contracts/harness-driver.js";
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
      return state.resultFingerprint === fingerprint ? "identical" : "conflict";
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
    if (state.conversationMode === "direct") return;
    if (state.terminal) return;
    if (state.result === null) {
      state.emit("harness.diagnostic", {
        code: "semantic_result_missing",
        message: `Turn ${turnStatus} without a schema-valid semantic proposal; recovery is required.`,
      });
    }
    state.terminal = true;
  }

export function mapTerminalTurn(
  state: CodexSessionState,
    turn: Record<string, unknown>,
    fallbackTurnId: string,
    reconciling = false,
  ): void {
    const turnId = text(turn.id, fallbackTurnId || state.activeTurnId || "");
    const status = text(turn.status, "completed");
    const previous = state.terminalTurns.get(turnId);
    if (previous !== undefined) {
      const conflict = terminalReplayConflict(state, turn, previous);
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
    state.emit(
      eventType,
      boundedPayload({
        status,
        error: turn.error ?? null,
      }),
      { turnId },
    );
    finalize(state, status);
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
      canonicalJson(candidate) !== state.resultFingerprint
    ) {
      return {
        code: "conflicting_semantic_result",
        message: "contains a conflicting semantic result",
      };
    }
    const semanticResult = state.resultTurnId === turnId
      ? state.result
      : candidate;
    if (
      terminalFingerprint(state, turn, semanticResult) !== expectedFingerprint
    ) {
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
