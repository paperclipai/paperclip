import { decodeMuseRecord } from "../shared/records.js";

export interface ParsedMuseJsonl {
  sessionId: string | null;
  model: string | null;
  summary: string;
  terminal: string | null;
  reason: string | null;
  toolResultCount: number;
}

const MUSE_AUTH_ERROR_RE =
  /API key .* was rejected|No Meta credentials|missing meta credentials|saved Meta credentials are invalid|run `?muse login`?/i;

export function isMuseAuthError(text: string): boolean {
  return MUSE_AUTH_ERROR_RE.test(text);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseMuseJsonl(stdout: string): ParsedMuseJsonl {
  let sessionId: string | null = null;
  let model: string | null = null;
  let terminal: string | null = null;
  let terminalText: string | null = null;
  let terminalReason: string | null = null;
  let failedTaskReason: string | null = null;
  let toolResultCount = 0;
  const deltas: Array<{ sequence: number; text: string }> = [];

  for (const line of stdout.split(/\r?\n/)) {
    const record = decodeMuseRecord(line);
    if (!record) continue;
    if (record.streamId && !sessionId) sessionId = record.streamId;
    const { payload } = record;
    // The terminal record's payload_type carries the end state
    // (`run.terminal.completed`, `run.terminal.failed`, ...), so match on kind.
    if (payload.kind === "run_terminal") {
      terminal = str(payload.terminal).trim() || null;
      terminalText = str(payload.text);
      terminalReason = str(payload.reason).trim() || null;
      continue;
    }
    switch (record.payloadType) {
      case "run.model.configured":
        model = str(payload.model_id).trim() || model;
        break;
      case "run.output.delta": {
        const text = str(payload.text);
        if (text) deltas.push({ sequence: record.sequence, text });
        break;
      }
      case "tool.result":
        toolResultCount += 1;
        break;
      default: {
        const event = payload.event;
        if (
          record.payloadType.startsWith("task.lifecycle.") &&
          typeof event === "object" && event !== null &&
          (event as Record<string, unknown>).kind === "failed" &&
          !failedTaskReason
        ) {
          failedTaskReason = str((event as Record<string, unknown>).reason).trim() || null;
        }
      }
    }
  }

  const joinedDeltas = deltas.sort((a, b) => a.sequence - b.sequence).map((d) => d.text).join("");
  return {
    sessionId,
    model,
    summary: (terminalText ?? joinedDeltas).trim(),
    terminal,
    reason: terminalReason ?? failedTaskReason,
    toolResultCount,
  };
}
