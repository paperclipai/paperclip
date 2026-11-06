import { observeCodexUsage, codexRunUsage } from "./codex-usage-baseline.js";
import { codexRateLimitSnapshot, rateLimitNoticeEvent, rateLimitSnapshotChanged } from "../provider-rate-limits.js";
import { classifyCodexNotification } from "./codex-notification-identity.js";
import { paperclipWorkspaceFileReferencesFromText } from "../../live/workspace-file-reference.js";
import { canonicalProviderEventsFromCodex, isCanonicalProviderEventType } from "../../provider-events.js";
import { harnessRuntimeRequestOutcome } from "../../contracts/harness-driver.js";
import { isNativeRestartInterruption, NativeSessionProtocolIntegrityError } from "../../contracts/native-session-backend.js";
import { isPrpAuthCredentialsUpdated, validatePrpStructuredRunResult } from "../../protocol/replay-contract.js";
import type { CodexRpcNotification, CodexTraceInterpretation } from "./app-server-transport.js";
import { redactCodexDiagnostic } from "./app-server-transport.js";
import { boundedCodexPayload as boundedPayload, boundedCodexValue, isRetainableCodexPayload } from "./codex-boundaries.js";
import { runtimeRequestProtocolPayload, runtimeRequestResponse } from "./codex-question-adapter.js";
import {
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
  RUNNERD_RUNTIME_ACTIVITY,
  boundedText,
  differingJsonPaths,
  itemFromParams,
  itemText,
  record,
  text,
} from "./codex-driver-values.js";

const DELTA_KINDS: Record<string, string> = {
  "item/agentMessage/delta": "agentMessage",
  "item/plan/delta": "plan",
  "item/reasoning/summaryTextDelta": "reasoning",
  "item/reasoning/summaryPartAdded": "reasoning",
  "item/reasoning/textDelta": "reasoning",
  "item/commandExecution/outputDelta": "commandExecution",
  "item/fileChange/outputDelta": "fileChange",
  "item/fileChange/patchUpdated": "fileChange",
  "turn/diff/updated": "diff",
  "turn/plan/updated": "plan",
};

// Turn-scoped activity a resumed runner can replay from committed history.
// turn/completed is excluded: its replay still passes the fingerprint check.
const REPLAYABLE_TURN_METHODS = new Set([
  "turn/started",
  "item/started",
  "item/completed",
  "item/mcpToolCall/progress",
  ...Object.keys(DELTA_KINDS),
]);

export async function pumpNotifications(state: CodexSessionState): Promise<void> {
    try {
      for await (const notification of state.transport.notifications()) {
        await mapNotification(state, notification);
      }
    } catch (error) {
      if (error instanceof NativeSessionProtocolIntegrityError) {
        state.failProtocolIntegrity(error);
        return;
      }
      state.emit("harness.diagnostic", {
        code: "notification_transport_failed",
        message: redactCodexDiagnostic(String(error)),
      });
      state.expirePendingInputRequestsAfterProviderLoss();
      // The terminal error is what the run shows. Keep the redacted cause on it:
      // the stream can close because of host-side runner supervision, not only
      // the provider, and a bare "failed closed" hides which one it was.
      state.failProtocol(
        "notification_transport_failed",
        notificationTransportFailureMessage(error),
      );
    }
  }

const NOTIFICATION_TRANSPORT_CAUSE_LIMIT = 1_000;

function notificationTransportFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Redact before bounding so truncation cannot split a credential pattern.
  const cause = redactCodexDiagnostic(raw).replace(/\s+/g, " ").trim();
  if (!cause) return "Notification transport failed closed.";
  const bounded = cause.length > NOTIFICATION_TRANSPORT_CAUSE_LIMIT
    ? `${cause.slice(0, NOTIFICATION_TRANSPORT_CAUSE_LIMIT)}…`
    : cause;
  return `Notification transport failed closed: ${bounded}`;
}

