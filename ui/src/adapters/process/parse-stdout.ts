import { parseOpenCodeStdoutLine } from "@paperclipai/adapter-opencode-local/ui";
import type { TranscriptEntry } from "../types";

// Event `type` values emitted by the OpenCode JSONL stream. OpenCode runs
// executed through the generic process adapter (adapterType "process", e.g. a
// wrapper script that ultimately execs an OpenCode harness) still emit this
// exact shape on stdout, so we detect it and reuse the existing rich renderer
// instead of dumping raw JSON.
const OPENCODE_EVENT_TYPES = new Set([
  "text",
  "reasoning",
  "tool_use",
  "step_start",
  "step_finish",
  "error",
]);

function isOpenCodeJsonlLine(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (typeof record.type !== "string" || !OPENCODE_EVENT_TYPES.has(record.type)) return false;
  // Guard against arbitrary JSON that merely happens to carry a matching `type`:
  // real OpenCode events always carry a `sessionID` string or a non-null `part`
  // payload (`part: null` is not a real OpenCode shape, so don't lock on for it).
  return typeof record.sessionID === "string" || (record.part !== undefined && record.part !== null);
}

/**
 * Stateful process-stdout parser.
 *
 * A process command typically prints a few plain bootstrap lines (e.g.
 * "Syncing skills ...") before the harness's structured JSONL stream
 * begins. Once we detect an OpenCode-shaped JSONL line we lock on and
 * delegate every subsequent line to the OpenCode parser — this avoids
 * flip-flopping on later events (e.g. `error`) that lack the detection markers,
 * while genuinely non-JSONL runs fall back to raw stdout for the whole run.
 */
export function createProcessStdoutParser() {
  let lockedOnOpenCode = false;
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      if (!lockedOnOpenCode && isOpenCodeJsonlLine(line)) {
        lockedOnOpenCode = true;
      }
      if (lockedOnOpenCode) {
        return parseOpenCodeStdoutLine(line, ts);
      }
      return [{ kind: "stdout", ts, text: line }];
    },
    reset() {
      lockedOnOpenCode = false;
    },
  };
}

// Stateless fallback for callers that haven't migrated to the stateful factory.
// Without lock-on state, only lines that individually look like OpenCode JSONL
// are parsed richly; prefer createProcessStdoutParser for live transcripts.
export function parseProcessStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (isOpenCodeJsonlLine(line)) {
    return parseOpenCodeStdoutLine(line, ts);
  }
  return [{ kind: "stdout", ts, text: line }];
}
