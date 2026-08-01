/**
 * Live adapter: map a run's streaming TranscriptEntry[] (from
 * useLiveRunTranscripts — the same source the current thread consumes) into the
 * redesign's TaskChatItem[]. This is what lets a real task stream
 * thinking → tool → diff → responding while a run is in flight, rather than
 * only showing the final message once the turn produces a comment.
 */
import type { TranscriptEntry } from "@/adapters";
import type {
  TaskChatDiff,
  TaskChatItem,
  TaskChatToolItem,
  TaskChatTurnItem,
} from "./task-chat-model";
import { isGenericToolName, mcpToolSegment, toolTaxonomy } from "./tool-taxonomy";

const TERMINAL_STATUSES = new Set([
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "succeeded",
]);

export function isTerminalRunStatus(status: string | undefined | null): boolean {
  return status != null && TERMINAL_STATUSES.has(status);
}

function diffKind(changeType: string): "add" | "remove" | "context" {
  if (changeType === "add") return "add";
  if (changeType === "remove") return "remove";
  return "context";
}

/** Param keys probed (in order) for a tool call's one-line mono "target". */
const TARGET_KEYS = [
  "file_path",
  "path",
  "notebook_path",
  "command",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
  "skill",
  "subject",
] as const;

const TARGET_MAX = 96;

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Summarize a tool call's input into the v7 toolrow target: the most
 * identifying parameter when the input is a keyed object, else a clipped
 * rendering of the raw input. Returns undefined when there is nothing useful.
 */
export function summarizeToolInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === "string") return input.trim() ? clip(input, TARGET_MAX) : undefined;
  if (typeof input !== "object") return clip(String(input), TARGET_MAX);
  const record = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(value, TARGET_MAX);
  }
  // The acpx log parser synthesizes { text, status } onto tool inputs from the
  // event's summary line — presentation noise, not call parameters.
  const entries = Object.entries(record).filter(
    ([k, v]) =>
      (typeof v === "string" || typeof v === "number" || typeof v === "boolean") &&
      k !== "text" &&
      k !== "status",
  );
  if (entries.length === 0) return undefined;
  return clip(entries.map(([k, v]) => `${k}: ${String(v)}`).join(", "), TARGET_MAX);
}

/**
 * Display name for a tool call. Live acpx `tool_call` events carry real names
 * ("Read", "Bash", mcp__server__tool); legacy stored logs may not — those fall
 * back to a generic "Tool" row. MCP names collapse to their tool segment.
 */
