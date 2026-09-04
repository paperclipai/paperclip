/**
 * Live adapter: map a run's streaming TranscriptEntry[] (from
 * useLiveRunTranscripts — the same source the current thread consumes) into the
 * redesign's TaskChatItem[]. This is what lets a real task stream
 * thinking → tool → diff → responding while a run is in flight, rather than
 * only showing a response after the turn settles.
 */
import type { TranscriptEntry } from "@/adapters";
import type {
  TaskChatDiff,
  TaskChatActivityPhaseItem,
  TaskChatItem,
  TaskChatToolItem,
  TaskChatTurnChildItem,
  TaskChatTurnItem,
  TaskChatProviderActivityItem,
  TaskChatProtocolDetail,
  TaskChatProtocolItem,
  TaskChatProtocolStep,
  TaskChatRunResultItem,
  TaskChatMessageItem,
  TaskChatPlanDocumentItem,
} from "./task-chat-model";
import {
  humanizeToolName,
  isGenericToolName,
  toolActivityPresentation,
  toolTaxonomy,
} from "./tool-taxonomy";

const TERMINAL_STATUSES = new Set([
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
  "succeeded",
]);

export function isTerminalRunStatus(
  status: string | undefined | null,
): boolean {
  return status != null && TERMINAL_STATUSES.has(status);
}

export interface TranscriptTimeSegment {
  startMs: number;
  endMs: number;
  entries: TranscriptEntry[];
}

/**
 * Split one provider run at durable in-turn input timestamps. Each boundary
 * belongs to the segment after it, so a steering acknowledgement can stay in
 * the thread between the work produced before and after the steer. Live and
 * settled renderers share this projector to avoid re-sorting at handoff.
 */
export function splitTranscriptAtAnchors(
  entries: readonly TranscriptEntry[],
  startMs: number,
  rawAnchors: readonly number[],
): TranscriptTimeSegment[] {
  const anchors = [...new Set(rawAnchors.filter(Number.isFinite))].sort(
    (a, b) => a - b,
  );
  if (anchors.length === 0) {
    return [
      {
        startMs,
        endMs: Number.POSITIVE_INFINITY,
        entries: [...entries],
      },
    ];
  }
  return [startMs, ...anchors].map((segmentStartMs, index) => {
    const segmentEndMs = anchors[index] ?? Number.POSITIVE_INFINITY;
    return {
      startMs: segmentStartMs,
      endMs: segmentEndMs,
      entries: entries.filter((entry) => {
        const parsed = Date.parse(entry.ts);
        const entryMs = Number.isFinite(parsed) ? parsed : 0;
        const afterStart = index === 0 || entryMs >= segmentStartMs;
        return afterStart && entryMs < segmentEndMs;
      }),
    };
  });
}

/**
 * The live parent row's nesting rule (PAP-354, narrowed by PAP-361): only tool
 * calls, provider-supplied reasoning summaries, and usage readouts nest inside
 * the expandable live turn. The classic parent-row surface may flatten a live
 * interstitial into its status line; the Paperclip Runner task surface instead
 * projects commentary as durable chronological phase boundaries. The run's
 * final reply is resolved separately into the turn's durable response slot or
 * its posted comment bubble. Markers, statuses and interaction cards stay in
 * the thread outside.
 */
export function isNestableLiveChild(
  item: TaskChatItem,
): item is TaskChatTurnChildItem {
  return (
    item.kind === "tool" ||
    item.kind === "thinking" ||
    item.kind === "usage" ||
    item.kind === "activity_phase" ||
    item.kind === "plan_document" ||
    item.kind === "protocol"
  );
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
  if (typeof input === "string")
    return input.trim() ? clip(input, TARGET_MAX) : undefined;
  if (typeof input !== "object") return clip(String(input), TARGET_MAX);
  const record = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim())
      return clip(value, TARGET_MAX);
  }
  // The acpx log parser synthesizes { text, status } onto tool inputs from the
  // event's summary line — presentation noise, not call parameters.
  const entries = Object.entries(record).filter(
    ([k, v]) =>
      (typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean") &&
      k !== "text" &&
      k !== "status",
  );
  if (entries.length === 0) return undefined;
  return clip(
    entries.map(([k, v]) => `${k}: ${String(v)}`).join(", "),
    TARGET_MAX,
  );
}

/**
 * Display name for a tool call. Live acpx `tool_call` events carry real names
 * ("Read", "Bash", mcp__server__tool); legacy stored logs may not — those fall
 * back to a generic "Tool" row. MCP names collapse to their tool segment.
 */
export function toolDisplayName(name: string | undefined | null): string {
  const raw = (name ?? "").trim();
  return isGenericToolName(raw) ? "Unnamed tool" : humanizeToolName(raw);
}

