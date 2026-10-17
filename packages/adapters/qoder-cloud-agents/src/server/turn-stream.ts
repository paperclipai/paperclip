import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import { QoderApiError, type QoderClient, type QoderRecord } from "./client.js";
import {
  BUSY_SESSION_STATUSES,
  asRecord,
  contentText,
  emitStatus,
  eventLine,
  formatRunError,
  trimNullable,
  type QoderSleep,
} from "./shared.js";

export type TurnOutcome = {
  kind: "idle" | "terminated";
  stopReason: string | null;
  lastMessage: string | null;
  lastError: string | null;
  /** True when the pending action is a tool call Qoder already allowed, so only a worker can answer it. */
  awaitingToolWorker: boolean;
};

export const IDLE_POLL_INTERVAL_MS = 3_000;

export const MAX_STREAM_RECONNECTS = 5;

export const STREAM_RECONNECT_BASE_DELAY_MS = 1_000;

/** Null means the stored session can no longer be used and a fresh one is needed. */
export async function probeSession(client: QoderClient, sessionId: string): Promise<string | null> {
  try {
    const session = await client.getSession(sessionId);
    const status = trimNullable(session.status);
    if (!status || status === "terminated" || session.archived_at) return null;
    return status;
  } catch (err) {
    if (err instanceof QoderApiError && err.status === 404) return null;
    throw err;
  }
}

export async function waitForIdle(
  client: QoderClient,
  sessionId: string,
  sleep: QoderSleep,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    const status = trimNullable((await client.getSession(sessionId)).status);
    if (!status || !BUSY_SESSION_STATUSES.has(status)) return;
    await sleep(IDLE_POLL_INTERVAL_MS, signal);
  }
}

export function pendingEventIds(event: QoderRecord): string[] {
  const ids = asRecord(event.stop_reason)?.event_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

export function readTerminalEvent(event: QoderRecord): Pick<TurnOutcome, "kind" | "stopReason"> | null {
  const type = asString(event.type, "");
  if (type === "session.status_idle") {
    return { kind: "idle", stopReason: trimNullable(asRecord(event.stop_reason)?.type) };
  }
  if (type === "session.status_terminated" || type === "session.deleted") {
    return { kind: "terminated", stopReason: type };
  }
  return null;
}

export async function streamTurn(input: {
  client: QoderClient;
  sessionId: string;
  /** The user.message event that started this turn; also the first stream cursor. */
  turnEventId: string | null;
  onLog: AdapterExecutionContext["onLog"];
  sleep: QoderSleep;
  signal: AbortSignal;
}): Promise<TurnOutcome> {
  const { client, sessionId, onLog, sleep, signal } = input;
  let cursor = input.turnEventId;
  let lastMessage: string | null = null;
  let lastError: string | null = null;
  let reconnects = 0;
  const allowedToolUseIds = new Set<string>();
  const outcome = (terminal: Pick<TurnOutcome, "kind" | "stopReason">, event: QoderRecord): TurnOutcome => {
    const pending = pendingEventIds(event);
    return {
      ...terminal,
      lastMessage,
      lastError,
      awaitingToolWorker: terminal.stopReason === "requires_action"
        && pending.length > 0
        && pending.every((id) => allowedToolUseIds.has(id)),
    };
  };

  for (;;) {
    let streamFailure: string | null = null;
    try {
      for await (const frame of client.streamEvents(sessionId, cursor)) {
        if (frame.id) cursor = frame.id;
        if (!frame.data) continue;
        let event: QoderRecord | null = null;
        try {
          event = asRecord(JSON.parse(frame.data));
        } catch {
          event = null;
        }
        const type = asString(event?.type, "");
        // Delta frames are stream-only previews of a buffered event that follows.
        if (!event || !type || type === "event_start" || type === "event_delta") continue;
        reconnects = 0;
        // The prompt is already in the invocation metadata, with run-scoped credentials redacted.
        if (type === "user.message") continue;
        await onLog("stdout", eventLine({ type: "qoder_cloud_agents.event", event }));
        if (type === "agent.message") {
          lastMessage = contentText(event.content) || lastMessage;
        } else if ((type === "agent.tool_use" || type === "agent.mcp_tool_use") && event.evaluated_permission === "allow") {
          const id = trimNullable(event.id);
          if (id) allowedToolUseIds.add(id);
        } else if (type === "session.error") {
          const error = asRecord(event.error);
          if (asRecord(error?.retry_status)?.type !== "retrying") {
            lastError = trimNullable(error?.message) ?? trimNullable(error?.type) ?? "Qoder session error";
          }
        }
        const terminal = readTerminalEvent(event);
        if (terminal) return outcome(terminal, event);
      }
    } catch (err) {
      if (signal.aborted) throw err;
      // A stale token will not recover by reconnecting.
      if (err instanceof QoderApiError && (err.status === 401 || err.status === 403 || err.status === 404)) throw err;
      streamFailure = formatRunError(err);
    }

    signal.throwIfAborted();
    reconnects += 1;
    if (reconnects > MAX_STREAM_RECONNECTS) {
      // The stream is gone; recover the turn's outcome from event history when it already ended.
      const session = await client.getSession(sessionId);
      if (!BUSY_SESSION_STATUSES.has(asString(session.status, ""))) {
        const history = await client.listRecentEvents(sessionId);
        const terminalIndex = history.findIndex((event) => readTerminalEvent(event));
        if (terminalIndex !== -1) {
          // History is newest first: walk back from the terminal event to this
          // turn's user.message so the answer and errors the stream never
          // delivered are not lost, and an older turn's reply is not reused.
          let recoveredMessage: string | null = null;
          let recoveredError: string | null = null;
          for (const event of history.slice(terminalIndex + 1)) {
            const type = asString(event.type, "");
            if (type === "user.message" || (input.turnEventId && event.id === input.turnEventId)) break;
            if (type === "agent.message") {
              recoveredMessage ??= contentText(event.content) || null;
            } else if (type === "session.error") {
              const error = asRecord(event.error);
              if (asRecord(error?.retry_status)?.type !== "retrying") {
                recoveredError ??= trimNullable(error?.message) ?? trimNullable(error?.type) ?? "Qoder session error";
              }
            } else if ((type === "agent.tool_use" || type === "agent.mcp_tool_use") && event.evaluated_permission === "allow") {
              const id = trimNullable(event.id);
              if (id) allowedToolUseIds.add(id);
            }
          }
          lastMessage = recoveredMessage ?? lastMessage;
          lastError = recoveredError ?? lastError;
          const terminalEvent = history[terminalIndex];
          return outcome(readTerminalEvent(terminalEvent)!, terminalEvent);
        }
      }
      throw new Error(
        `Lost the Qoder event stream for session ${sessionId} before the turn finished${streamFailure ? `: ${streamFailure}` : "."}`,
      );
    }
    await emitStatus(onLog, "running", `Qoder event stream closed; reconnecting (attempt ${reconnects}).`);
    await sleep(STREAM_RECONNECT_BASE_DELAY_MS * 2 ** (reconnects - 1), signal);
  }
}
