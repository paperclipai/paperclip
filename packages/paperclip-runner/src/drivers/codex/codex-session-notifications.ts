import { paperclipWorkspaceFileReferencesFromText } from "../../live/workspace-file-reference.js";
import { canonicalProviderEventsFromCodex } from "../../provider-events.js";
import { harnessRuntimeRequestOutcome } from "../../contracts/harness-driver.js";
import { validatePrpStructuredRunResult } from "../../protocol/replay-contract.js";
import type { CodexRpcNotification, CodexTraceInterpretation } from "./app-server-transport.js";
import { redactCodexDiagnostic } from "./app-server-transport.js";
import { boundedCodexPayload as boundedPayload, boundedCodexValue, isRetainableCodexPayload } from "./codex-boundaries.js";
import { runtimeRequestResponse } from "./codex-question-adapter.js";
import {
  isBoundCodexNotification,
  isSupportedCodexNotificationMethod,
  codexThreadLineage as lineageFromThread,
  codexThreadStatus as threadStatus,
  parseCodexThreadGoal as parseThreadGoal,
  safeCodexRequestResponse as safeRequestResponse,
} from "./codex-thread-normalization.js";
import type { CodexSessionState } from "./codex-session-state.js";
import {
  admitResult,
  captureResultFromItem,
  mapTerminalTurn,
} from "./codex-session-terminal.js";
import {
  recordCanonicalWorkspaceChange,
  recordTurnDiff,
  recordWorkspaceChanges,
} from "./codex-session-workspace.js";
import {
  boundedText,
  differingJsonPaths,
  itemFromParams,
  itemText,
  record,
  text,
} from "./codex-driver-values.js";

export async function pumpNotifications(state: CodexSessionState): Promise<void> {
    try {
      for await (const notification of state.transport.notifications()) {
        mapNotification(state, notification);
      }
    } catch (error) {
      state.emit("harness.diagnostic", {
        code: "notification_transport_failed",
        message: redactCodexDiagnostic(String(error)),
      });
      state.expirePendingInputRequestsAfterProviderLoss();
      state.failProtocol(
        "notification_transport_failed",
        "Provider notification transport failed closed.",
      );
    }
  }

function mapNotification(state: CodexSessionState, notification: CodexRpcNotification): void {
    const sourceSequenceBefore = state.sourceSequence;
    let rejected = false;
    try {
      mapNotificationBody(state, notification);
    } catch (error) {
      rejected = true;
      throw error;
    } finally {
      const correlation = notification.paperclipTrace;
      if (correlation !== undefined) {
        const emittedEventIds: string[] = [];
        for (
          let sourceSeq = sourceSequenceBefore + 1;
          sourceSeq <= state.sourceSequence;
          sourceSeq += 1
        ) {
          emittedEventIds.push(
            `${state.runnerInstanceId}:${state.runId}:${sourceSeq}`,
          );
        }
        const disposition: CodexTraceInterpretation["disposition"] = rejected
          ? "rejected"
          : emittedEventIds.length > 0
            ? "mapped"
            : "ignored";
        try {
          state.transport.recordTraceInterpretation?.({
            sourceEventId: correlation.sourceEventId,
            sourceEventType: correlation.sourceEventType,
            providerMethod: notification.method,
            disposition,
            emittedEventIds,
            reason: rejected
              ? "Codex driver rejected the rehydrated provider notification"
              : emittedEventIds.length > 0
                ? "Codex driver normalized the rehydrated provider notification into persisted canonical PRP events"
                : "Codex driver accepted the rehydrated provider notification but emitted no canonical PRP event",
          });
        } catch {
          // Trace delivery is deliberately outside run authority.
        }
      }
    }
  }

