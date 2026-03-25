import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseNdjsonLine } from "../server/parse.js";
import type {
  OzAgentEvent,
  OzAgentReasoningEvent,
  OzToolCallEvent,
  OzToolResultEvent,
  OzSystemEvent,
} from "../server/parse.js";

/**
 * Parse a single line of oz agent run --output-format json output into one or
 * more transcript entries. Falls back to a raw stdout entry for non-JSON lines.
 *
 * Event → TranscriptEntry mapping:
 *   agent           → assistant (rendered as agent response text)
 *   agent_reasoning → thinking  (rendered as collapsible reasoning block)
 *   tool_call       → tool_call (tool name + serialised input)
 *   tool_result     → tool_result (tool output)
 *   system          → system (run_started URL shown; others suppressed)
 *   non-JSON        → stdout (verbatim passthrough)
 */
export function parseOzStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const ev = parseNdjsonLine(line);
  if (!ev) {
    // Non-JSON line (startup noise, debug output, etc.) — pass through verbatim
    if (!line.trim()) return [];
    return [{ kind: "stdout", ts, text: line }];
  }

  switch (ev.type) {
    case "agent": {
      const text = (ev as OzAgentEvent).text;
      if (!text) return [];
      return [{ kind: "assistant", ts, text }];
    }
    case "agent_reasoning": {
      const text = (ev as OzAgentReasoningEvent).text;
      if (!text) return [];
      return [{ kind: "thinking", ts, text }];
    }
    case "tool_call": {
      const tc = ev as OzToolCallEvent;
      // Build a minimal input object from the known fields
      const { type: _t, tool, ...rest } = tc;
      const input: Record<string, unknown> = {};
      if (tc.command !== undefined) input.command = tc.command;
      else if (tc.path !== undefined) input.path = tc.path;
      else Object.assign(input, rest);
      return [{ kind: "tool_call", ts, name: tool, input }];
    }
    case "tool_result": {
      const tr = ev as OzToolResultEvent;
      const isError =
        tr.status !== "complete" || (tr.exit_code !== undefined && tr.exit_code !== 0);
      return [{
        kind: "tool_result",
        ts,
        toolUseId: "",   // oz doesn't expose tool-use IDs
        toolName: tr.tool,
        content: tr.output ?? "",
        isError,
      }];
    }
    case "system": {
      const sys = ev as OzSystemEvent;
      if (sys.event_type === "run_started" && sys.run_url) {
        return [{ kind: "system", ts, text: `Oz run started: ${sys.run_url}` }];
      }
      // conversation_started and other lifecycle events — suppress
      return [];
    }
    default:
      return [];
  }
}
