/**
 * Strip ANSI escape sequences (CSI, OSC) from terminal text.
 * Same pattern used in claude-local adapter quota.ts.
 */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

/**
 * Parse Hermes Agent stdout into TranscriptEntry objects for the Paperclip UI.
 *
 * Hermes CLI quiet-mode output patterns:
 *   Assistant:  "  ┊ 💬 {text}"
 *   Tool (TTY): "  ┊ {emoji} {verb:9} {detail}  {duration}"
 *   Tool (pipe): "  [done] ┊ {emoji} {verb:9} {detail}  {duration} ({total})"
 *   System:     "[hermes] ..."
 *
 * We emit structured tool_call/tool_result pairs so Paperclip renders proper
 * tool cards (with status icons, expand/collapse) instead of raw stdout blocks.
 */

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

import { TOOL_OUTPUT_PREFIX } from "../shared/constants.js";

// ── Kaomoji / noise stripping ──────────────────────────────────────────────

/**
 * Strip kawaii faces and decorative emoji from a tool summary line.
 * Leaves meaningful emoji (💻 for terminal, 🔍 for search, etc.) intact
 * by only stripping parenthesized kaomoji like (｡◕‿◕｡).
 */
function stripKaomoji(text: string): string {
  // Strip parenthesized kaomoji faces: (｡◕‿◕｡), (★ω★), etc.
  return text.replace(/[(][^()]{2,20}[)]\s*/gu, "").trim();
}

// ── Line classification ────────────────────────────────────────────────────

/** Check if a ┊ line is an assistant message (┊ 💬 ...). */
function isAssistantToolLine(stripped: string): boolean {
  return /^┊\s*💬/.test(stripped);
}

/** Extract assistant text from a ┊ 💬 line. */
function extractAssistantText(line: string): string {
  return line.replace(/^[\s┊]*💬\s*/, "").trim();
}

/**
 * Parse a tool completion line into structured data.
 *
 * Handles both TTY and pipe formats:
 *   TTY:  ┊ 💻 $         curl -s "..."  0.1s
 *   Pipe: [done] ┊ 💻 $   curl -s "..."  0.1s (0.5s)
 */
function parseToolCompletionLine(
  line: string,
): { name: string; detail: string; duration: string; hasError: boolean } | null {
  // Strip leading whitespace and [done] prefix
  let cleaned = line.trim().replace(/^\[done\]\s*/, "");

  // Must start with ┊
  if (!cleaned.startsWith(TOOL_OUTPUT_PREFIX)) return null;

  // Remove ┊ prefix and any leading kaomoji face
  cleaned = cleaned.slice(TOOL_OUTPUT_PREFIX.length);
  cleaned = stripKaomoji(cleaned).trim();

  // Now format is: "{emoji} {verb:9} {detail}  {duration}" or "{emoji} {verb:9} {detail}  {duration} ({total})"
  // Example: "💻 $         curl -s ..." or "🔍 search    pattern  0.1s"
  // The verb+detail are separated by whitespace, duration is at the end

  // Match: emoji + verb + detail + duration
  // Duration pattern: N.Ns (possibly followed by (N.Ns))
  const durationMatch = cleaned.match(/([\d.]+s)\s*(?:\([\d.]+s\))?\s*$/);
  const duration = durationMatch ? durationMatch[1] : "";

  // Remove duration from the end to get verb + detail
  let verbAndDetail = durationMatch
    ? cleaned.slice(0, cleaned.lastIndexOf(durationMatch[0])).trim()
    : cleaned;
  verbAndDetail = verbAndDetail.replace(/^\p{Emoji_Presentation}\s*/u, "");

  // Check for error suffixes
  const hasError = /\[(?:exit \d+|error|full)\]/.test(verbAndDetail) ||
    /\[error\]\s*$/.test(cleaned);

  // The first token (after emoji) is the verb, rest is detail
  // Verbs are always a single word or symbol ($ for terminal)
  const parts = verbAndDetail.match(/^(\S+)\s+(.*)/);
  if (!parts) {
    return { name: "tool", detail: verbAndDetail, duration, hasError };
  }

  const verb = parts[1];
  const detail = parts[2].trim();

  // Map Hermes verbs to readable tool names
  const nameMap: Record<string, string> = {
    "$": "shell",
    "exec": "shell",
    "terminal": "shell",
    "search": "search",
    "fetch": "fetch",
    "crawl": "crawl",
    "navigate": "browser",
    "snapshot": "browser",
    "click": "browser",
    "type": "browser",
    "scroll": "browser",
    "back": "browser",
    "press": "browser",
    "close": "browser",
    "images": "browser",
    "vision": "browser",
    "read": "read",
    "write": "write",
    "patch": "patch",
    "grep": "search",
    "find": "search",
    "plan": "plan",
    "recall": "recall",
    "proc": "process",
    "delegate": "delegate",
    "todo": "todo",
    "memory": "memory",
    "clarify": "clarify",
    "session_search": "recall",
    "code": "execute",
    "execute": "execute",
    "web_search": "search",
    "web_extract": "fetch",
    "browser_navigate": "browser",
    "browser_click": "browser",
    "browser_type": "browser",
    "browser_snapshot": "browser",
    "browser_vision": "browser",
    "browser_scroll": "browser",
    "browser_press": "browser",
    "browser_back": "browser",
    "browser_close": "browser",
    "browser_get_images": "browser",
    "read_file": "read",
    "write_file": "write_file",
    "search_files": "search",
    "patch_file": "patch",
    "execute_code": "execute",
  };

  const name = nameMap[verb.toLowerCase()] || verb;

  return { name, detail, duration, hasError };
}

