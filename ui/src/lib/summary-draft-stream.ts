import type { RunLogChunk } from "../adapters";

/**
 * Streaming-summary output protocol parser (see the `summarize-status` skill).
 *
 * The Summarizer emits, as plain assistant text (never inside a tool call):
 *   - `STATUS: <action>…` lines, one before each procedure step; and
 *   - the final Markdown wrapped between the exact sentinels
 *     `<<<SUMMARY-DRAFT>>>` and `<<<END-SUMMARY-DRAFT>>>`, each on its own line,
 *     immediately before the authoritative summary-slot write.
 *
 * The card re-parses the full accumulated assistant text on every render, so
 * markers split across streaming delta boundaries rejoin naturally once both
 * halves have arrived. Markers are only recognized at the start of a line, so
 * incidental occurrences inside prose or a partially-streamed marker never
 * trigger a false draft.
 */

export const SUMMARY_DRAFT_START = "<<<SUMMARY-DRAFT>>>";
export const SUMMARY_DRAFT_END = "<<<END-SUMMARY-DRAFT>>>";

const STATUS_LINE_RE = /^STATUS:[ \t]?(.*)$/gm;
const DRAFT_START_RE = /^<<<SUMMARY-DRAFT>>>[ \t]*$/m;
const DRAFT_END_RE = /^<<<END-SUMMARY-DRAFT>>>[ \t]*$/m;

export interface SummaryDraftParse {
  /** Latest `STATUS:` line (prefix stripped), or null if none has streamed. */
  statusLine: string | null;
  /** Every `STATUS:` line seen so far, in order. */
  statusLines: string[];
  /** Accumulated draft Markdown; may be partial while streaming. */
  draft: string | null;
  /** True once the closing sentinel has arrived. */
  draftClosed: boolean;
}

const EMPTY_PARSE: SummaryDraftParse = {
  statusLine: null,
  statusLines: [],
  draft: null,
  draftClosed: false,
};

/**
 * Extract the assistant "output"-channel prose from accumulated run-log chunks.
 * Only `acpx.text_delta` records on the output channel carry the STATUS lines
 * and sentinel-wrapped draft; thought-channel deltas and tool-call records are
 * ignored. Chunks are assumed to already be in emit order.
 */
export function extractAssistantOutputText(chunks: RunLogChunk[]): string {
  let text = "";
  for (const chunk of chunks) {
    const record = tryParseRecord(chunk.chunk);
    if (!record) continue;
    if (record.type !== "acpx.text_delta") continue;
    const channel = typeof record.channel === "string" ? record.channel : "output";
    if (channel === "thought" || channel === "thinking") continue;
    if (typeof record.text === "string") text += record.text;
  }
  return text;
}

function tryParseRecord(chunk: string): Record<string, unknown> | null {
  const trimmed = chunk.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parse the accumulated assistant text into status lines and the draft body. */
export function parseSummaryDraftStream(text: string): SummaryDraftParse {
  if (!text) return EMPTY_PARSE;

  const statusLines: string[] = [];
  STATUS_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STATUS_LINE_RE.exec(text)) !== null) {
    const value = (match[1] ?? "").trim();
    if (value) statusLines.push(value);
  }
  const statusLine = statusLines.length > 0 ? statusLines[statusLines.length - 1]! : null;

  const startMatch = text.match(DRAFT_START_RE);
  let draft: string | null = null;
  let draftClosed = false;
  if (startMatch && startMatch.index !== undefined) {
    const afterStart = text.slice(startMatch.index + startMatch[0].length).replace(/^\r?\n/, "");
    const endMatch = afterStart.match(DRAFT_END_RE);
    if (endMatch && endMatch.index !== undefined) {
      draft = afterStart.slice(0, endMatch.index).replace(/\r?\n$/, "");
      draftClosed = true;
    } else {
      draft = afterStart;
      draftClosed = false;
    }
  }

  return { statusLine, statusLines, draft, draftClosed };
}

/**
 * Guard partial Markdown for live rendering: if the streamed draft ends inside
 * an unclosed fenced code block, append a closing fence so `react-markdown`
 * renders the partial code as a block instead of swallowing the rest of the
 * document. Only needed while the draft is still streaming.
 */
export function closeDanglingCodeFence(markdown: string): string {
  const fences = markdown.match(/^```/gm);
  if (fences && fences.length % 2 === 1) {
    const needsNewline = markdown.length > 0 && !markdown.endsWith("\n");
    return `${markdown}${needsNewline ? "\n" : ""}\`\`\``;
  }
  return markdown;
}
