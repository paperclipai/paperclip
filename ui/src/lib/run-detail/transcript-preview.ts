import type { TranscriptEntry } from "../../adapters";
import { agentDetailUi } from "../i18n.js";

const MAX_PREVIEW_LINES = 8;
const MAX_LINE_CHARS = 140;

function entryPreviewLine(entry: TranscriptEntry): string | null {
  const kindLabel = agentDetailUi.transcriptEntryKindLabel(entry.kind === "tool_call" ? "tool_call" : entry.kind === "tool_result" ? "tool_result" : entry.kind);
  
  switch (entry.kind) {
    case "stdout":
      return `[${kindLabel}] ${entry.text.trim()}`;
    case "stderr":
      return `[${kindLabel}] ${entry.text.trim()}`;
    case "system":
      return `[${kindLabel}] ${entry.text.trim()}`;
    case "assistant":
      return `[${kindLabel}] ${entry.text.trim()}`;
    case "user":
      return `[${kindLabel}] ${entry.text.trim()}`;
    case "thinking":
      return `[${kindLabel}] ${entry.text.trim()}`;
    case "tool_call":
      return `[${kindLabel}] ${entry.name}`;
    case "tool_result":
      return `[${kindLabel}] ${entry.isError ? "错误" : "正常"}`;
    case "init":
      return `[${kindLabel}] ${entry.model}`;
    case "result":
      return `[${kindLabel}] ${entry.text?.trim() ?? ""}`;
    case "diff":
      return `[${kindLabel}] ${entry.changeType}`;
    default:
      return null;
  }
}

export function formatTranscriptPreview(entries: TranscriptEntry[]): string | null {
  if (entries.length === 0) return null;
  const lines: string[] = [];
  for (const entry of entries) {
    const line = entryPreviewLine(entry);
    if (!line) continue;
    const trimmed =
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
    lines.push(trimmed);
    if (lines.length >= MAX_PREVIEW_LINES) break;
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export function formatRawLogPreview(content: string, maxChars = 1200): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
}