// ── Synthetic tool ID generation ────────────────────────────────────────────

let toolCallCounter = 0;

/**
 * Generate a synthetic toolUseId for pairing tool_call with tool_result.
 * Paperclip uses this to match them in normalizeTranscript.
 */
function syntheticToolUseId(): string {
  return `hermes-tool-${++toolCallCounter}`;
}

// ── Reasoning box (quiet mode) ─────────────────────────────────────────────

/**
 * Hermes CLI quiet mode (pipe/TTY) renders reasoning as a dim TUI box:
 *
 *   ┌─ Reasoning ───────────────────────────────────────────────┐
 *    wrapped reasoning text, one terminal line per chunk
 *   └───────────────────────────────────────────────────────────┘
 *
 * The opening border carries the literal title `Reasoning`; the closing
 * border is a bare └─…─┘ rule. The closing border can arrive glued to the
 * tail of the last interior text line in the same chunk, so interior lines
 * also strip a trailing border rule.
 *
 * Border width varies with the terminal width, so only the box glyphs are
 * matched, never a fixed column count.
 */
const REASONING_BOX_OPEN = /^┌─\s*Reasoning\s*─+┐$/u;
const REASONING_BOX_CLOSE = /^└─+┘$/u;
const REASONING_BOX_CLOSE_TRAILING = /└─+┘$/u;

/**
 * Strip a trailing closing-border rule from an interior line.
 * Returns the original string when no border is attached.
 */
function stripTrailingReasoningBorder(text: string): string {
  return text.replace(REASONING_BOX_CLOSE_TRAILING, "").trim();
}

/**
 * Build the thinking entry for one wrapped Reasoning-box line.
 *
 * `delta: true` coalesces consecutive wrapped lines into a single thinking
 * bubble (appendTranscriptEntry) — the issue chat keeps only ~30 visible
 * transcript entries, so one entry per wrapped line would flood the window.
 * Hermes wraps reasoning at the terminal width and drops the trailing space
 * at each break, so every line carries an explicit newline to keep words from
 * fusing; markdown renders that soft break back into a space.
 *
 * Every interior line carries `delta: true`: appendTranscriptEntry only merges
 * into a chain whose head is also a delta, so a `delta: false` head would split
 * each box into two bubbles. The cost is that two Reasoning boxes emitted back
 * to back share one bubble — the delta contract has no way to start a new
 * segment within the same kind, and a fragmented box is worse than a merged
 * pair of adjacent boxes.
 */
function reasoningLineEntry(text: string, ts: string): TranscriptEntry {
  return { kind: "thinking", ts, text: `${text}\n`, delta: true };
}

// ── Thinking detection ─────────────────────────────────────────────────────

function isThinkingLine(line: string): boolean {
  return (
    line.includes("💭") ||
    line.startsWith("<thinking>") ||
    line.startsWith("</thinking>") ||
    line.startsWith("Thinking:")
  );
}

// ── Main parser ────────────────────────────────────────────────────────────

/**
 * Stateful stdout parser. The Reasoning box spans many lines, so the parser
 * tracks whether a box is open across calls.
 *
 * `reset` lets the transcript builder clear that state (buildTranscript calls
 * it when a line fails to parse and when a transcript build finishes).
 */
export interface HermesStdoutParser {
  parseLine: (line: string, ts: string) => TranscriptEntry[];
  reset: () => void;
}

/**
 * Create a fresh parser with its own Reasoning-box state.
 *
 * Consumers that parse one transcript at a time should prefer this; the
 * module-level {@link parseHermesStdoutLine} convenience below shares a single
 * instance, which is safe because both call sites (the direct TS import in
 * hermes-local and the eval'd sandboxed worker) keep one parser per adapter.
 */