async function mapNotification(state: CodexSessionState, notification: CodexRpcNotification): Promise<void> {
    const sourceSequenceBefore = state.sourceSequence;
    let rejected = false;
    try {
      await mapNotificationBody(state, notification);
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

async function mapNotificationBody(state: CodexSessionState, notification: CodexRpcNotification): Promise<void> {
    if (notification.method === "paperclip/runtimeActivityRecorded") {
      const params = notification.params;
      if ((params as Record<PropertyKey, unknown>)[RUNNERD_RUNTIME_ACTIVITY] !== true) return;
      const pending = state.pendingRunAttachment;
      if (pending && params.runId === pending.runId && params.runId !== state.runId) await pending.settled;
      if (params.runId === state.runId) state.emit("runtime.activity.recorded", record(params.payload));
      return;
    }
    if (notification.method === "account/rateLimits/updated") {
      // Account-scoped: it names no thread or turn, so it bypasses thread binding.
      const next = codexRateLimitSnapshot(record(notification.params), state.rateLimits, state.now().toISOString());
      if (next && rateLimitSnapshotChanged(state.rateLimits, next)) {
        const itemId = `codex-rate-limits:${++state.rateLimitNoticeSequence}`;
        const notice = rateLimitNoticeEvent(next, itemId);
        state.emit(notice.eventType, notice.payload, {
          ...(state.activeTurnId ? { turnId: state.activeTurnId } : {}),
          itemId,
        });
      }
      if (next) state.rateLimits = next;
      return;
    }
    if (!isSupportedCodexNotificationMethod(notification.method)) return;
    if (notification.method === "item/completed" && notification.params.kind === "steering_acknowledgement"
      && !notification.params.threadId && !notification.params.turnId && !notification.params.thread && !notification.params.turn) return;
    const identity = classifyCodexNotification({
      method: notification.method, params: notification.params, runId: state.runId,
      rootThreadId: state.opened.threadId, activeTurnId: state.activeTurnId,
      knownThreads: new Set(state.lineageByThread.keys()), settledTurns: new Set(state.terminalTurns.keys()),
    });
    if ((identity.classification === "root" || identity.classification === "stale_turn")
      && identity.threadId === state.opened.threadId
      && notification.method === "thread/tokenUsage/updated"
      && identity.turnId !== null
      && identity.turnId !== state.activeTurnId
      && (state.activeTurnId === null || (identity.turnId !== null && state.terminalTurns.has(identity.turnId)))) {
      state.codexUsageBaseline = observeCodexUsage(state.codexUsageBaseline, record(notification.params.tokenUsage).total, true);
      state.usageSnapshot = codexRunUsage(state.codexUsageBaseline);
      if (state.notificationIdentityDiagnostics++ < 32) state.emit("harness.diagnostic", {
        code: "codex_resume_usage_snapshot", classification: "resume_usage_snapshot",
        receivedThreadId: identity.threadId, receivedTurnId: identity.turnId,
      });
      return;
    }
    if (identity.classification !== "root") {
      if (state.notificationIdentityDiagnostics < 32) {
        state.notificationIdentityDiagnostics += 1;
        state.emit("harness.diagnostic", {
          code: "provider_notification_identity", method: notification.method.slice(0, 128),
          classification: identity.classification,
          expectedThreadId: state.opened.threadId, receivedThreadId: identity.threadId?.slice(0, 256) ?? null,
          expectedTurnId: state.activeTurnId, receivedTurnId: identity.turnId?.slice(0, 256) ?? null,
        });
      }
      if (identity.classification === "invalid_authority") {
        state.failProtocol("thread_binding_mismatch", `Provider authoritative notification ${notification.method.slice(0, 128)} did not name its execution owner.`);
        return;
      }
      if (identity.classification !== "descendant") return;
      if (!["thread/started", "thread/status/changed", "thread/closed"].includes(notification.method)) return;
    }
    const params = notification.params;
    const turn = record(params.turn);
    const item = itemFromParams(params);
    const threadId = text(params.threadId);
    const turnId = text(params.turnId, text(turn.id));
    const itemId = text(item.id, text(params.itemId));
    // Check before canonical mapping, which would otherwise emit tool and plan
    // events for the replayed turn while no turn is active.
    if (
      threadId === state.opened.threadId
      && REPLAYABLE_TURN_METHODS.has(notification.method)
      && ignoreRestoredTerminalReplay(state, notification.method, turnId)
    ) return;
    if (notification.method === "paperclip/runtimeRequestExpired") {
      const payload = record(params.payload);
      const requestId = text(payload.requestId);
      const pending = state.pendingRuntimeRequestMap.get(requestId);
      if (pending === undefined) return;
      const expected = runtimeRequestProtocolPayload(pending.request);
      if (pending.request.turnId !== turnId || payload.requestKind !== expected.requestKind
        || payload.requestType !== (pending.request.input === undefined ? "permission" : "input")
        || payload.replayAllowed !== false || typeof payload.reason !== "string" || !payload.reason) {
        state.failProtocol("turn_binding_mismatch", "Canonical request expiry changed its callback binding.");
        return;
      }
      state.pendingRuntimeRequestMap.delete(requestId);
      // Preserve durable expiry evidence with the same facade identity used
      // when creating this callback. Terminal handling must not cancel it again.
      state.emit("runtime_request.expired", { ...payload,
        turnId: pending.request.turnId, itemId: pending.request.itemId,
      }, { turnId: pending.request.turnId, itemId: pending.request.itemId });
      pending.settle(safeRequestResponse(pending.request.method, "cancel"));
      return;
    }
    if (notification.method === "paperclip/canonicalProviderEvent") {
      if (!isCanonicalProviderEventType(params.eventType)) {
        state.failProtocol("provider_event_type_invalid", "Unknown canonical provider event type.");
        return;
      }
      const canonicalPayload = record(params.payload);
      if (params.eventType === "auth.credentials.updated") {
        if (!isPrpAuthCredentialsUpdated(canonicalPayload)) {
          state.failProtocol("credential_update_invalid", "Invalid credential update notification.");
          return;
        }
        state.emit(params.eventType, canonicalPayload, { turnId: turnId || undefined, itemId: itemId || undefined });
        return;
      }
      if (params.eventType === "harness.diagnostic" && canonicalPayload.code === "codex_resume_usage_snapshot") {
        state.codexUsageBaseline = observeCodexUsage(state.codexUsageBaseline, canonicalPayload.cumulative, true);
        state.usageSnapshot = codexRunUsage(state.codexUsageBaseline);
      }
      state.emit(params.eventType, canonicalPayload, { turnId: turnId || undefined, itemId: itemId || undefined });
      return;
    }
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
      if (notification.method === "item/started" && record(params.item).type === "contextCompaction") {
        state.compactionContext = { preTokens: state.lastContextUsedTokens, postTokens: null };
      }
      for (const canonical of canonicalProviderEventsFromCodex(
        notification.method,
        params,
        { workingDirectory: state.workspaceRoots },
      )) {
        const payload = canonical.eventType === "context.compacted"
          ? withCompactionSizes(state, canonical.payload)
          : canonical.payload;
        state.emit(canonical.eventType, payload, {
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
          text(
            record(params.error).message,
            text(params.message, JSON.stringify(boundedCodexValue(params))),
          ),
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
      state.emitGoalEvent("session.goal.updated", goal, {
        workingNow: state.activeTurnId !== null,
      });
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
      state.emitGoalEvent("session.goal.cleared", null, {
        workingNow: state.activeTurnId !== null,
      });
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
    ) {
      // runnerd persists its own command acknowledgement as a canonical PRP
      // item. The request() call is already the authoritative acknowledgement
      // and steer() emits the user-visible item with the active turn binding.
      // Rehydration adds an item object to this transport echo; it still must
      // not become a second acknowledgement beside the correlation-bound item.
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
      const autonomousGoalTurn = state.currentGoal?.status === "active"
        && state.activeTurnId === null
        && !state.turnStartPending
        && !state.protocolFailed
        && !state.terminalTurns.has(turnId);
      if (autonomousGoalTurn) {
        state.terminal = false;
        state.turnStarted = false;
        state.turnStartPending = true;
        state.result = null;
        state.resultFingerprint = null;
        state.resultCallId = null;
        state.resultTurnId = null;
      }
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
      state.turnStartPending = false;
      state.turnStarted = true;
      state.emit(
        "turn.started",
        { status: text(turn.status, "inProgress") },
        { turnId },
      );
      return;
    }
    if (notification.method === "turn/completed") {
      // A terminal notification can arrive on the provider's notification
      // channel before turn/start's own response settles on the request
      // channel. Wait for the pending turn/start to settle first, so
      // turn.accepted always precedes the terminal event for the same turn.
      await state.turnStartSettled;
      if (state.terminalTurns.has(turnId)) {
        mapTerminalTurn(state, turn, turnId);
        return;
      }
      if (ignoreUnboundRestoredTurnLoss(state, turn, turnId)) return;
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
    const deltaKind = DELTA_KINDS[notification.method];
    if (deltaKind !== undefined) {
      if (!state.notificationNamesActiveTurn(turnId, "item update")) return;
      // A new summary part starts a new section: the first part needs no
      // separator, later parts begin after a blank line like `summary[]`.
      if (notification.method === "item/reasoning/summaryPartAdded"
        && !(typeof params.summaryIndex === "number" && params.summaryIndex > 0)) return;
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
          text: notification.method === "item/reasoning/summaryPartAdded"
            ? "\n\n"
            : text(params.delta, text(params.patch, text(params.output))),
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
      const contextUsedTokens = record(record(params.tokenUsage).context).usedTokens;
      if (typeof contextUsedTokens === "number" && Number.isSafeInteger(contextUsedTokens) && contextUsedTokens >= 0) {
        if (state.compactionContext) state.compactionContext.postTokens = contextUsedTokens;
        else state.lastContextUsedTokens = contextUsedTokens;
      }
      if (state.driverKind === "codex_app_server") {
        const reported = record(record(params.tokenUsage).total);
        const validCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
        // The monotonic snapshot retains absent counters from older reports.
        // Preserve whether this provider report can actually close accounting.
        const runDeltaComplete = validCount(reported.inputTokens) && validCount(reported.outputTokens)
          && Object.entries(reported).every(([key, value]) => !key.endsWith("Tokens") || validCount(value))
          && Object.keys(state.codexUsageBaseline?.latest ?? {}).every(key => !key.endsWith("Tokens") || validCount(reported[key]));
        if (Object.keys(reported).length > 0) {
          state.codexUsageBaseline = observeCodexUsage(state.codexUsageBaseline, reported, false);
          state.usageSnapshot = { ...state.usageSnapshot, ...codexRunUsage(state.codexUsageBaseline) };
        }
        state.usageSnapshot = { ...state.usageSnapshot, runDeltaComplete };
      }
      // Codex can replay a thread-scoped usage snapshot while a resumed thread
      // is being attached, before the next turn has started. Keep the snapshot,
      // but do not turn that benign replay into a fatal turn-binding violation.
      if (state.activeTurnId === null || turnId !== state.activeTurnId) return;
      if (state.codexUsageBaseline) state.codexUsageBaseline.accounted = { ...state.codexUsageBaseline.latest };
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

// Resume can re-deliver committed history for a turn the checkpoint already
// settled. Between turns the identity classifier sees no active turn, so the
// replay would otherwise reach the live-turn guards and fail the session.
/** Fills a compaction's missing sizes from the readings around it. */
function withCompactionSizes(
  state: CodexSessionState,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const observed = state.compactionContext;
  state.compactionContext = null;
  const preTokens = count(payload.preTokens) ?? observed?.preTokens ?? null;
  const postTokens = count(payload.postTokens) ?? observed?.postTokens ?? null;
  if (postTokens !== null) state.lastContextUsedTokens = postTokens;
  return { ...payload, preTokens, postTokens };
}

/**
 * A controller can die after the provider accepted a turn but before that
 * turn reached its checkpoint. The restored runner then reports the turn as
 * lost on restore, while this session never bound it. The runner emits that
 * cause only after it proved the old provider process ended and restored the
 * same conversation, so the turn can produce no further work or result. It is
 * not this session's turn: record it as restored history and keep the session
 * usable for its own (continuation) turn instead of failing the protocol.
 */
function ignoreUnboundRestoredTurnLoss(
  state: CodexSessionState,
  turn: Record<string, unknown>,
  turnId: string,
): boolean {
  if (
    turnId.length === 0 ||
    state.protocolFailed ||
    turnId === state.activeTurnId ||
    state.terminalTurns.has(turnId) ||
    text(turn.status) !== "failed" ||
    !isNativeRestartInterruption(turn.error)
  ) {
    return false;
  }
  state.restoredTerminalTurns.add(turnId);
  state.emit("harness.diagnostic", {
    code: "provider_notification_identity",
    method: "turn/completed",
    classification: "unbound_restored_turn_lost",
    expectedTurnId: state.activeTurnId,
    receivedTurnId: turnId.slice(0, 256),
  });
  return true;
}

function ignoreRestoredTerminalReplay(
  state: CodexSessionState,
  method: string,
  turnId: string,
): boolean {
  if (!state.isRestoredTerminalReplay(turnId)) return false;
  if (state.notificationIdentityDiagnostics < 32) {
    state.notificationIdentityDiagnostics += 1;
    state.emit("harness.diagnostic", {
      code: "provider_notification_identity", method: method.slice(0, 128),
      classification: "restored_terminal_replay",
      expectedTurnId: state.activeTurnId, receivedTurnId: turnId.slice(0, 256),
    });
  }
  return true;
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
    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/summaryPartAdded") return "summary";
    if (method === "item/reasoning/textDelta") return "detail";
    return "unknown";
  }