function mapNotificationBody(state: CodexSessionState, notification: CodexRpcNotification): void {
    if (!isSupportedCodexNotificationMethod(notification.method)) return;
    if (!isBoundCodexNotification(notification, {
      runId: state.runId,
      threadIds: [...state.lineageByThread.keys()],
    })) {
      const params = notification.params;
      const claimedThreadId = text(
        params.threadId,
        text(record(params.thread).id, text(record(params.turn).threadId)),
      );
      const claimedRunId = text(params.runId, text(params.paperclipRunId));
      if (claimedThreadId.length > 0 || claimedRunId.length > 0) {
        state.failProtocol(
          "thread_binding_mismatch",
          `Provider ${notification.method} message did not name the active run or a known thread.`,
        );
      }
      return;
    }
    const params = notification.params;
    const turn = record(params.turn);
    const item = itemFromParams(params);
    const threadId = text(params.threadId);
    const turnId = text(params.turnId, text(turn.id));
    const itemId = text(item.id, text(params.itemId));
    if (notification.method === "paperclip/workspaceChange/updated") {
      if (!state.notificationNamesActiveTurn(turnId, "workspace change")) return;
      if (threadId.length > 0 && threadId !== state.opened.threadId) return;
      recordCanonicalWorkspaceChange(state,
        turnId,
        params.workspaceChange ?? params,
      );
      return;
    }
    if (
      (threadId.length === 0 || threadId === state.opened.threadId) &&
      (turnId.length === 0 ||
        state.activeTurnId === null ||
        turnId === state.activeTurnId)
    ) {
      for (const canonical of canonicalProviderEventsFromCodex(
        notification.method,
        params,
      )) {
        state.emit(canonical.eventType, canonical.payload, {
          turnId: turnId || undefined,
          itemId: canonical.itemId,
        });
      }
    }
    if (
      notification.method === "error" ||
      notification.method === "warning" ||
      notification.method === "configWarning"
    ) {
      state.emit("harness.diagnostic", {
        code: notification.method.replaceAll("/", "_"),
        message: redactCodexDiagnostic(
          text(params.message, JSON.stringify(boundedCodexValue(params))),
        ),
      });
      return;
    }
    if (notification.method === "thread/started") {
      if (!state.capabilities.threadLineage) return;
      const thread = record(params.thread);
      const lineage = lineageFromThread(thread);
      if (
        lineage.threadId.length === 0 ||
        lineage.threadId === state.opened.threadId ||
        lineage.parentThreadId === null ||
        !state.lineageByThread.has(lineage.parentThreadId)
      ) {
        return;
      }
      state.lineageByThread.set(lineage.threadId, lineage);
      state.emit(
        "item.started",
        {
          kind: "thread_lineage",
          text: `${lineage.nickname ?? lineage.role ?? "Child agent"} started.`,
          lineage,
        },
        { itemId: `thread:${lineage.threadId}` },
      );
      return;
    }
    if (notification.method === "thread/status/changed") {
      const lineage = state.lineageByThread.get(threadId);
      if (lineage === undefined || threadId === state.opened.threadId) return;
      lineage.status = threadStatus(params.status);
      state.emit(
        "item.delta",
        {
          kind: "thread_lineage",
          text: `${lineage.nickname ?? lineage.role ?? "Child agent"}: ${lineage.status}`,
          lineage,
        },
        { itemId: `thread:${lineage.threadId}` },
      );
      return;
    }
    if (notification.method === "thread/closed") {
      const lineage = state.lineageByThread.get(threadId);
      if (lineage === undefined || threadId === state.opened.threadId) return;
      lineage.status = "closed";
      state.emit(
        "item.completed",
        {
          kind: "thread_lineage",
          text: `${lineage.nickname ?? lineage.role ?? "Child agent"} closed.`,
          lineage,
        },
        { itemId: `thread:${lineage.threadId}` },
      );
      return;
    }
    if (notification.method === "thread/goal/updated") {
      if (threadId !== state.opened.threadId) return;
      const goal = parseThreadGoal(params.goal);
      if (goal === null) return;
      state.currentGoal = goal;
      state.emit(
        "item.completed",
        {
          kind: "goal",
          text: `Thread goal ${goal.status}: ${goal.objective}`,
          action: "notification",
          goal,
        },
        {
          turnId: turnId || undefined,
          itemId: `${threadId}:goal:update:${state.sourceSequence + 1}`,
        },
      );
      return;
    }
    if (notification.method === "thread/goal/cleared") {
      if (threadId !== state.opened.threadId) return;
      state.currentGoal = null;
      state.emit(
        "item.completed",
        {
          kind: "goal_cleared",
          text: "Thread goal cleared.",
          action: "notification",
          goal: null,
        },
        { itemId: `${threadId}:goal:clear:${state.sourceSequence + 1}` },
      );
      return;
    }
    if (notification.method === "serverRequest/resolved") {
      const requestId = String(params.requestId ?? "");
      const pending = state.pendingRuntimeRequestMap.get(requestId);
      if (pending === undefined || threadId !== state.opened.threadId) return;
      state.pendingRuntimeRequestMap.delete(requestId);
      const resolution = pending.settlingResolution;
      state.emit(
        resolution === undefined ? "runtime_request.cancelled" : "runtime_request.resolved",
        harnessRuntimeRequestOutcome(
          pending.request,
          resolution === undefined
            ? { reason: "provider_resolved" }
            : {
                action: resolution.action,
                ...(resolution.action === "submit" && "response" in resolution
                  ? { response: resolution.response }
                  : {}),
              },
        ),
        { turnId: pending.request.turnId, itemId: pending.request.itemId },
      );
      pending.settle(
        resolution === undefined
          ? safeRequestResponse(pending.request.method, "cancel")
          : runtimeRequestResponse(
              pending.request,
              resolution,
              pending.responseContext,
            ),
      );
      return;
    }
    if (
      notification.method === "item/completed"
      && text(params.kind) === "steering_acknowledgement"
      && Object.keys(item).length === 0
    ) {
      // runnerd persists its own command acknowledgement as a canonical PRP
      // item. The request() call is already the authoritative acknowledgement
      // and steer() emits the user-visible item with the active turn binding.
      // Do not reinterpret this transport-level echo as an unbound Codex item.
      return;
    }
    if (notification.method === "paperclip/runResult") {
      if (
        threadId !== state.opened.threadId
        || !state.notificationNamesActiveTurn(turnId, "semantic result")
      ) {
        if (threadId !== state.opened.threadId) {
          state.failProtocol(
            "thread_binding_mismatch",
            "Provider semantic result did not name the opened thread.",
          );
        }
        return;
      }
      if (!isRetainableCodexPayload(params.result)) {
        state.failProtocol(
          "invalid_semantic_result",
          "Provider semantic result exceeded the retained payload limit.",
        );
        return;
      }
      const validation = validatePrpStructuredRunResult(params.result);
      if (!validation.ok) {
        state.failProtocol(
          "invalid_semantic_result",
          "Provider semantic result did not match the run-result contract.",
        );
        return;
      }
      const differingFields = state.result === null
        ? []
        : differingJsonPaths(state.result, validation.result);
      if (admitResult(state, validation.result, itemId, turnId) === "conflict") {
        state.failProtocol(
          "conflicting_semantic_result",
          `Provider supplied a different schema-valid semantic result after one was committed. Differing fields: ${differingFields.join(", ") || "unknown"}.`,
        );
      }
      return;
    }
    if (threadId !== state.opened.threadId) {
      state.failProtocol(
        "thread_binding_mismatch",
        `Provider ${notification.method} message did not name the opened thread.`,
      );
      return;
    }
    if (notification.method === "turn/started") {
      if (
        turnId.length === 0 ||
        state.terminal ||
        state.protocolFailed ||
        state.turnStarted ||
        (!state.turnStartPending && state.activeTurnId === null) ||
        (state.activeTurnId !== null && state.activeTurnId !== turnId)
      ) {
        state.failProtocol(
          "turn_binding_mismatch",
          "Provider started an unexpected turn.",
        );
        return;
      }
      state.activeTurnId = turnId;
      state.turnStarted = true;
      state.emit(
        "turn.started",
        { status: text(turn.status, "inProgress") },
        { turnId },
      );
      return;
    }
    if (notification.method === "turn/completed") {
      if (state.terminalTurns.has(turnId)) {
        mapTerminalTurn(state, turn, turnId);
        return;
      }
      if (!state.notificationNamesActiveTurn(turnId, "turn terminal")) return;
      mapTerminalTurn(state, turn, turnId);
      return;
    }
    if (notification.method === "item/started") {
      if (!state.notificationNamesActiveTurn(turnId, "item start")) return;
      const channel = channelForStartedItem(state, item);
      if (itemId) state.itemChannels.set(itemId, channel);
      state.emit(
        "item.started",
        boundedPayload({
          kind: text(item.type, "unknown"),
          channel,
          providerPhase: text(item.phase) || undefined,
          text: itemText(item),
          item,
        }),
        { turnId, itemId },
      );
      return;
    }
    if (notification.method === "item/completed") {
      if (!state.notificationNamesActiveTurn(turnId, "item completion")) return;
      if (!captureResultFromItem(state, item, turnId)) return;
      const channel = itemId
        ? (state.itemChannels.get(itemId) ?? channelForStartedItem(state, item))
        : channelForStartedItem(state, item);
      state.emit(
        "item.completed",
        boundedPayload({
          kind: text(item.type, "unknown"),
          channel,
          providerPhase: text(item.phase) || undefined,
          text: itemText(item),
          item,
        }),
        { turnId, itemId },
      );
      if (text(item.type) === "agentMessage") {
        for (const reference of paperclipWorkspaceFileReferencesFromText(
          state.opened.context.workingDirectory,
          text(item.text),
          turnId,
        )) {
          if (state.emittedFileReferences.has(reference.referenceId)) continue;
          state.emittedFileReferences.add(reference.referenceId);
          state.emit(
            "workspace.file.referenced",
            { ...reference },
            { turnId, itemId: reference.referenceId },
          );
        }
      }
      if (itemId) state.itemChannels.delete(itemId);
      if (text(item.type) === "fileChange")
        recordWorkspaceChanges(state, turnId, item.changes, true);
      return;
    }
    const deltaKinds: Record<string, string> = {
      "item/agentMessage/delta": "agentMessage",
      "item/plan/delta": "plan",
      "item/reasoning/summaryTextDelta": "reasoning",
      "item/reasoning/textDelta": "reasoning",
      "item/commandExecution/outputDelta": "commandExecution",
      "item/fileChange/outputDelta": "fileChange",
      "item/fileChange/patchUpdated": "fileChange",
      "turn/diff/updated": "diff",
      "turn/plan/updated": "plan",
    };
    const deltaKind = deltaKinds[notification.method];
    if (deltaKind !== undefined) {
      if (!state.notificationNamesActiveTurn(turnId, "item update")) return;
      const methodChannel = channelForDelta(state, notification.method);
      const channel =
        methodChannel !== "unknown"
          ? methodChannel
          : itemId
            ? (state.itemChannels.get(itemId) ?? "unknown")
            : "unknown";
      state.emit(
        "item.delta",
        boundedPayload({
          kind: deltaKind,
          channel,
          providerMethod: notification.method,
          text: text(params.delta, text(params.patch, text(params.output))),
          update: params,
        }),
        { turnId, itemId: itemId || `${turnId}:${deltaKind}` },
      );
      if (notification.method === "item/fileChange/patchUpdated") {
        recordWorkspaceChanges(state, turnId, params.changes, false);
      } else if (notification.method === "turn/diff/updated") {
        recordTurnDiff(state, turnId, params.diff);
      }
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      state.usageSnapshot = boundedPayload(record(params.tokenUsage));
      // Codex can replay a thread-scoped usage snapshot while a resumed thread
      // is being attached, before the next turn has started. Keep the snapshot,
      // but do not turn that benign replay into a fatal turn-binding violation.
      if (state.activeTurnId === null || turnId !== state.activeTurnId) return;
      state.emit(
        "item.completed",
        { kind: "usage", usage: state.usageSnapshot },
        {
          turnId,
          itemId: `${turnId}:usage:${state.sourceSequence + 1}`,
        },
      );
      return;
    }
  }

function channelForStartedItem(
  state: CodexSessionState,
    item: Record<string, unknown>,
  ): "progress" | "final" | "summary" | "detail" | "unknown" {
    const type = text(item.type);
    const phase = text(item.phase).toLowerCase();
    if (type === "agentMessage") {
      if (phase === "commentary") return "progress";
      if (phase === "final_answer") return "final";
      return "unknown";
    }
    if (type === "reasoning") return "summary";
    return "unknown";
  }

function channelForDelta(
  state: CodexSessionState,
    method: string,
  ): "progress" | "final" | "summary" | "detail" | "unknown" {
    if (method === "item/reasoning/summaryTextDelta") return "summary";
    if (method === "item/reasoning/textDelta") return "detail";
    return "unknown";
  }
