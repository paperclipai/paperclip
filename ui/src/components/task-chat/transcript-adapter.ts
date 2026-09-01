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
  TaskChatActivityPhaseItem,
  TaskChatItem,
  TaskChatToolItem,
  TaskChatTurnChildItem,
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

/**
 * The live parent row's nesting rule (PAP-354, narrowed by PAP-361): only tool
 * calls and usage readouts nest inside the expandable live turn. Messages
 * never nest — an interstitial update streams on the parent row's own line
 * (TaskChatStatusItem.selfTalk) and vanishes when it completes, and the run's
 * final reply lands as its posted comment bubble. Thinking never nests either:
 * its live signal is the pill's "Thinking…" state, and the text stays in the
 * run log / classic transcript. Markers, statuses and interaction cards stay
 * in the thread outside.
 */
export function isNestableLiveChild(item: TaskChatItem): item is TaskChatTurnChildItem {
  return item.kind === "tool" || item.kind === "usage" || item.kind === "activity_phase";
}

/**
 * Flatten markdown-ish interstitial text to one plain line for the live parent
 * row. Stream-safe: markers are stripped without requiring pairs.
 */
export function flattenSelfTalk(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, " ")
    .replace(/`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/\*+/g, "")
    .replace(/__/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
  let thinkingChannel: "summary" | "detail" | "unknown" | undefined;
  let messageIndex = -1;
  let messageChannel: "progress" | "final" | "unknown" | undefined;

  const resetInline = () => {
    thinkingIndex = -1;
    thinkingChannel = undefined;
    messageIndex = -1;
    messageChannel = undefined;
  };

  for (const [i, entry] of entries.entries()) {
    switch (entry.kind) {
      case "thinking": {
        if (!entry.text) break;
        const channel = entry.channel;
        if (thinkingIndex >= 0 && thinkingChannel === channel) {
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
            channel,
          });
          thinkingIndex = items.length - 1;
          thinkingChannel = channel;
          thinkingStartTs.set(thinkingIndex, entry.ts);
          messageIndex = -1;
          messageChannel = undefined;
        }
        break;
      }
      case "assistant": {
        if (!entry.text) break;
        const channel = entry.channel;
        if (messageIndex >= 0 && messageChannel === channel) {
          const it = items[messageIndex];
          if (it.kind === "message") it.text += entry.text;
        } else {
          const atMs = Date.parse(entry.ts);
          items.push({
            id: `${runId}:msg:${i}`,
            kind: "message",
            author: "agent",
            authorName: agentName,
            text: entry.text,
            channel,
            streaming: running,
            // Everything the agent says inside a run turn is self-talk until it
            // lands as the posted comment — live and history tag it alike.
            interstitial: channel !== "final",
            atMs: Number.isFinite(atMs) ? atMs : undefined,
          });
          messageIndex = items.length - 1;
          messageChannel = channel;
          thinkingIndex = -1;
          thinkingChannel = undefined;
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
      case "result": {
        if (
          entry.subtype !== "paperclip_runner_usage" &&
          entry.subtype !== "paperclip_runner_session_usage"
        ) break;
        const inputTokens = entry.inputTokens || 0;
        const outputTokens = entry.outputTokens || 0;
        items.push({
          id: `${runId}:usage:${i}`,
          kind: "usage",
          ...(entry.subtype === "paperclip_runner_session_usage"
            ? {
                label: "Provider session total",
                detail:
                  entry.text ||
                  "This cumulative usage can include earlier runs in the resumed provider session.",
              }
            : {}),
          usage: {
            used: inputTokens + outputTokens + (entry.cachedTokens || 0),
            size: 0,
            inputTokens,
            outputTokens,
            ...(entry.costUsd > 0 ? { costUsd: entry.costUsd } : {}),
          },
        });
        resetInline();
        break;
      }
      // init / stderr / stdout / system / user and non-runner result entries
      // carry no thread-visible content (status is rendered separately).
      default:
        break;
    }
  }

  // Only the message still open at the transcript tail is streaming; earlier
  // self-talk is finished and nests as a settled row even mid-run.
  if (running) {
    for (const [idx, it] of items.entries()) {
      if (it.kind === "message" && idx !== messageIndex) it.streaming = false;
    }
  }

  return items;
}

/**
 * A settled run's nested children: activity phases containing chronological
 * tool rows and their historical interstitial boundary. The final reply is
 * excluded because its posted comment is canonical. Thinking stays in the
 * run log / classic transcript.
 */
export function settledRunChildren(parsed: readonly TaskChatItem[]): TaskChatTurnChildItem[] {
  return buildActivityPhases(parsed, false);
}

function phaseSummary(items: readonly (TaskChatToolItem | { kind: "usage" })[]): string {
  const counts = new Map<string, number>();
  let generic = 0;
  for (const item of items) {
    if (item.kind !== "tool") continue;
    if (isGenericToolName(item.rawName ?? item.name)) {
      generic += 1;
      continue;
    }
    const family = toolTaxonomy(item.rawName ?? item.name).family;
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const phrases: string[] = [];
  const add = (family: string, verb: string, singular: string, plural: string) => {
    const count = counts.get(family) ?? 0;
    if (count) phrases.push(`${verb} ${count} ${count === 1 ? singular : plural}`);
  };
  add("read", "Read", "file", "files");
  add("edit", "Edited", "file", "files");
  add("terminal", "Ran", "command", "commands");
  const searched = (counts.get("grep") ?? 0) + (counts.get("search") ?? 0);
  if (searched) phrases.push(`Searched ${searched} ${searched === 1 ? "time" : "times"}`);
  const known = new Set(["read", "edit", "terminal", "grep", "search"]);
  const other = [...counts].reduce((n, [family, count]) => n + (known.has(family) ? 0 : count), 0) + generic;
  if (other) phrases.push(`Called ${other} ${other === 1 ? "tool" : "tools"}`);
  return phrases.join(", ") || "No tool activity";
}

/** Segment parsed transcript rows at assistant boundaries with stable run-derived ids. */
export function buildActivityPhases(
  parsed: readonly TaskChatItem[],
  running: boolean,
): TaskChatActivityPhaseItem[] {
  const phases: TaskChatActivityPhaseItem[] = [];
  let current: TaskChatActivityPhaseItem | null = null;
  const ensureOpening = (seed: string) => {
    if (!current) {
      current = { id: `${seed}:phase:opening`, kind: "activity_phase", items: [], summary: "", active: false };
      phases.push(current);
    }
    return current;
  };
  const lastVisible = [...parsed].reverse().find((item) => item.kind !== "thinking");
  for (const item of parsed) {
    if (item.kind === "message") {
      // Explicit final-channel replies remain canonical even when a later
      // usage row makes them non-tail. Channel-less legacy transcripts retain
      // the last-visible fallback until the posted reply lands.
      const explicitFinal = item.channel === "final" || item.interstitial === false;
      const legacyTrailingReply =
        (item.channel == null || item.channel === "unknown") && item === lastVisible;
      if (!running && (explicitFinal || legacyTrailingReply)) continue;
      current = {
        id: `${item.id}:phase`,
        kind: "activity_phase",
        interstitial: item,
        items: [],
        summary: "",
        active: false,
      };
      phases.push(current);
    } else if (item.kind === "tool" || item.kind === "usage") {
      ensureOpening(item.id).items.push(item);
    }
  }
  for (const phase of phases) phase.summary = phaseSummary(phase.items);
  const meaningful = phases.filter((phase) => phase.interstitial || phase.items.length > 0);
  if (running && meaningful.length) meaningful[meaningful.length - 1].active = true;
  return meaningful;
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

/** First→last ts span of a transcript, or undefined when unknowable. */
function transcriptSpanMs(entries: readonly TranscriptEntry[]): number | undefined {
  if (entries.length < 2) return undefined;
  const first = Date.parse(entries[0].ts);
  const last = Date.parse(entries[entries.length - 1].ts);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined;
  return Math.max(0, last - first);
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
    } else if (
      entry.kind === "result" &&
      entry.subtype !== "paperclip_runner_session_usage"
    ) {
      // Session-cumulative measurements remain visible in the expanded
      // transcript, but they can include earlier runs. Only run-scoped usage
      // belongs in this turn (and therefore in a merged-turn total).
      tokens += (entry.inputTokens || 0) + (entry.outputTokens || 0);
    }
  }
  const durationMs = opts.durationMs ?? transcriptSpanMs(entries);
  return {
    durationLabel: durationMs != null ? formatDurationLabel(durationMs) : undefined,
    toolCount: toolIds.size,
    added,
    removed,
    tokensLabel: formatTokensLabel(tokens),
    failed: opts.failed || undefined,
  };
}

/** One settled run's raw summary inputs, kept so back-to-back runs can coalesce (PAP-362). */
export interface TurnSummaryPart {
  entries: readonly TranscriptEntry[];
  durationMs?: number;
  failed?: boolean;
}

/**
 * Summary for a turn coalesced from several back-to-back runs (PAP-362).
 * Tool/diff/token counts re-derive from the concatenated transcripts; duration
 * is the SUM of the per-run durations (each with its own ts-span fallback) —
 * never the wall span across the idle gap between runs.
 */
export function buildMergedTurnSummary(
  parts: readonly TurnSummaryPart[],
): TaskChatTurnItem["summary"] {
  const all: TranscriptEntry[] = [];
  let durationMs: number | undefined;
  let failed = false;
  for (const part of parts) {
    all.push(...part.entries);
    if (part.failed) failed = true;
    const d = part.durationMs ?? transcriptSpanMs(part.entries);
    if (d != null && Number.isFinite(d)) durationMs = (durationMs ?? 0) + Math.max(0, d);
  }
  // durationMs: 0 suppresses the concatenated-span fallback (which would count
  // the gap between runs); the summed label is applied over it below.
  const counts = buildTurnSummary(all, { durationMs: 0, failed });
  return {
    ...counts,
    durationLabel: durationMs != null ? formatDurationLabel(durationMs) : undefined,
  };
}

/** One chronological backbone entry (comment / interaction / marker). */
export interface ThreadBackboneEntry {
  /** Chronological sort key in ms (backbone is already sorted by it). */
  ms: number;
  /** Stable entry id — the anchor key settled turns attach after. */
  id: string;
  item: TaskChatItem;
}

/**
 * Assemble the thread body (PAP-367): backbone entries in order, each followed
 * by the settled turns anchored to it (run → reply-comment linkage), with
 * comment-less settled turns — stopped runs, or a reply not yet fetched —
 * interleaved chronologically at their run's start time instead of
 * bottom-appended under the newest message. Ties go after the backbone entry
 * (trigger comment first); turns with no known start (startMs = Infinity) keep
 * the tail slot. `unanchored` must be sorted ascending by startMs.
 */
export function assembleThreadItems(
  entries: readonly ThreadBackboneEntry[],
  turnsByAnchor: ReadonlyMap<string, readonly TaskChatTurnItem[]>,
  unanchored: readonly { turn: TaskChatTurnItem; startMs: number }[],
): TaskChatItem[] {
  const out: TaskChatItem[] = [];
  let next = 0;
  for (const entry of entries) {
    while (next < unanchored.length && unanchored[next].startMs < entry.ms) {
      out.push(unanchored[next++].turn);
    }
    out.push(entry.item);
    const following = turnsByAnchor.get(entry.id);
    if (following) out.push(...following);
  }
  while (next < unanchored.length) out.push(unanchored[next++].turn);
  return out;
}

/** Stable id of the description-as-first-bubble item (PAP-375). */
export const ISSUE_BRIEF_ITEM_ID = "issue-brief";

/**
 * Prepend the issue-brief placeholder (PAP-375) to the fully assembled thread.
 * Running AFTER assembleThreadItems/coalesce/attach makes the ordering
 * guarantee structural rather than data-dependent: even an unanchored settled
 * turn whose startMs predates every backbone entry (F15) lands below the
 * description bubble.
 */
export function prependIssueBrief(items: TaskChatItem[], hasBrief: boolean): TaskChatItem[] {
  if (!hasBrief) return items;
  return [{ id: ISSUE_BRIEF_ITEM_ID, kind: "brief" }, ...items];
}

/** Per-turn identity + raw summary inputs for coalescing (keyed by turn item id). */
export interface SettledTurnMergeMeta {
  /** Stable agent identity (agentId); empty/unknown turns never merge. */
  agentKey: string;
  /** Display name, used to keep another agent's bubble from bridging a merge. */
  agentName?: string;
  parts: TurnSummaryPart[];
}

/**
 * Final assembly pass (PAP-362): merge runs of settled turns from the SAME
 * agent that arrive back-to-back — two runs replying consecutively — into one
 * "Worked" row. The agent's own reply bubbles do not break the run (the merged
 * row lands below the last bubble, in the last run's slot); a human/system
 * message, an interaction, a marker, or the live in-flight turn does. Child
 * items concatenate in order, the summary re-derives via buildMergedTurnSummary,
 * the merged turn keeps the FIRST run's id (stable across re-renders), and
 * animateFold survives if any merged run was seen live.
 */
export function coalesceSettledTurns(
  items: readonly TaskChatItem[],
  metaById: ReadonlyMap<string, SettledTurnMergeMeta>,
): TaskChatItem[] {
  const out: TaskChatItem[] = [];
  // Overlay for merged turns' accumulated parts (metaById stays untouched).
  const mergedMeta = new Map<string, SettledTurnMergeMeta>();
  const metaFor = (id: string) => mergedMeta.get(id) ?? metaById.get(id);
  let heldIdx = -1; // index in `out` of the last mergeable settled turn
  for (const item of items) {
    if (item.kind === "turn" && item.settled) {
      const meta = metaFor(item.id);
      const held = heldIdx >= 0 ? (out[heldIdx] as TaskChatTurnItem) : null;
      const heldMeta = held ? metaFor(held.id) : undefined;
      if (held && meta && heldMeta && meta.agentKey && meta.agentKey === heldMeta.agentKey) {
        out.splice(heldIdx, 1);
        const parts = [...heldMeta.parts, ...meta.parts];
        out.push({
          ...held,
          items: [...held.items, ...item.items],
          animateFold: held.animateFold || item.animateFold || undefined,
          summary: buildMergedTurnSummary(parts),
        });
        mergedMeta.set(held.id, { ...heldMeta, parts });
      } else {
        out.push(item);
      }
      heldIdx = meta?.agentKey ? out.length - 1 : -1;
      continue;
    }
    out.push(item);
    if (item.kind === "message" && item.author === "agent") {
      // The same agent's reply bubble sits between its runs — keep merging
      // across it. A different agent's bubble ends the run of turns.
      const heldMeta = heldIdx >= 0 ? metaFor((out[heldIdx] as TaskChatTurnItem).id) : undefined;
      if (heldMeta?.agentName && item.authorName && item.authorName !== heldMeta.agentName) {
        heldIdx = -1;
      }
    } else {
      heldIdx = -1;
    }
  }
  return out;
}

/**
 * Final assembly pass (round 9, after coalesceSettledTurns): a settled turn
 * that directly follows its own agent's reply bubble folds INTO that bubble as
 * `attachedTurn` — the "Worked · …" summary renders appended to the bubble's
 * always-visible timestamp line instead of as a standalone row. The turn must
 * belong to the same agent as the bubble (metaById identity); turns without
 * meta, or preceded by anything other than that agent's non-interstitial
 * bubble, keep the standalone-row fallback.
 */
export function attachSettledTurns(
  items: readonly TaskChatItem[],
  metaById: ReadonlyMap<string, SettledTurnMergeMeta>,
): TaskChatItem[] {
  const out: TaskChatItem[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (
      item.kind === "turn" &&
      item.settled &&
      prev?.kind === "message" &&
      prev.author === "agent" &&
      !prev.interstitial &&
      !prev.streaming &&
      prev.attachedTurn == null
    ) {
      const meta = metaById.get(item.id);
      const sameAgent =
        meta != null && (meta.agentName == null || prev.authorName == null || meta.agentName === prev.authorName);
      if (sameAgent) {
        out[out.length - 1] = { ...prev, attachedTurn: item };
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

/**
 * Human-readable label for the live status pill from the tail of a transcript.
 * A tail tool_call yields the taxonomy verb ("Searching", "Running a command")
 * with tool + target as detail; `toolName` lets the pill show the family icon.
 * A tail assistant message yields "Responding" plus `selfTalk` — the flattened
 * text of the interstitial update streamed so far, which takes over the parent
 * row's line while it streams (PAP-361).
 */
export function deriveRunStatusLabel(entries: readonly TranscriptEntry[]): {
  label: string;
  detail?: string;
  toolName?: string;
  selfTalk?: string;
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
    if (entry.kind === "assistant") {
      // Accumulate the trailing message's deltas (the same coalescing run the
      // parser groups into one item: broken by tool/thinking/diff, not by
      // status-only entries like stdout).
      const parts: string[] = [];
      for (let j = i; j >= 0; j--) {
        const prev = entries[j];
        if (prev.kind === "assistant") {
          if (prev.text) parts.unshift(prev.text);
          continue;
        }
        if (
          prev.kind === "tool_call" ||
          prev.kind === "tool_result" ||
          prev.kind === "thinking" ||
          prev.kind === "diff"
        ) {
          break;
        }
      }
      const selfTalk = flattenSelfTalk(parts.join(""));
      return { label: "Responding", selfTalk: selfTalk || undefined };
    }
    if (entry.kind === "thinking") return { label: "Thinking" };
  }
  return { label: "Running" };
}