export function createStdoutParser(): HermesStdoutParser {
  let inReasoningBox = false;

  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      const trimmed = stripAnsi(line).trim();
      if (!trimmed) return [];

      // ── Reasoning box (checked before everything else) ──────────────────
      // Interior lines are dim reasoning text; a box that never closes must
      // not leak its body into assistant output, so classify eagerly.
      if (inReasoningBox) {
        if (REASONING_BOX_CLOSE.test(trimmed)) {
          inReasoningBox = false;
          return [];
        }

        // Closing border glued to the tail of the last text line.
        const withoutBorder = stripTrailingReasoningBorder(trimmed);
        if (withoutBorder !== trimmed) {
          inReasoningBox = false;
          return withoutBorder ? [reasoningLineEntry(withoutBorder, ts)] : [];
        }

        return [reasoningLineEntry(trimmed, ts)];
      }

      if (REASONING_BOX_OPEN.test(trimmed)) {
        inReasoningBox = true;
        return [];
      }

      // ── System/adapter messages ────────────────────────────────────────
  if (trimmed.startsWith("[hermes]") || trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // ── Non-quiet mode tool start lines: [tool] (kaomoji) emoji verb ... ──
  // These are redundant — the tool_call/tool_result pair arrives later from
  // the ┊ completion line. Skip them to avoid duplicate entries.
  if (trimmed.startsWith("[tool]")) {
    return [];
  }

  // ── MCP / server init noise reclassified from stderr by wrappedOnLog ──
  // Pattern: [2026-03-25T10:40:53.941Z] INFO: ...
  // Emit as stderr so Paperclip groups them into the amber accordion.
  if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  // ── Standalone spinner remnants: "💻 Completed", "💻\nCompleted", etc. ─
  // These are non-quiet mode spinner frame leftovers — skip them.
  if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(trimmed)) {
    return [];
  }

  // ── Session info line ────────────────────────────────────────────────
  if (trimmed.startsWith("session_id:")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // ── Quiet-mode tool/message lines (prefixed with ┊) ────────────────────
  if (trimmed.includes(TOOL_OUTPUT_PREFIX)) {
    // Assistant message: ┊ 💬 {text}
    if (isAssistantToolLine(trimmed)) {
      return [{ kind: "assistant", ts, text: extractAssistantText(trimmed) }];
    }

    // Tool completion: ┊ {emoji} {verb} {detail} {duration}
    const toolInfo = parseToolCompletionLine(trimmed);
    if (toolInfo) {
      const id = syntheticToolUseId();
      const detailText = toolInfo.duration
        ? `${toolInfo.detail}  ${toolInfo.duration}`
        : toolInfo.detail;

      return [
        {
          kind: "tool_call" as const,
          ts,
          name: toolInfo.name,
          input: { detail: toolInfo.detail },
          toolUseId: id,
        },
        {
          kind: "tool_result" as const,
          ts,
          toolUseId: id,
          content: detailText,
          isError: toolInfo.hasError,
        },
      ] as TranscriptEntry[];
    }

    // Fallback: raw ┊ line that doesn't match tool format
    const stripped = trimmed
      .replace(/^\[done\]\s*/, "")
      .replace(new RegExp(`^${TOOL_OUTPUT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
      .trim();
    return [{ kind: "stdout", ts, text: stripped }];
  }

  // ── Thinking blocks ────────────────────────────────────────────────────
  if (isThinkingLine(trimmed)) {
    return [
      {
        kind: "thinking",
        ts,
        text: trimmed.replace(/^💭\s*/, ""),
      },
    ];
  }

  // ── Error output ───────────────────────────────────────────────────────
  if (
    trimmed.startsWith("Error:") ||
    trimmed.startsWith("ERROR:") ||
    trimmed.startsWith("Traceback")
  ) {
    return [{ kind: "stderr", ts, text: trimmed }];
  }

  // ── Regular assistant output ───────────────────────────────────────────
      return [{ kind: "assistant", ts, text: trimmed }];
    },

    reset() {
      inReasoningBox = false;
    },
  };
}

/**
 * Shared parser instance backing {@link parseHermesStdoutLine}.
 *
 * One instance per module is correct for both consumers of this contract: the
 * hermes-local UI adapter imports the function directly, and the sandboxed
 * worker evaluates ui-parser.cjs once per adapter and reuses it for every
 * parse request.
 */
const defaultParser = createStdoutParser();

/**
 * Parse a single line of Hermes stdout into transcript entries.
 *
 * Emits structured tool_call/tool_result pairs (with synthetic IDs) so
 * Paperclip renders proper tool cards with status icons and expand/collapse.
 *
 * @param line  Raw stdout line from Hermes CLI
 * @param ts    ISO timestamp for the entry
 * @returns     Array of TranscriptEntry objects (may be empty)
 */
export function parseHermesStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  return defaultParser.parseLine(line, ts);
}

/**
 * Clear Reasoning-box state on the shared instance (test helper).
 */
export function resetHermesStdoutParser(): void {
  defaultParser.reset();
}