/** "Thought for Ns" once a coalesced thinking group spans ≥1s. */
function thoughtDurationLabel(
  startTs: string | undefined,
  endTs: string,
): string | undefined {
  if (!startTs) return undefined;
  const start = Date.parse(startTs);
  const end = Date.parse(endTs);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const secs = Math.round((end - start) / 1000);
  if (secs < 1) return undefined;
  return secs < 60
    ? `Thought for ${secs}s`
    : `Thought for ${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** Append token deltas onto the open logical line while preserving real newlines. */
function appendThinkingText(
  lines: string[],
  text: string,
  delta: boolean | undefined,
) {
  const fragments = text.split("\n");
  if (!delta || lines.length === 0) {
    lines.push(...fragments);
    return;
  }
  lines[lines.length - 1] =
    `${lines[lines.length - 1] ?? ""}${fragments[0] ?? ""}`;
  lines.push(...fragments.slice(1));
}

const DETAIL_MAX = 600;
const PROTOCOL_OUTPUT_MAX = 8 * 1024;

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function scalarValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return undefined;
}

function titleCaseKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeHttpHref(value: unknown): string | null {
  const href = stringValue(value);
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

const PROVIDER_DETAIL_KEYS: Record<
  TaskChatProviderActivityItem["family"],
  readonly string[]
> = {
  plan: ["revision", "syncStatus", "documentRevision", "complete"],
  tool_execution: [
    "transport",
    "operation",
    "name",
    "target",
    "namespace",
    "readOnly",
    "status",
    "progress",
    "durationMs",
    "exitCode",
    "outputBytes",
  ],
  research: ["action", "status", "query", "pattern", "url"],
  delegation: ["action", "status"],
  model_identity: [
    "provider",
    "requestedModel",
    "fromModel",
    "effectiveModel",
    "reason",
    "status",
    "buffering",
    "summary",
  ],
  context: ["reason", "preTokens", "postTokens", "sameSession"],
  artifact: [
    "status",
    "reference",
    "mediaType",
    "title",
    "registered",
    "transparentBackground",
    "failure",
  ],
  review: ["state", "scope"],
  hook: ["event", "scope", "status", "blocking", "durationMs", "summary"],
  memory: ["label", "available", "reference"],
  safety: ["status", "decision", "targetExecutionId", "summary"],
  terminal: ["origin", "inputClass", "byteCount"],
  wait: ["reason", "status", "plannedDurationMs", "elapsedDurationMs"],
  provider_notice: [
    "severity",
    "category",
    "scope",
    "recoverable",
    "userActionable",
    "summary",
  ],
};

function providerActivityKey(
  entry: Extract<TranscriptEntry, { kind: "provider_activity" }>,
): string {
  const idKeys = [
    "planId",
    "executionId",
    "researchId",
    "delegationId",
    "routeId",
    "verificationId",
    "compactionId",
    "artifactId",
    "reviewId",
    "hookId",
    "citationId",
    "waitId",
    "noticeId",
  ];
  for (const key of idKeys) {
    const value = stringValue(entry.payload[key]);
    if (value) return `${entry.family}:${value}`;
  }
  return `${entry.family}:${entry.eventType}:${entry.ts}`;
}

function providerActivityItem(
  entry: Extract<TranscriptEntry, { kind: "provider_activity" }>,
  runId: string,
  index: number,
): TaskChatProviderActivityItem {
  const details: TaskChatProtocolDetail[] = [];
  for (const key of PROVIDER_DETAIL_KEYS[entry.family]) {
    const value = scalarValue(entry.payload[key]);
    if (!value) continue;
    if (
      entry.family === "tool_execution" &&
      key === "name" &&
      isGenericToolName(value)
    )
      continue;
    if (
      entry.family === "tool_execution" &&
      key === "progress" &&
      !meaningfulProviderToolSummary(value)
    )
      continue;
    details.push({
      label: titleCaseKey(key),
      value: clip(
        value,
        key === "message" || key === "summary" || key === "reason" ? 320 : 160,
      ),
      mono: /(?:id|model|target|reference|url|code|bytes)$/i.test(key),
    });
  }

  const steps =
    entry.family === "plan" && Array.isArray(entry.payload.steps)
      ? entry.payload.steps
          .map(objectRecord)
          .slice(0, 256)
          .map((step, stepIndex) => {
            const rawStatus = stringValue(step.status);
            const status: TaskChatProtocolStep["status"] =
              rawStatus === "in_progress" ||
              rawStatus === "completed" ||
              rawStatus === "blocked"
                ? rawStatus
                : "pending";
            return {
              id: stringValue(step.stepId) ?? `${runId}:plan-step:${stepIndex}`,
              label: stringValue(step.body) ?? "Plan step",
              status,
            };
          })
      : [];

  const links =
    entry.family === "research" && Array.isArray(entry.payload.sources)
      ? entry.payload.sources
          .map(objectRecord)
          .slice(0, 64)
          .flatMap((source) => {
            const href = safeHttpHref(source.url);
            return href
              ? [
                  {
                    label: stringValue(source.title) ?? href,
                    href,
                    description: stringValue(source.snippet),
                  },
                ]
              : [];
          })
      : [];

  const children =
    entry.family === "delegation" && Array.isArray(entry.payload.children)
      ? entry.payload.children
          .map(objectRecord)
          .slice(0, 64)
          .map((child, childIndex) => ({
            id:
              stringValue(child.childId) ?? `${runId}:delegation:${childIndex}`,
            title: stringValue(child.role) ?? "Subagent",
            status: stringValue(child.status) ?? "unknown",
            metadata:
              [stringValue(child.model), stringValue(child.activitySummary)]
                .filter(Boolean)
                .join(" · ") || undefined,
            summary: stringValue(child.summary),
          }))
      : [];

  const rawOutput =
    entry.family === "tool_execution"
      ? stringValue(entry.payload.output)
      : undefined;
  const outputTruncated =
    entry.payload.outputTruncated === true ||
    Boolean(rawOutput && rawOutput.length > PROTOCOL_OUTPUT_MAX);
  const summary =
    entry.summary && entry.summary !== entry.eventType
      ? entry.summary
      : (stringValue(entry.payload.explanation) ??
        stringValue(entry.payload.progress) ??
        stringValue(entry.payload.message) ??
        stringValue(entry.payload.summary));

  return {
    id: `${runId}:provider:${providerActivityKey(entry)}:${index}`,
    kind: "protocol",
    surface: "provider_activity",
    family: entry.family,
    eventType: entry.eventType,
    status: entry.status,
    title: entry.title,
    summary,
    details,
    steps,
    links,
    children,
    output: rawOutput ? rawOutput.slice(0, PROTOCOL_OUTPUT_MAX) : undefined,
    outputTruncated,
    transcriptIndex: index,
  };
}

function providerItemDetail(
  item: TaskChatProviderActivityItem,
  label: string,
): string | undefined {
  return item.details.find((detail) => detail.label === label)?.value;
}

function meaningfulProviderToolSummary(value: string | undefined): boolean {
  return Boolean(
    value && !isGenericToolName(value) && !/^tool(?:\s+|_)call\b/i.test(value),
  );
}

/**
 * Provider lifecycle records are deltas. A terminal update owns status and
 * output, while earlier identity/progress fields survive when later frames
 * omit them or carry ACPX's literal `tool call` placeholder.
 */
function mergeProviderActivityItem(
  previous: TaskChatProviderActivityItem,
  incoming: TaskChatProviderActivityItem,
): TaskChatProviderActivityItem {
  if (
    previous.family !== "tool_execution" ||
    incoming.family !== "tool_execution"
  ) {
    return { ...incoming, id: previous.id };
  }
  const details = new Map(
    previous.details.map((detail) => [detail.label, detail]),
  );
  const incomingName = providerItemDetail(incoming, "Name");
  const genericIncomingIdentity = isGenericToolName(incomingName);
  const identityLabels = new Set([
    "Name",
    "Transport",
    "Namespace",
    "Operation",
    "Target",
  ]);
  for (const detail of incoming.details) {
    if (
      identityLabels.has(detail.label) &&
      genericIncomingIdentity &&
      details.has(detail.label)
    ) {
      continue;
    }
    if (
      detail.label === "Progress" &&
      !meaningfulProviderToolSummary(detail.value) &&
      details.has("Progress")
    ) {
      continue;
    }
    details.set(detail.label, detail);
  }
  return {
    ...incoming,
    id: previous.id,
    summary: meaningfulProviderToolSummary(incoming.summary)
      ? incoming.summary
      : previous.summary,
    details: [...details.values()],
  };
}

/** Result content → the expandable mono detail block (clipped, trimmed). */
function formatToolResultDetail(content: unknown): string | undefined {
  if (content == null) return undefined;
  const text = typeof content === "string" ? content : String(content);
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > DETAIL_MAX
    ? `${trimmed.slice(0, DETAIL_MAX)}\n…`
    : trimmed;
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
  const protocolIndexByKey = new Map<string, number>();
  const thinkingStartTs = new Map<number, string>();
  let lastToolIndex = -1;
  let thinkingIndex = -1;
  let thinkingChannel: "summary" | "detail" | "unknown" | undefined;
  let thinkingItemId: string | undefined;
  let messageIndex = -1;
  let messageChannel: "progress" | "final" | "unknown" | undefined;
  let messageItemId: string | undefined;

  const finishThinking = () => {
    if (thinkingIndex >= 0) {
      const item = items[thinkingIndex];
      if (item?.kind === "thinking") item.streaming = false;
    }
    thinkingIndex = -1;
    thinkingChannel = undefined;
    thinkingItemId = undefined;
  };

  const resetInline = () => {
    finishThinking();
    messageIndex = -1;
    messageChannel = undefined;
    messageItemId = undefined;
  };

  for (const [i, entry] of entries.entries()) {
    switch (entry.kind) {
      case "thinking": {
        const lifecycleOnly = !entry.text;
        const openThinking =
          thinkingIndex >= 0 ? items[thinkingIndex] : undefined;
        const continuesAnonymousLifecycle =
          entry.itemId === undefined &&
          thinkingItemId === undefined &&
          lifecycleOnly &&
          entry.lifecycle === "completed" &&
          openThinking?.kind === "thinking" &&
          openThinking.lifecycleOnly === true;
        const sameThinkingItem =
          thinkingIndex >= 0 &&
          thinkingChannel === entry.channel &&
          ((entry.itemId !== undefined && entry.itemId === thinkingItemId) ||
            (entry.itemId === undefined &&
              thinkingItemId === undefined &&
              entry.delta === true) ||
            continuesAnonymousLifecycle);
        if (sameThinkingItem) {
          const it = items[thinkingIndex];
          if (it.kind === "thinking") {
            if (entry.text) {
              appendThinkingText(it.lines, entry.text, entry.delta);
              it.lifecycleOnly = false;
            }
            it.transcriptIndex = i;
            const startTs = thinkingStartTs.get(thinkingIndex);
            const label = thoughtDurationLabel(startTs, entry.ts);
            if (label) it.summaryLabel = label;
            if (entry.lifecycle === "completed") it.streaming = false;
          }
        } else {
          // A reasoning item is active only until the provider moves on to a
          // different reasoning channel or another transcript surface. ACPX
          // does not always send an explicit completed lifecycle frame, so
          // waiting for one leaves every earlier brain blue and shimmering.
          finishThinking();
          items.push({
            id: `${runId}:think:${i}`,
            kind: "thinking",
            lines: entry.text ? entry.text.split("\n") : [],
            streaming: running && entry.lifecycle !== "completed",
            // Settled history folds its thinking behind the header (v7);
            // the in-flight run streams it expanded.
            collapsed: !running,
            channel: entry.channel,
            lifecycleOnly,
            transcriptIndex: i,
          });
          thinkingIndex = items.length - 1;
          thinkingChannel = entry.channel;
          thinkingItemId = entry.itemId;
          thinkingStartTs.set(thinkingIndex, entry.ts);
          messageIndex = -1;
          messageChannel = undefined;
          messageItemId = undefined;
        }
        if (entry.lifecycle === "completed") {
          finishThinking();
        }
        break;
      }
      case "assistant": {
        if (!entry.text) break;
        finishThinking();
        const channel = entry.channel;
        const sameMessage =
          messageIndex >= 0 &&
          messageChannel === channel &&
          ((entry.itemId !== undefined && entry.itemId === messageItemId) ||
            (entry.itemId === undefined &&
              messageItemId === undefined &&
              entry.delta === true));
        if (sameMessage) {
          const it = items[messageIndex];
          if (it.kind === "message") {
            it.text += entry.text;
            it.transcriptIndex = i;
          }
        } else {
          finishThinking();
          const atMs = Date.parse(entry.ts);
          items.push({
            id: `${runId}:msg:${i}`,
            kind: "message",
            author: "agent",
            authorName: agentName,
            text: entry.text,
            channel,
            streaming: running,
            // Explicit final-answer items stream durably. Unclassified text
            // remains transient for backwards compatibility and fail-closed
            // handling of a delta whose start metadata was missed.
            interstitial: channel !== "final",
            atMs: Number.isFinite(atMs) ? atMs : undefined,
            transcriptIndex: i,
          });
          messageIndex = items.length - 1;
          messageChannel = channel;
          messageItemId = entry.itemId;
        }
        break;
      }
      case "tool_call": {
        const toolCallId = entry.toolUseId || `tool-${i}`;
        const existingIndex = toolIndexById.get(toolCallId);
        const existing =
          existingIndex != null ? items[existingIndex] : undefined;
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
            existing.status = entry.delta
              ? "in_progress"
              : entry.isError
                ? "failed"
                : "completed";
            if (
              isGenericToolName(existing.rawName) &&
              !isGenericToolName(entry.toolName)
            ) {
              existing.name = toolDisplayName(entry.toolName);
              existing.rawName = entry.toolName;
            }
            const detail = formatToolResultDetail(entry.content);
            if (detail) {
              existing.detail =
                entry.delta && existing.detail
                  ? `${existing.detail}${detail}`
                  : detail;
            }
          }
        }
        resetInline();
        break;
      }
      case "diff": {
        if (entry.changeType === "file_header") {
          if (lastToolIndex >= 0 && items[lastToolIndex].kind === "tool") {
            const tool = items[lastToolIndex] as TaskChatToolItem;
            tool.diff = tool.diff ?? {
              path: entry.text,
              added: 0,
              removed: 0,
              lines: [],
            };
            tool.diff.path = entry.text;
          }
          resetInline();
          break;
        }
        const line = {
          kind: diffKind(entry.changeType),
          text: entry.text ?? "",
        };
        if (lastToolIndex >= 0 && items[lastToolIndex].kind === "tool") {
          const tool = items[lastToolIndex] as TaskChatToolItem;
          const diff: TaskChatDiff = tool.diff ?? {
            added: 0,
            removed: 0,
            lines: [],
          };
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
      case "provider_activity": {
        const key = `provider:${providerActivityKey(entry)}`;
        const item = providerActivityItem(entry, runId, i);
        const existingIndex = protocolIndexByKey.get(key);
        if (existingIndex == null) {
          items.push(item);
          protocolIndexByKey.set(key, items.length - 1);
        } else {
          const existing = items[existingIndex];
          items[existingIndex] =
            existing.kind === "protocol" &&
            existing.surface === "provider_activity"
              ? mergeProviderActivityItem(existing, item)
              : item;
        }
        resetInline();
        break;
      }
      case "workspace_change": {
        const key = `workspace:${entry.changeSetId}`;
        const item: TaskChatProtocolItem = {
          id: `${runId}:workspace:${entry.changeSetId}`,
          kind: "protocol",
          surface: "workspace_change",
          changeSetId: entry.changeSetId,
          revision: entry.revision,
          source: entry.source,
          complete: entry.complete,
          files: entry.files.map((file) => ({
            ...file,
            diff:
              file.diff == null
                ? null
                : file.diff.slice(0, PROTOCOL_OUTPUT_MAX),
          })),
          totals: entry.totals,
          patchArtifactRef: entry.patchArtifactRef,
        };
        const existingIndex = protocolIndexByKey.get(key);
        if (existingIndex == null) {
          items.push(item);
          protocolIndexByKey.set(key, items.length - 1);
        } else {
          items[existingIndex] = { ...item, id: items[existingIndex].id };
        }
        resetInline();
        break;
      }
      case "workspace_file_reference": {
        const key = `workspace-file:${entry.referenceId}`;
        const item: TaskChatProtocolItem = {
          id: `${runId}:workspace-file:${entry.referenceId}`,
          kind: "protocol",
          surface: "workspace_file",
          referenceId: entry.referenceId,
          source: entry.source,
          path: entry.path,
          displayName: entry.displayName,
          mediaType: entry.mediaType,
          presentation: entry.presentation,
          line: entry.line,
          preview:
            entry.preview == null
              ? null
              : entry.preview.slice(0, PROTOCOL_OUTPUT_MAX),
          previewTruncated:
            entry.previewTruncated ||
            Boolean(
              entry.preview && entry.preview.length > PROTOCOL_OUTPUT_MAX,
            ),
        };
        const existingIndex = protocolIndexByKey.get(key);
        if (existingIndex == null) {
          items.push(item);
          protocolIndexByKey.set(key, items.length - 1);
        } else {
          items[existingIndex] = { ...item, id: items[existingIndex].id };
        }
        resetInline();
        break;
      }
      case "runtime_request": {
        const key = `runtime-request:${entry.requestId}`;
        const item: TaskChatProtocolItem = {
          id: `${runId}:runtime-request:${entry.requestId}`,
          kind: "protocol",
          surface: "runtime_request",
          runId,
          requestId: entry.requestId,
          requestKind: entry.requestKind,
          turnId: entry.turnId,
          requestType: entry.requestType,
          status: entry.status,
          prompt: entry.prompt,
          choices: entry.choices,
          fields: entry.fields,
          questionSet: entry.questionSet,
          resolvedAction: entry.resolvedAction,
          response: entry.response,
        };
        const existingIndex = protocolIndexByKey.get(key);
        if (existingIndex == null) {
          items.push(item);
          protocolIndexByKey.set(key, items.length - 1);
        } else {
          items[existingIndex] = { ...item, id: items[existingIndex].id };
        }
        resetInline();
        break;
      }
      case "run_result": {
        items.push({
          id: `${runId}:result:${i}`,
          kind: "protocol",
          surface: "run_result",
          disposition: entry.disposition,
          summary: entry.summary,
          objectiveSatisfied: entry.objectiveSatisfied,
          verification: entry.verification,
          remainingWork: entry.remainingWork,
          blocker: entry.blocker,
          artifacts: entry.artifacts,
        });
        resetInline();
        break;
      }
      case "run_terminal": {
        const key = "run-terminal";
        const item: TaskChatProtocolItem = {
          id: `${runId}:terminal`,
          kind: "protocol",
          surface: "run_terminal",
          turnState: entry.turnState,
          runState: entry.runState,
          disposition: entry.disposition,
          stopReason: entry.stopReason,
        };
        const existingIndex = protocolIndexByKey.get(key);
        if (existingIndex == null) {
          items.push(item);
          protocolIndexByKey.set(key, items.length - 1);
        } else {
          items[existingIndex] = item;
        }
        resetInline();
        break;
      }
      case "result": {
        if (
          entry.subtype !== "paperclip_runner_usage" &&
          entry.subtype !== "paperclip_runner_session_usage"
        )
          break;
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
  // provider commentary is complete but remains a durable phase boundary.
  if (running) {
    for (const [idx, it] of items.entries()) {
      if (it.kind === "message" && idx !== messageIndex) it.streaming = false;
    }
  } else {
    // A terminal transcript cannot retain live spinners forever when a
    // provider disconnects or the operator cancels while a tool is active.
    // Preserve the unfinished lifecycle honestly instead of inventing a
    // success/failure result the provider never emitted.
    for (const item of items) {
      if (
        item.kind === "tool" &&
        (item.status === "pending" || item.status === "in_progress")
      ) {
        item.status = "interrupted";
        item.detail = item.detail
          ? `${item.detail}\nInterrupted before the provider reported completion.`
          : "Interrupted before the provider reported completion.";
      } else if (
        item.kind === "protocol" &&
        item.surface === "provider_activity" &&
        item.status === "running"
      ) {
        item.status = "interrupted";
        item.summary = item.summary
          ? `${item.summary} · Interrupted before completion.`
          : "Interrupted before completion.";
      } else if (
        item.kind === "protocol" &&
        item.surface === "runtime_request" &&
        item.status === "pending"
      ) {
        item.status = "cancelled";
      }
    }
  }

  return items;
}

/**
 * A settled run's chronological children. Commentary remains attached to the
 * phase it introduced, while terminal runtime-request receipts keep the slot
 * where the request first appeared. Final text is excluded because the turn's
 * dedicated response slot or posted comment owns it.
 */
export function settledRunChildren(
  parsed: readonly TaskChatItem[],
): TaskChatTurnChildItem[] {
  return buildTurnTimelineRows(parsed, false);
}

/**
 * A provider can emit the same user-facing text first as progress and then as
 * its durable response. Keep the chronological progress item while the answer
 * is still unknown, but once that response exists let its dedicated bubble own
 * the text. Only the last exact match is removed so intentional earlier
 * repetition remains visible.
 */
export function omitProgressRepeatedByResponse(
  items: readonly TaskChatItem[],
  responseText: string | null | undefined,
): readonly TaskChatItem[] {
  return (
    omitProgressRepeatedByResponseAcrossSegments([items], responseText)[0] ??
    items
  );
}

/**
 * Run-wide form of omitProgressRepeatedByResponse for steered transcripts.
 * Segmentation is a presentation concern, so it must not turn one dedupe into
 * one removal per segment. Preserve all intentional earlier repetitions and
 * remove only the final progress item matching the durable response.
 */
export function omitProgressRepeatedByResponseAcrossSegments(
  segments: readonly (readonly TaskChatItem[])[],
  responseText: string | null | undefined,
): readonly (readonly TaskChatItem[])[] {
  const normalizedResponse = responseText?.trim();
  if (!normalizedResponse) return segments;
  let redundantSegmentIndex = -1;
  let redundantIndex = -1;
  findRedundant: for (
    let segmentIndex = segments.length - 1;
    segmentIndex >= 0;
    segmentIndex -= 1
  ) {
    const items = segments[segmentIndex];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (
        item.kind === "message" &&
        item.interstitial &&
        item.channel === "progress" &&
        item.text.trim() === normalizedResponse
      ) {
        redundantSegmentIndex = segmentIndex;
        redundantIndex = index;
        break findRedundant;
      }
    }
  }
  if (redundantSegmentIndex < 0) return segments;
  return segments.map((items, segmentIndex) =>
    segmentIndex === redundantSegmentIndex
      ? items.filter((_, index) => index !== redundantIndex)
      : items,
  );
}

/**
 * Keep the paperclip runner's expanded activity history focused on work the
 * user can act on. The normalized transcript remains lossless; this is only a
 * presentation filter for the new-runner turn surface. Legacy adapters keep
 * their existing lifecycle and usage rows.
 */
export function paperclipRunnerHistoryItems(
  parsed: readonly TaskChatItem[],
): TaskChatItem[] {
  return parsed.filter((item) => {
    if (item.kind === "usage") return false;
    if (item.kind !== "marker") return true;
    if (item.variant === "session_start") return false;
    return (
      item.variant !== "turn_boundary" ||
      (item.label !== "Turn started" && item.label !== "Turn completed")
    );
  });
}

/**
 * Semantic rows for the Paperclip runner's Codex-style activity disclosure.
 *
 * This is intentionally narrower than the stored transcript and the runner
 * inspector: it keeps work a person can understand or act on while excluding
 * transport/lifecycle bookkeeping, terminal authority, and the final
 * response. Logical provider/tool lifecycles have already been coalesced by
 * `transcriptToTaskChatItems`, so each returned item is one visible "thing".
 */
export function paperclipRunnerActivityItems(
  parsed: readonly TaskChatItem[],
): TaskChatItem[] {
  const hasAggregateWorkspaceChange = parsed.some(
    (item) => item.kind === "protocol" && item.surface === "workspace_change",
  );
  return parsed.filter((item) => {
    switch (item.kind) {
      case "message":
        return Boolean(item.interstitial && item.text.trim());
      case "thinking":
        // A textless reasoning lifecycle drives the live "Thinking…" label,
        // but repeating it as an empty child row adds no information.
        return item.lines.some((line) => line.trim().length > 0);
      case "tool": {
        const normalizedName = (item.rawName ?? item.name)
          .replaceAll("-", "_")
          .toLowerCase();
        if (
          hasAggregateWorkspaceChange &&
          (normalizedName === "file_change" || normalizedName === "filechange")
        )
          return false;
        return normalizedName !== "paperclip_finish";
      }
      case "marker":
        return item.variant === "interrupted";
      case "protocol":
        if (
          hasAggregateWorkspaceChange &&
          item.surface === "provider_activity" &&
          item.family === "tool_execution"
        ) {
          const presentation = toolActivityPresentation({
            name: providerItemDetail(item, "Name"),
            transport: providerItemDetail(item, "Transport"),
            namespace: providerItemDetail(item, "Namespace"),
            operation: providerItemDetail(item, "Operation"),
            target: providerItemDetail(item, "Target"),
            progress: providerItemDetail(item, "Progress"),
          });
          if (presentation.summaryGroup.key === "file_change") return false;
        }
        return (
          item.surface === "provider_activity" ||
          item.surface === "workspace_change" ||
          item.surface === "workspace_file" ||
          item.surface === "resource"
        );
      case "usage":
        return true;
      case "status":
      case "activity_phase":
      case "interaction":
      case "turn":
      case "brief":
      case "plan_document":
        return false;
    }
  });
}

/**
 * Ordered input for the Paperclip Runner task-turn timeline. This keeps the
 * semantic activity filter above, but retains runtime-request lifecycles so
 * the shared projector can use each request as a phase boundary and place its
 * terminal receipt at the request's first-seen position.
 */
export function paperclipRunnerTimelineItems(
  parsed: readonly TaskChatItem[],
): TaskChatItem[] {
  const activityIds = new Set(
    paperclipRunnerActivityItems(parsed).map((item) => item.id),
  );
  return parsed.filter(
    (item) =>
      activityIds.has(item.id) ||
      item.kind === "plan_document" ||
      (item.kind === "protocol" && item.surface === "runtime_request"),
  );
}

/**
 * Resolve the durable response owned by a Paperclip Runner turn. Provider final
 * text wins when present, followed by a compatible terminal assistant message
 * and then the accepted run-result summary. The caller keeps yielded
 * control-plane waits out of the final-response slot.
 */
export function paperclipRunnerFinalResponse(
  parsed: readonly TaskChatItem[],
  options?: {
    runId?: string;
    agentName?: string;
    fallbackSummary?: string | null;
    /** Structured summaries are terminal fallbacks, never live partial replies. */
    allowFallback?: boolean;
  },
): TaskChatMessageItem | undefined {
  // A yielded result is a control-plane wait boundary, not an assistant reply.
  // Some providers historically labeled their "waiting for input" prose as a
  // final message, so disposition must take precedence over message channel.
  const yielded = parsed.some(
    (item) =>
      item.kind === "protocol" &&
      item.surface === "run_result" &&
      item.disposition === "yielded",
  );
  if (yielded) return undefined;
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const item = parsed[index];
    if (
      item.kind === "message" &&
      item.channel === "final" &&
      item.text.trim()
    ) {
      return item;
    }
  }
  if (options?.allowFallback === false) return undefined;
  // Historical runner transcripts may contain a complete assistant reply from
  // before message channels were persisted. Keep that user-authored text as
  // the terminal response and do not replace it with a structured result
  // summary. Explicit progress text is intentionally excluded.
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const item = parsed[index];
    if (
      item.kind === "message" &&
      item.channel !== "progress" &&
      item.text.trim()
    ) {
      return {
        ...item,
        channel: "final",
        interstitial: false,
        streaming: false,
      };
    }
  }
  const runResult = [...parsed]
    .reverse()
    .find(
      (item): item is TaskChatRunResultItem =>
        item.kind === "protocol" &&
        item.surface === "run_result" &&
        Boolean(item.summary?.trim()),
    );
  const text = runResult?.summary?.trim() ?? options?.fallbackSummary?.trim();
  if (!text) return undefined;
  return {
    id: runResult
      ? `${runResult.id}:final-response`
      : `${options?.runId ?? "run"}:result-summary:final-response`,
    kind: "message",
    author: "agent",
    authorName: options?.agentName,
    text,
    channel: "final",
    streaming: false,
  };
}

/**
 * Materialize a saved plan at the tool boundary that created its revision.
 * The document query and transcript stream update independently, so folding
 * the document into the parsed turn gives live, settling, and replay the same
 * stable owner and DOM position. If that boundary is temporarily unavailable,
 * retain an explicitly marked end-of-turn fallback instead of dropping the
 * canonical document.
 */
export function embedPlanDocumentAtWriteBoundary(
  parsed: readonly TaskChatItem[],
  plan: TaskChatPlanDocumentItem,
): TaskChatItem[] {
  const withoutPlan = parsed.filter((item) => item.id !== plan.id);
  let writeIndex = -1;
  for (let index = 0; index < withoutPlan.length; index += 1) {
    const item = withoutPlan[index];
    const name =
      item.kind === "tool"
        ? (item.rawName ?? item.name)
        : item.kind === "protocol" &&
            item.surface === "provider_activity" &&
            item.family === "tool_execution"
          ? providerItemDetail(item, "Name")
          : null;
    if (!name) continue;
    const normalizedName = name.replaceAll("-", "_").toLowerCase();
    if (normalizedName === "write_document") writeIndex = index;
  }
  const placedPlan: TaskChatPlanDocumentItem = {
    ...plan,
    placement: writeIndex < 0 ? "fallback" : "write_boundary",
  };
  if (writeIndex < 0) return [...withoutPlan, placedPlan];
  return [
    ...withoutPlan.slice(0, writeIndex + 1),
    placedPlan,
    ...withoutPlan.slice(writeIndex + 1),
  ];
}

function phaseSummary(
  items: ReadonlyArray<TaskChatActivityPhaseItem["items"][number]>,
): string {
  const counts = new Map<string, number>();
  const providerCounts = new Map<
    TaskChatProviderActivityItem["family"],
    number
  >();
  const providerToolGroups = new Map<string, number>();
  let providerToolActions = 0;
  let generic = 0;
  let workspaceFiles = 0;
  for (const item of items) {
    if (item.kind === "protocol") {
      if (item.surface === "provider_activity") {
        providerCounts.set(
          item.family,
          (providerCounts.get(item.family) ?? 0) + 1,
        );
        if (item.family === "tool_execution") {
          const presentation = toolActivityPresentation({
            name: providerItemDetail(item, "Name"),
            transport: providerItemDetail(item, "Transport"),
            namespace: providerItemDetail(item, "Namespace"),
            operation: providerItemDetail(item, "Operation"),
            target: providerItemDetail(item, "Target"),
            progress: providerItemDetail(item, "Progress"),
          });
          const summaryGroup = presentation.summaryGroup;
          providerToolGroups.set(
            summaryGroup.key,
            (providerToolGroups.get(summaryGroup.key) ?? 0) + 1,
          );
          providerToolActions += 1;
        }
      } else if (item.surface === "workspace_change") {
        workspaceFiles += item.totals.files || item.files.length;
      } else if (item.surface === "workspace_file") {
        workspaceFiles += 1;
      }
      continue;
    }
    if (item.kind !== "tool") continue;
    if (isGenericToolName(item.rawName ?? item.name)) {
      generic += 1;
      continue;
    }
    const family = toolTaxonomy(item.rawName ?? item.name).family;
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const phrases: Array<{ text: string; count: number }> = [];
  const add = (
    family: string,
    singular: string,
    plural: (count: number) => string,
  ) => {
    const count = counts.get(family) ?? 0;
    if (count)
      phrases.push({ text: count === 1 ? singular : plural(count), count });
  };
  add("read", "Read a file", (count) => `Read ${count} files`);
  add("edit", "Edited a file", (count) => `Edited ${count} files`);
  add("terminal", "Ran a command", (count) => `Ran ${count} commands`);
  const searched = (counts.get("grep") ?? 0) + (counts.get("search") ?? 0);
  if (searched)
    phrases.push({
      text: searched === 1 ? "Searched once" : `Searched ${searched} times`,
      count: searched,
    });
  const known = new Set(["read", "edit", "terminal", "grep", "search"]);
  const other =
    [...counts].reduce(
      (n, [family, count]) => n + (known.has(family) ? 0 : count),
      0,
    ) + generic;
  if (other)
    phrases.push({
      text: other === 1 ? "Used a tool" : `Used ${other} tools`,
      count: other,
    });
  const providerCount = (family: TaskChatProviderActivityItem["family"]) =>
    providerCounts.get(family) ?? 0;
  const addProvider = (
    family: TaskChatProviderActivityItem["family"],
    singular: string,
    plural: (count: number) => string,
  ) => {
    const count = providerCount(family);
    if (count)
      phrases.push({ text: count === 1 ? singular : plural(count), count });
  };
  addProvider("plan", "Updated the plan", (count) => `Updated ${count} plans`);
  addProvider(
    "research",
    "Searched once",
    (count) => `Searched ${count} times`,
  );
  addProvider(
    "delegation",
    "Used a subagent",
    (count) => `Used ${count} subagents`,
  );
  addProvider(
    "model_identity",
    "Updated the model",
    (count) => `Updated the model ${count} times`,
  );
  addProvider(
    "context",
    "Compacted context",
    (count) => `Compacted context ${count} times`,
  );
  addProvider(
    "artifact",
    "Handled an artifact",
    (count) => `Handled ${count} artifacts`,
  );
  addProvider(
    "review",
    "Changed review mode",
    (count) => `Changed review mode ${count} times`,
  );
  addProvider("hook", "Ran a hook", (count) => `Ran ${count} hooks`);
  addProvider(
    "memory",
    "Referenced memory",
    (count) => `Referenced memory ${count} times`,
  );
  addProvider(
    "safety",
    "Ran a safety review",
    (count) => `Ran ${count} safety reviews`,
  );
  addProvider(
    "terminal",
    "Sent terminal input",
    (count) => `Sent terminal input ${count} times`,
  );
  addProvider("wait", "Waited", (count) => `Waited ${count} times`);
  addProvider(
    "provider_notice",
    "Received a provider notice",
    (count) => `Received ${count} provider notices`,
  );
  // A canonical tool-execution row can be the only tool representation for a
  // provider. Avoid double-counting when the adapter also produced native
  // TaskChatToolItems for the same executions.
  const nativeToolCount = [...counts.values()].reduce(
    (total, count) => total + count,
    generic,
  );
  if (nativeToolCount === 0 && providerToolActions > 0) {
    for (const [key, count] of providerToolGroups) {
      let text: string;
      switch (key) {
        case "command":
          text = count === 1 ? "Ran a command" : `Ran ${count} commands`;
          break;
        case "read":
          text = count === 1 ? "Read a file" : `Read ${count} files`;
          break;
        case "search":
          text = count === 1 ? "Searched once" : `Searched ${count} times`;
          break;
        case "file_change":
          text = count === 1 ? "Edited a file" : `Edited ${count} files`;
          break;
        case "delegation":
          text = count === 1 ? "Used a subagent" : `Used ${count} subagents`;
          break;
        case "wait":
          text = count === 1 ? "Waited" : `Waited ${count} times`;
          break;
        case "tool_search":
          text =
            count === 1
              ? "Searched available tools"
              : `Searched available tools ${count} times`;
          break;
        case "paperclip_read":
          text =
            count === 1
              ? "Read from Paperclip"
              : `Read from Paperclip ${count} times`;
          break;
        case "task_operation":
          text =
            count === 1 ? "Used Paperclip" : `Used Paperclip ${count} times`;
          break;
        default:
          text = count === 1 ? "Used a tool" : `Used ${count} tools`;
      }
      phrases.push({
        text,
        count,
      });
    }
  }
  if (workspaceFiles > 0)
    phrases.push({
      text:
        workspaceFiles === 1
          ? "Changed a file"
          : `Changed ${workspaceFiles} files`,
      count: workspaceFiles,
    });
  if (phrases.length > 0) {
    const visible = phrases.slice(0, 3);
    const hidden = phrases
      .slice(3)
      .reduce((total, phrase) => total + phrase.count, 0);
    const summary = visible
      .map((phrase, index) =>
        index === 0
          ? phrase.text
          : phrase.text.charAt(0).toLowerCase() + phrase.text.slice(1),
      )
      .join(", ");
    return `${summary}${hidden > 0 ? `, +${hidden} more` : ""}`;
  }
  const protocolCount = items.filter((item) => item.kind === "protocol").length;
  if (protocolCount > 0)
    return protocolCount === 1
      ? "Runner activity"
      : `${protocolCount} runner updates`;
  if (items.some((item) => item.kind === "thinking")) return "Reasoning";
  const interrupted = items.find(
    (item) => item.kind === "marker" && item.variant === "interrupted",
  );
  return interrupted?.kind === "marker"
    ? interrupted.label
    : "No tool activity";
}

/**
 * Project one turn into its durable chronological rows.
 *
 * Commentary starts a sticky phase. Consecutive diagnostic activity belongs
 * to that phase until the next commentary or runtime request. Request lifecycle
 * updates are coalesced to their latest state but emitted at the first request
 * slot; pending requests stay composer-only while still breaking activity
 * grouping at that slot.
 */
export function buildTurnTimelineRows(
  parsed: readonly TaskChatItem[],
  running: boolean,
): TaskChatTurnChildItem[] {
  const rows: TaskChatTurnChildItem[] = [];
  let current: TaskChatActivityPhaseItem | null = null;
  const latestRequestByKey = new Map<string, TaskChatProtocolItem>();
  for (const item of parsed) {
    if (item.kind !== "protocol" || item.surface !== "runtime_request")
      continue;
    latestRequestByKey.set(`${item.runId}:${item.requestId}`, item);
  }
  const seenRequests = new Set<string>();
  const ensureOpening = (seed: string) => {
    if (!current) {
      current = {
        id: `${seed}:phase:opening`,
        kind: "activity_phase",
        items: [],
        summary: "",
        active: false,
      };
      rows.push(current);
    }
    return current;
  };
  const legacyReplyBoundary = [...parsed].reverse().find((item) => {
    if (item.kind === "usage" || item.kind === "status") return false;
    if (item.kind === "marker") {
      return item.variant === "interrupted";
    }
    if (item.kind === "protocol") {
      return (
        item.surface === "provider_activity" ||
        item.surface === "runtime_request"
      );
    }
    return true;
  });
  for (const item of parsed) {
    if (item.kind === "message") {
      // Explicit final-channel replies remain canonical even when a later
      // usage row makes them non-tail. Channel-less legacy transcripts retain
      // the last-visible fallback until the posted reply lands.
      const explicitFinal =
        item.channel === "final" || item.interstitial === false;
      const legacyTrailingReply =
        (item.channel == null || item.channel === "unknown") &&
        item === legacyReplyBoundary;
      if (!running && (explicitFinal || legacyTrailingReply)) continue;
      current = {
        id: `${item.id}:phase`,
        kind: "activity_phase",
        interstitial: item,
        items: [],
        summary: "",
        active: false,
      };
      rows.push(current);
    } else if (item.kind === "protocol" && item.surface === "runtime_request") {
      const key = `${item.runId}:${item.requestId}`;
      if (seenRequests.has(key)) continue;
      seenRequests.add(key);
      current = null;
      const latest = latestRequestByKey.get(key);
      if (
        latest?.surface === "runtime_request" &&
        latest.status !== "pending"
      ) {
        rows.push(latest.id === item.id ? latest : { ...latest, id: item.id });
      }
    } else if (
      item.kind === "protocol" &&
      item.surface === "workspace_change"
    ) {
      current = null;
      rows.push(item);
    } else if (item.kind === "plan_document") {
      current = null;
      rows.push(item);
    } else if (
      item.kind === "tool" ||
      item.kind === "usage" ||
      item.kind === "thinking" ||
      item.kind === "marker" ||
      item.kind === "protocol"
    ) {
      ensureOpening(item.id).items.push(item);
    }
  }
  const meaningful = rows.filter(
    (row) =>
      row.kind !== "activity_phase" || row.interstitial || row.items.length > 0,
  );
  for (const row of meaningful) {
    if (row.kind === "activity_phase") row.summary = phaseSummary(row.items);
  }
  if (running && current && meaningful.includes(current)) current.active = true;
  return meaningful;
}

/** Segment parsed transcript rows at assistant/request boundaries. */
export function buildActivityPhases(
  parsed: readonly TaskChatItem[],
  running: boolean,
): TaskChatActivityPhaseItem[] {
  return buildTurnTimelineRows(parsed, running).filter(
    (item): item is TaskChatActivityPhaseItem => item.kind === "activity_phase",
  );
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
function transcriptSpanMs(
  entries: readonly TranscriptEntry[],
): number | undefined {
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
    durationLabel:
      durationMs != null ? formatDurationLabel(durationMs) : undefined,
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
    if (d != null && Number.isFinite(d))
      durationMs = (durationMs ?? 0) + Math.max(0, d);
  }
  // durationMs: 0 suppresses the concatenated-span fallback (which would count
  // the gap between runs); the summed label is applied over it below.
  const counts = buildTurnSummary(all, { durationMs: 0, failed });
  return {
    ...counts,
    durationLabel:
      durationMs != null ? formatDurationLabel(durationMs) : undefined,
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
export function prependIssueBrief(
  items: TaskChatItem[],
  hasBrief: boolean,
): TaskChatItem[] {
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
      if (
        held &&
        meta &&
        heldMeta &&
        meta.agentKey &&
        meta.agentKey === heldMeta.agentKey
      ) {
        out.splice(heldIdx, 1);
        const parts = [...heldMeta.parts, ...meta.parts];
        out.push({
          ...held,
          items: [...held.items, ...item.items],
          finalResponse: item.finalResponse ?? held.finalResponse,
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
      const heldMeta =
        heldIdx >= 0
          ? metaFor((out[heldIdx] as TaskChatTurnItem).id)
          : undefined;
      if (
        heldMeta?.agentName &&
        item.authorName &&
        item.authorName !== heldMeta.agentName
      ) {
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
        meta != null &&
        (meta.agentName == null ||
          prev.authorName == null ||
          meta.agentName === prev.authorName);
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
        summarizeToolInput(entry.input) ??
        (invocation ? clip(invocation, TARGET_MAX) : undefined);
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
    if (entry.kind === "system" && entry.text === "Reasoning started")
      return { label: "Thinking" };
  }
  return { label: "Running" };
}