export function toolDisplayName(name: string | undefined | null): string {
  const raw = (name ?? "").trim();
  if (isGenericToolName(raw)) return "Tool";
  const mcp = mcpToolSegment(raw);
  if (mcp) return mcp;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** "Thought for Ns" once a coalesced thinking group spans ≥1s. */
function thoughtDurationLabel(startTs: string | undefined, endTs: string): string | undefined {
  if (!startTs) return undefined;
  const start = Date.parse(startTs);
  const end = Date.parse(endTs);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const secs = Math.round((end - start) / 1000);
  if (secs < 1) return undefined;
  return secs < 60 ? `Thought for ${secs}s` : `Thought for ${Math.floor(secs / 60)}m ${secs % 60}s`;
}

const DETAIL_MAX = 600;

/** Result content → the expandable mono detail block (clipped, trimmed). */
function formatToolResultDetail(content: unknown): string | undefined {
  if (content == null) return undefined;
  const text = typeof content === "string" ? content : String(content);
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > DETAIL_MAX ? `${trimmed.slice(0, DETAIL_MAX)}\n…` : trimmed;
}

interface TranscriptAdapterOptions {
  runId: string;
  agentName?: string;
  /** True while the run is still in flight (drives streaming cursors). */
  running: boolean;
}

/**
 * Reduce a transcript into ordered items, coalescing consecutive thinking and
 * assistant deltas and threading tool_result/diff onto their tool_call. Mirrors
 * buildAssistantPartsFromTranscript's grouping, emitting our presentation model.
 */
export function transcriptToTaskChatItems(
  entries: readonly TranscriptEntry[],
  { runId, agentName, running }: TranscriptAdapterOptions,
): TaskChatItem[] {
  const items: TaskChatItem[] = [];
  const toolIndexById = new Map<string, number>();
  const thinkingStartTs = new Map<number, string>();
  let lastToolIndex = -1;
  let thinkingIndex = -1;
  let messageIndex = -1;

  const resetInline = () => {
    thinkingIndex = -1;
    messageIndex = -1;
  };

  for (const [i, entry] of entries.entries()) {
    switch (entry.kind) {
      case "thinking": {
        if (!entry.text) break;
        if (thinkingIndex >= 0) {
          const it = items[thinkingIndex];
          if (it.kind === "thinking") {
            it.lines.push(...entry.text.split("\n"));
            const startTs = thinkingStartTs.get(thinkingIndex);
            const label = thoughtDurationLabel(startTs, entry.ts);
            if (label) it.summaryLabel = label;
          }
        } else {
          items.push({
            id: `${runId}:think:${i}`,
            kind: "thinking",
            lines: entry.text.split("\n"),
            streaming: running,
            // Settled history folds its thinking behind the header (v7);
            // the in-flight run streams it expanded.
            collapsed: !running,
          });
          thinkingIndex = items.length - 1;
          thinkingStartTs.set(thinkingIndex, entry.ts);
          messageIndex = -1;
        }
        break;
      }
      case "assistant": {
        if (!entry.text) break;
        if (messageIndex >= 0) {
          const it = items[messageIndex];
          if (it.kind === "message") it.text += entry.text;
        } else {
          items.push({
            id: `${runId}:msg:${i}`,
            kind: "message",
            author: "agent",
            authorName: agentName,
            text: entry.text,
            streaming: running,
          });
          messageIndex = items.length - 1;
          thinkingIndex = -1;
        }
        break;
      }
      case "tool_call": {
        const toolCallId = entry.toolUseId || `tool-${i}`;
        const existingIndex = toolIndexById.get(toolCallId);
        const existing = existingIndex != null ? items[existingIndex] : undefined;
        if (existing?.kind === "tool") {
          // tool_call_update for a call already in the list: merge. Updates
          // often omit the title (acpx fills in a literal "tool call"), so a
          // generic name must never displace the initial call's real one. ACP
          // also retitles a call to its invocation once known ("Terminal" →
          // "ls -la"); that is detail for the target slot, not a new identity.
          if (!isGenericToolName(entry.name)) {
            if (isGenericToolName(existing.rawName)) {
              existing.name = toolDisplayName(entry.name);
              existing.rawName = entry.name ?? undefined;
            } else if (!existing.target && entry.name !== existing.rawName) {
              existing.target = clip(entry.name!, TARGET_MAX);
            }
          }
          lastToolIndex = existingIndex!;
        } else {
          items.push({
            id: `${runId}:tool:${toolCallId}`,
            kind: "tool",
            name: toolDisplayName(entry.name),
            rawName: entry.name ?? undefined,
            target: summarizeToolInput(entry.input),
            status: "in_progress",
          });
          toolIndexById.set(toolCallId, items.length - 1);
          lastToolIndex = items.length - 1;
        }
        resetInline();
        break;
      }
      case "tool_result": {
        const toolCallId = entry.toolUseId || `tool-result-${i}`;
        const idx = toolIndexById.get(toolCallId);
        if (idx != null) {
          const existing = items[idx];
          if (existing.kind === "tool") {
            existing.status = entry.isError ? "failed" : "completed";
            if (isGenericToolName(existing.rawName) && !isGenericToolName(entry.toolName)) {
              existing.name = toolDisplayName(entry.toolName);
              existing.rawName = entry.toolName;
            }
            if (!existing.detail) {
              const detail = formatToolResultDetail(entry.content);
              if (detail) existing.detail = detail;
            }
          }
        }
        resetInline();
        break;
      }
      case "diff": {
        const line = { kind: diffKind(entry.changeType), text: entry.text ?? "" };
        if (lastToolIndex >= 0 && items[lastToolIndex].kind === "tool") {
          const tool = items[lastToolIndex] as TaskChatToolItem;
          const diff: TaskChatDiff = tool.diff ?? { added: 0, removed: 0, lines: [] };
          diff.lines = diff.lines ?? [];
          diff.lines.push(line);
          if (line.kind === "add") diff.added += 1;
          if (line.kind === "remove") diff.removed += 1;
          tool.diff = diff;
        } else {
          items.push({
            id: `${runId}:diff:${i}`,
            kind: "tool",
            name: "Edit",
            status: "completed",
            diff: {
              added: line.kind === "add" ? 1 : 0,
              removed: line.kind === "remove" ? 1 : 0,
              lines: [line],
            },
          });
          lastToolIndex = items.length - 1;
        }
        resetInline();
        break;
      }
      // init / result / stderr / stdout / system / user carry no thread-visible
      // content in the live turn (status is rendered separately).
      default:
        break;
    }
  }

  return items;
}

function formatDurationLabel(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 1) return "1s";
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

function formatTokensLabel(tokens: number): string | undefined {
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;
  const label = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
  return `${label} tokens`;
}

/**
 * Aggregate a turn's transcript into the folded one-line summary
 * ("✓ Worked · 38s · 3 tools · +34 −3 · 12.3k tokens"). Duration prefers the
 * caller-supplied run duration and falls back to the transcript's ts span.
 */
export function buildTurnSummary(
  entries: readonly TranscriptEntry[],
  opts: { durationMs?: number; failed?: boolean } = {},
): TaskChatTurnItem["summary"] {
  const toolIds = new Set<string>();
  let added = 0;
  let removed = 0;
  let tokens = 0;
  for (const [i, entry] of entries.entries()) {
    // Each status change of a call logs its own tool_call entry sharing the
    // toolUseId; count unique calls so the folded summary matches the rows the
    // expanded list renders (same `tool-${i}` fallback as the parser above).
    if (entry.kind === "tool_call") toolIds.add(entry.toolUseId || `tool-${i}`);
    else if (entry.kind === "diff") {
      if (entry.changeType === "add") added += 1;
      else if (entry.changeType === "remove") removed += 1;
    } else if (entry.kind === "result") {
      tokens += (entry.inputTokens || 0) + (entry.outputTokens || 0);
    }
  }
  let durationMs = opts.durationMs;
  if (durationMs == null && entries.length >= 2) {
    const first = Date.parse(entries[0].ts);
    const last = Date.parse(entries[entries.length - 1].ts);
    if (Number.isFinite(first) && Number.isFinite(last)) durationMs = last - first;
  }
  return {
    durationLabel: durationMs != null ? formatDurationLabel(durationMs) : undefined,
    toolCount: toolIds.size,
    added,
    removed,
    tokensLabel: formatTokensLabel(tokens),
    failed: opts.failed || undefined,
  };
}

/**
 * Human-readable label for the live status pill from the tail of a transcript.
 * A tail tool_call yields the taxonomy verb ("Searching", "Running a command")
 * with tool + target as detail; `toolName` lets the pill show the family icon.
 */
export function deriveRunStatusLabel(entries: readonly TranscriptEntry[]): {
  label: string;
  detail?: string;
  toolName?: string;
} {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind === "tool_call") {
      // A tail update may carry the generic placeholder name or a retitle to
      // the invocation ("Terminal" → "ls -la"): the call's FIRST real name is
      // its identity, and a differing later title is the invocation detail.
      let name = entry.name;
      let invocation: string | undefined;
      if (entry.toolUseId) {
        for (const prev of entries) {
          if (prev === entry) break;
          if (
            prev.kind === "tool_call" &&
            prev.toolUseId === entry.toolUseId &&
            !isGenericToolName(prev.name)
          ) {
            if (!isGenericToolName(entry.name) && entry.name !== prev.name) {
              invocation = entry.name;
            }
            name = prev.name;
            break;
          }
        }
      }
      const target =
        summarizeToolInput(entry.input) ?? (invocation ? clip(invocation, TARGET_MAX) : undefined);
      const display = toolDisplayName(name);
      return {
        label: toolTaxonomy(name).verbLabel,
        detail: target ? `${display} · ${target}` : display,
        toolName: name ?? undefined,
      };
    }
    if (entry.kind === "tool_result") break;
    if (entry.kind === "assistant") return { label: "Responding" };
    if (entry.kind === "thinking") return { label: "Thinking" };
  }
  return { label: "Running" };
}
