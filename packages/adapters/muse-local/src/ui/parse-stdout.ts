import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { decodeMuseRecord } from "../shared/records.js";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toolResultIsError(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { exit_code?: unknown; terminal_status?: unknown };
    if (typeof parsed.exit_code === "number" && parsed.exit_code !== 0) return true;
    return typeof parsed.terminal_status === "string" && parsed.terminal_status !== "completed";
  } catch {
    return false;
  }
}

function parseLineInternal(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const record = decodeMuseRecord(trimmed);
  if (!record) return [{ kind: "stdout", ts, text: line }];
  const { payload } = record;
  // The terminal record's payload_type carries the end state
  // (`run.terminal.completed`, `run.terminal.failed`, ...), so match on kind.
  if (payload.kind === "run_terminal") {
    const terminal = str(payload.terminal) || "unknown";
    if (terminal === "completed") return [{ kind: "system", ts, text: "Muse run completed" }];
    const reason = str(payload.reason);
    return [{ kind: "stderr", ts, text: reason ? `Muse run ${terminal}: ${reason}` : `Muse run ${terminal}` }];
  }
  switch (record.payloadType) {
    case "run.model.configured":
      return [{ kind: "init", ts, model: str(payload.model_id), sessionId: record.streamId ?? "" }];
    case "run.output.delta": {
      const text = str(payload.text);
      return text ? [{ kind: "assistant", ts, text, delta: true }] : [];
    }
    case "tool.result": {
      const content = str(payload.text);
      return [{ kind: "tool_result", ts, toolUseId: str(payload.call_id), content, isError: toolResultIsError(content) }];
    }
    default: {
      const event = payload.event as Record<string, unknown> | undefined;
      if (event && typeof event === "object" && event.kind === "failed") {
        const reason = str(event.reason);
        return reason ? [{ kind: "stderr", ts, text: reason }] : [];
      }
      // Lifecycle bookkeeping and the turn.input.user prompt echo are
      // intentionally dropped: the echo repeats the full prompt (it can carry
      // secrets) and lifecycle records are noise in a transcript.
      return [];
    }
  }
}

export function createMuseStdoutParser() {
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      return parseLineInternal(line, ts);
    },
    reset() {},
  };
}

export function parseMuseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseLineInternal(line, ts);
}
