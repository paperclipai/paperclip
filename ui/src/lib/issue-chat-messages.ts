import type {
  ReasoningMessagePart,
  TextMessagePart,
  ThreadAssistantMessage,
  ThreadMessage,
  ToolCallMessagePart,
  ThreadSystemMessage,
  ThreadUserMessage,
} from "@assistant-ui/react";
import type { Agent, IssueComment } from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import { formatAssigneeUserLabel } from "./assignees";
import {
  buildIssueThreadInteractionSummary,
  type IssueThreadInteraction,
} from "./issue-thread-interactions";
import type { IssueTimelineEvent } from "./issue-timeline-events";
import {
  summarizeNotice,
} from "./transcriptPresentation";

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type TranslateFn = (key: string, params?: Record<string, string | number | null | undefined>) => string;

export interface IssueChatComment extends IssueComment {
  runId?: string | null;
  runAgentId?: string | null;
  interruptedRunId?: string | null;
  clientId?: string;
  clientStatus?: "pending" | "queued";
  queueState?: "queued";
  queueTargetRunId?: string | null;
}

export interface IssueChatLinkedRun {
  runId: string;
  status: string;
  agentId: string;
  adapterType?: string;
  agentName?: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt?: Date | string | null;
  hasStoredOutput?: boolean;
}

export interface IssueChatTranscriptEntry {
  kind:
    | "assistant"
    | "thinking"
    | "user"
    | "tool_call"
    | "tool_result"
    | "init"
    | "result"
    | "stderr"
    | "system"
    | "stdout"
    | "diff";
  ts: string;
  text?: string;
  delta?: boolean;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  toolName?: string;
  content?: string;
  isError?: boolean;
  subtype?: string;
  errors?: string[];
  model?: string;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  changeType?: "add" | "remove" | "context" | "hunk" | "file_header" | "truncation";
}

const ISSUE_CHAT_TRANSCRIPT_MAX_VISIBLE_ENTRIES = 30;

type MessageWithOrder = {
  createdAtMs: number;
  order: number;
  message: ThreadMessage;
};

export interface StableThreadMessageCacheEntry {
  fingerprint: string;
  message: ThreadMessage;
}

function toDate(value: Date | string | null | undefined) {
  return value instanceof Date ? value : new Date(value ?? Date.now());
}

function toTimestamp(value: Date | string | null | undefined) {
  return toDate(value).getTime();
}

function fingerprintThreadMessage(message: ThreadMessage) {
  return JSON.stringify(message);
}

export function stabilizeThreadMessages(
  messages: readonly ThreadMessage[],
  previousMessages: readonly ThreadMessage[],
  previousById: ReadonlyMap<string, StableThreadMessageCacheEntry>,
) {
  const nextById = new Map<string, StableThreadMessageCacheEntry>();
  let sameSequence = previousMessages.length === messages.length;

  const stabilizedMessages = messages.map((message, index) => {
    const fingerprint = fingerprintThreadMessage(message);
    const cached = previousById.get(message.id);
    const stableMessage =
      cached && cached.fingerprint === fingerprint
        ? cached.message
        : message;
    nextById.set(message.id, {
      fingerprint,
      message: stableMessage,
    });
    if (sameSequence && previousMessages[index] !== stableMessage) {
      sameSequence = false;
    }
    return stableMessage;
  });

  return {
    messages: sameSequence ? previousMessages : stabilizedMessages,
    cache: nextById,
  };
}

function sortByCreated<T extends { createdAt: Date | string; id: string }>(items: readonly T[]) {
  return [...items].sort((a, b) => {
    const diff = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    if (diff !== 0) return diff;
    return a.id.localeCompare(b.id);
  });
}

function normalizeJsonValue(input: unknown): JsonValue {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean"
  ) {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((entry) => normalizeJsonValue(entry));
  }
  if (typeof input === "object" && input) {
    const entries = Object.entries(input as Record<string, unknown>).map(([key, value]) => [
      key,
      normalizeJsonValue(value),
    ]);
    return Object.fromEntries(entries) as JsonObject;
  }
  return String(input);
}

function normalizeToolArgs(input: unknown): JsonObject {
  if (typeof input === "object" && input && !Array.isArray(input)) {
    return normalizeJsonValue(input) as JsonObject;
  }
  if (input === undefined) return {};
  return { value: normalizeJsonValue(input) };
}

function stringifyUnknown(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function mergePartText(
  previous: TextMessagePart | ReasoningMessagePart,
  next: TextMessagePart | ReasoningMessagePart,
) {
  if (!previous.text) return next.text;
  if (!next.text) return previous.text;
  if (
    previous.text.endsWith("\n")
    || next.text.startsWith("\n")
    || previous.text.endsWith(" ")
    || next.text.startsWith(" ")
  ) {
    return `${previous.text}${next.text}`;
  }
  return previous.type === "text"
    ? `${previous.text} ${next.text}`
    : `${previous.text}\n${next.text}`;
}

function formatDiffBlock(lines: string[]) {
  return `\`\`\`diff\n${lines.join("\n")}\n\`\`\``;
}

function isIssueChatRenderableTranscriptEntry(entry: IssueChatTranscriptEntry) {
  return entry.kind !== "init"
    && entry.kind !== "stderr"
    && entry.kind !== "stdout"
    && entry.kind !== "system";
}

function compactIssueChatTranscript(
  entries: readonly IssueChatTranscriptEntry[],
  maxVisibleEntries = ISSUE_CHAT_TRANSCRIPT_MAX_VISIBLE_ENTRIES,
): readonly IssueChatTranscriptEntry[] {
  const renderable = entries
    .map((entry, fullIndex) => ({ entry, fullIndex }))
    .filter(({ entry }) => isIssueChatRenderableTranscriptEntry(entry));

  if (renderable.length <= maxVisibleEntries) {
    return entries;
  }

  let startPos = Math.max(0, renderable.length - maxVisibleEntries);
  while (
    startPos > 0
    && renderable[startPos]?.entry.kind === "diff"
    && renderable[startPos - 1]?.entry.kind === "diff"
  ) {
    startPos -= 1;
  }

  const keptRenderablePositions = new Set<number>();
  for (let pos = startPos; pos < renderable.length; pos += 1) {
    keptRenderablePositions.add(pos);
  }

  // Keep the matching tool call when the visible tail starts at a tool result.
  for (let pos = startPos; pos < renderable.length; pos += 1) {
    const entry = renderable[pos]?.entry;
    if (entry?.kind !== "tool_result" || !entry.toolUseId) continue;
    for (let scan = pos - 1; scan >= 0; scan -= 1) {
      const candidate = renderable[scan]?.entry;
      if (candidate?.kind === "tool_call" && candidate.toolUseId === entry.toolUseId) {
        keptRenderablePositions.add(scan);
        break;
      }
    }
  }

  const keptFullIndices = new Set<number>();
  for (const pos of keptRenderablePositions) {
    const fullIndex = renderable[pos]?.fullIndex;
    if (fullIndex !== undefined) keptFullIndices.add(fullIndex);
  }

  const compactedEntries = entries.filter((_entry, index) => keptFullIndices.has(index));
  return compactedEntries;
}

function createAssistantMetadata(custom: Record<string, unknown>) {
  return {
    unstable_state: null,
    unstable_annotations: [],
    unstable_data: [],
    steps: [],
    custom,
  } as const;
}

function authorNameForComment(
  comment: IssueChatComment,
  agentMap?: Map<string, Agent>,
  currentUserId?: string | null,
  userLabelMap?: ReadonlyMap<string, string> | null,
) {
  if (comment.authorAgentId) {
    return agentMap?.get(comment.authorAgentId)?.name ?? comment.authorAgentId.slice(0, 8);
  }
  const authorUserId = comment.authorUserId ?? null;
  if (!authorUserId) return "You";
  const userLabel = userLabelMap?.get(authorUserId)?.trim();
  if (userLabel) return userLabel;
  return formatAssigneeUserLabel(authorUserId, currentUserId, userLabelMap) ?? "You";
}

function formatStatusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function createCommentMessage(args: {
  comment: IssueChatComment;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  companyId?: string | null;
  projectId?: string | null;
}): ThreadMessage {
  const { comment, agentMap, currentUserId, userLabelMap, companyId, projectId } = args;
  const createdAt = toDate(comment.createdAt);
  const authorName = authorNameForComment(comment, agentMap, currentUserId, userLabelMap);
  const custom = {
    kind: "comment",
    commentId: comment.id,
    anchorId: `comment-${comment.id}`,
    authorName,
    authorAgentId: comment.authorAgentId,
    authorUserId: comment.authorUserId,
    companyId: companyId ?? comment.companyId,
    projectId: projectId ?? null,
    runId: comment.runId ?? null,
    runAgentId: comment.runAgentId ?? null,
    clientStatus: comment.clientStatus ?? null,
    queueState: comment.queueState ?? null,
    queueTargetRunId: comment.queueTargetRunId ?? null,
    interruptedRunId: comment.interruptedRunId ?? null,
  };

  if (comment.authorAgentId) {
    const message: ThreadAssistantMessage = {
      id: comment.id,
      role: "assistant",
      createdAt,
      content: [{ type: "text", text: comment.body }],
      status: { type: "complete", reason: "stop" },
      metadata: createAssistantMetadata(custom),
    };
    return message;
  }

  const message: ThreadUserMessage = {
    id: comment.id,
    role: "user",
    createdAt,
    content: [{ type: "text", text: comment.body }],
    attachments: [],
    metadata: { custom },
  };
  return message;
}

function createTimelineEventMessage(args: {
  event: IssueTimelineEvent;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  t?: TranslateFn;
}) {
  const { event, agentMap, currentUserId, userLabelMap } = args;
  const actorName = event.actorType === "agent"
    ? (agentMap?.get(event.actorId)?.name ?? event.actorId.slice(0, 8))
    : event.actorType === "system"
      ? "System"
      : (formatAssigneeUserLabel(event.actorId, currentUserId, userLabelMap) ?? "Board");

  const lines: string[] = [`${actorName} updated this issue`];
  if (event.statusChange) {
    lines.push(
      `Status: ${event.statusChange.from ?? "none"} -> ${event.statusChange.to ?? "none"}`,
    );
  }
  if (event.assigneeChange) {
    const from = event.assigneeChange.from.agentId
      ? (agentMap?.get(event.assigneeChange.from.agentId)?.name ?? event.assigneeChange.from.agentId.slice(0, 8))
      : (formatAssigneeUserLabel(event.assigneeChange.from.userId, currentUserId, userLabelMap) ?? "Unassigned");
    const to = event.assigneeChange.to.agentId
      ? (agentMap?.get(event.assigneeChange.to.agentId)?.name ?? event.assigneeChange.to.agentId.slice(0, 8))
      : (formatAssigneeUserLabel(event.assigneeChange.to.userId, currentUserId, userLabelMap) ?? "Unassigned");
    lines.push(`Assignee: ${from} -> ${to}`);
  }

  const message: ThreadSystemMessage = {
    id: `activity:${event.id}`,
    role: "system",
    createdAt: toDate(event.createdAt),
    content: [{ type: "text", text: lines.join("\n") }],
    metadata: {
      custom: {
        kind: "event",
        anchorId: `activity-${event.id}`,
        eventId: event.id,
        actorName,
        actorType: event.actorType,
        actorId: event.actorId,
        statusChange: event.statusChange ?? null,
        assigneeChange: event.assigneeChange ?? null,
      },
    },
  };
  return message;
}

function createInteractionMessage(interaction: IssueThreadInteraction) {
  const message: ThreadSystemMessage = {
    id: `interaction:${interaction.id}`,
    role: "system",
    createdAt: toDate(interaction.createdAt),
    content: [{ type: "text", text: buildIssueThreadInteractionSummary(interaction) }],
    metadata: {
      custom: {
        kind: "interaction",
        anchorId: `interaction-${interaction.id}`,
        interaction,
      },
    },
  };
  return message;
}

function runTimestamp(run: IssueChatLinkedRun) {
  return run.finishedAt ?? run.startedAt ?? run.createdAt;
}

export interface SegmentTiming {
  startMs: number;
  endMs: number;
}

function computeSegmentTimings(entries: readonly IssueChatTranscriptEntry[]): SegmentTiming[] {
  const timings: SegmentTiming[] = [];
  let inSegment = false;
  let segStart = 0;
  let segEnd = 0;

  for (const entry of entries) {
    const ts = new Date(entry.ts).getTime();

    const isCoT =
      entry.kind === "thinking" ||
      entry.kind === "tool_call" ||
      entry.kind === "tool_result" ||
      entry.kind === "diff" ||
      (entry.kind === "result" && ((entry.isError && !!entry.errors?.length) || !!entry.text));
    const isText = entry.kind === "assistant" && !!entry.text;

    if (isCoT) {
      if (!inSegment) {
        inSegment = true;
        segStart = ts;
      }
      segEnd = ts;
    } else if (isText && inSegment) {
      timings.push({ startMs: segStart, endMs: segEnd });
      inSegment = false;
    }
  }

  if (inSegment) {
    timings.push({ startMs: segStart, endMs: segEnd });
  }

  return timings;
}

function translated(t: TranslateFn | undefined, key: string, fallback: string, params?: Record<string, string | number | null | undefined>): string {
  const value = t?.(key, params);
  return value && value !== key ? value : fallback;
}

export function formatDurationWords(ms: number | null, t?: TranslateFn) {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return totalSeconds === 1
      ? translated(t, "duration.second", "1 second")
      : translated(t, "duration.seconds", `${totalSeconds} seconds`, { count: totalSeconds });
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return totalMinutes === 1
      ? translated(t, "duration.minute", "1 minute")
      : translated(t, "duration.minutes", `${totalMinutes} minutes`, { count: totalMinutes });
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return hours === 1
      ? translated(t, "duration.hour", "1 hour")
      : translated(t, "duration.hours", `${hours} hours`, { count: hours });
  }
  const fallbackHours = `${hours} hour${hours === 1 ? "" : "s"}`;
  const fallbackMinutes = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hourText = hours === 1
    ? translated(t, "duration.hour", "1 hour")
    : translated(t, "duration.hours", `${hours} hours`, { count: hours });
  const minuteText = minutes === 1
    ? translated(t, "duration.minute", "1 minute")
    : translated(t, "duration.minutes", `${minutes} minutes`, { count: minutes });
  return translated(t, "duration.hoursMinutes", `${fallbackHours} ${fallbackMinutes}`, {
    hours: hourText,
    minutes: minuteText,
  });
}

function runDurationLabel(run: {
  status: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt?: Date | string | null;
}, t?: TranslateFn) {
  const start = run.startedAt ?? run.createdAt;
  const end = run.finishedAt ?? null;
  const durationMs = end ? Math.max(0, toTimestamp(end) - toTimestamp(start)) : null;
  const durationText = formatDurationWords(durationMs, t);
  switch (run.status) {
    case "succeeded":
      return durationText
        ? translated(t, "run.workedFor", `Worked for ${durationText}`, { duration: durationText })
        : translated(t, "run.finishedWork", "Finished work");
    case "failed":
    case "error":
      return durationText
        ? translated(t, "run.failedAfter", `Failed after ${durationText}`, { duration: durationText })
        : translated(t, "run.failed", "Run failed");
    case "timed_out":
      return durationText
        ? translated(t, "run.timedOutAfter", `Timed out after ${durationText}`, { duration: durationText })
        : translated(t, "run.timedOut", "Run timed out");
    case "cancelled":
      return durationText
        ? translated(t, "run.cancelledAfter", `Cancelled after ${durationText}`, { duration: durationText })
        : translated(t, "run.cancelled", "Run cancelled");
    case "queued":
      return translated(t, "status.queued", "Queued");
    case "running":
      return translated(t, "run.working", "Working...");
    default:
      return formatStatusLabel(run.status);
  }
}

function createHistoricalRunMessage(run: IssueChatLinkedRun, agentMap?: Map<string, Agent>, t?: TranslateFn) {
  const agentName = run.agentName ?? agentMap?.get(run.agentId)?.name ?? run.agentId.slice(0, 8);
  const message: ThreadSystemMessage = {
    id: `run:${run.runId}`,
    role: "system",
    createdAt: toDate(runTimestamp(run)),
    content: [{ type: "text", text: `${agentName} run ${run.runId.slice(0, 8)} ${formatStatusLabel(run.status)}` }],
    metadata: {
      custom: {
        kind: "run",
        anchorId: `run-${run.runId}`,
        runId: run.runId,
        runAgentId: run.agentId,
        runAgentName: agentName,
        runStatus: run.status,
      },
    },
  };
  return message;
}

function createHistoricalTranscriptMessage(args: {
  run: IssueChatLinkedRun;
  transcript: readonly IssueChatTranscriptEntry[];
  hasOutput: boolean;
  agentMap?: Map<string, Agent>;
  t?: TranslateFn;
}) {
  const { run, transcript, hasOutput, agentMap, t } = args;
  const agentName = run.agentName ?? agentMap?.get(run.agentId)?.name ?? run.agentId.slice(0, 8);
  const compactedTranscript = compactIssueChatTranscript(transcript);
  const { parts, notices, segments } = buildAssistantPartsFromTranscript(compactedTranscript);
  const waitingText = hasOutput ? "" : translated(t, "run.finished", "Run finished");
  const content = parts.length > 0
    ? parts
    : waitingText
      ? [{ type: "text", text: waitingText } satisfies TextMessagePart]
      : [];

  const message: ThreadAssistantMessage = {
    id: `run-assistant:${run.runId}`,
    role: "assistant",
    createdAt: toDate(run.startedAt ?? run.createdAt),
    content,
    status: { type: "complete", reason: "stop" },
    metadata: createAssistantMetadata({
      kind: "historical-run",
      anchorId: `run-${run.runId}`,
      runId: run.runId,
      runAgentId: run.agentId,
      runAgentName: agentName,
      runStatus: run.status,
      notices,
      waitingText,
      chainOfThoughtLabel: runDurationLabel(run, t),
      chainOfThoughtSegments: segments,
    }),
  };
  return message;
}

export function buildAssistantPartsFromTranscript(entries: readonly IssueChatTranscriptEntry[]): {
  parts: Array<TextMessagePart | ReasoningMessagePart | ToolCallMessagePart<JsonObject, unknown>>;
  notices: string[];
  segments: SegmentTiming[];
} {
  const orderedParts: Array<TextMessagePart | ReasoningMessagePart | ToolCallMessagePart<JsonObject, unknown>> = [];
  const toolParts = new Map<string, ToolCallMessagePart<JsonObject, unknown>>();
  const toolIndices = new Map<string, number>();
  const notices: string[] = [];
  let pendingDiffLines: string[] = [];
  let pendingDiffParentId: string | undefined;

  const flushPendingDiff = () => {
    if (pendingDiffLines.length === 0) return;
    orderedParts.push({
      type: "text",
      text: formatDiffBlock(pendingDiffLines),
      parentId: pendingDiffParentId,
    });
    pendingDiffLines = [];
    pendingDiffParentId = undefined;
  };

  for (const [index, entry] of entries.entries()) {
    if (entry.kind === "diff") {
      pendingDiffParentId ??= `diff-group:${index}`;
      pendingDiffLines.push(entry.text ?? "");
      continue;
    }

    flushPendingDiff();

    if (entry.kind === "assistant" && entry.text) {
      orderedParts.push({ type: "text", text: entry.text });
      continue;
    }
    if (entry.kind === "thinking" && entry.text) {
      orderedParts.push({ type: "reasoning", text: entry.text });
      continue;
    }
    if (entry.kind === "tool_call") {
      const toolCallId = entry.toolUseId || `tool-${index}`;
      const nextPart: ToolCallMessagePart<JsonObject, unknown> = {
        type: "tool-call",
        toolCallId,
        toolName: entry.name || "tool",
        args: normalizeToolArgs(entry.input),
        argsText: stringifyUnknown(entry.input),
      };
      if (!toolParts.has(toolCallId)) {
        toolIndices.set(toolCallId, orderedParts.length);
        orderedParts.push(nextPart);
      } else {
        const existingIndex = toolIndices.get(toolCallId);
        if (existingIndex !== undefined) {
          orderedParts[existingIndex] = nextPart;
        }
      }
      toolParts.set(toolCallId, nextPart);
      continue;
    }
    if (entry.kind === "tool_result") {
      const toolCallId = entry.toolUseId || `tool-result-${index}`;
      const existing = toolParts.get(toolCallId);
      const nextPart: ToolCallMessagePart<JsonObject, unknown> = {
        type: "tool-call",
        toolCallId,
        toolName: existing?.toolName || entry.toolName || "tool",
        args: existing?.args ?? {},
        argsText: existing?.argsText ?? "",
        result: entry.content ?? "",
        isError: entry.isError === true,
      };
      if (existing) {
        const existingIndex = toolIndices.get(toolCallId);
        if (existingIndex !== undefined) {
          orderedParts[existingIndex] = nextPart;
        }
      } else {
        toolIndices.set(toolCallId, orderedParts.length);
        orderedParts.push(nextPart);
      }
      toolParts.set(toolCallId, nextPart);
      continue;
    }
    if (entry.kind === "init") continue;
    if (entry.kind === "stderr") continue;
    if (entry.kind === "stdout") continue;
    if (entry.kind === "system") continue;
    if (entry.kind === "result") {
      if (entry.isError && entry.errors?.length) {
        for (const error of entry.errors) {
          orderedParts.push({ type: "reasoning", text: `Run error: ${summarizeNotice(error)}` });
        }
      } else if (entry.text) {
        orderedParts.push({
          type: "reasoning",
          text: entry.isError
            ? `Run error: ${summarizeNotice(entry.text)}`
            : summarizeNotice(entry.text),
        });
      }
      continue;
    }
  }

  flushPendingDiff();

  const mergedParts: Array<TextMessagePart | ReasoningMessagePart | ToolCallMessagePart<JsonObject, unknown>> = [];
  for (const part of orderedParts) {
    if (part.type === "tool-call") {
      mergedParts.push(part);
      continue;
    }
    const previous = mergedParts.at(-1);
    if (previous && previous.type === part.type && previous.parentId === part.parentId) {
      mergedParts[mergedParts.length - 1] = {
        ...previous,
        text: mergePartText(previous, part),
      };
      continue;
    }
    mergedParts.push(part);
  }

  return {
    parts: mergedParts,
    notices,
    segments: computeSegmentTimings(entries),
  };
}

function normalizeLiveRuns(
  liveRuns: readonly LiveRunForIssue[],
  activeRun: ActiveRunForIssue | null | undefined,
  issueId?: string,
) {
  const deduped = new Map<string, LiveRunForIssue>();
  for (const run of liveRuns) {
    deduped.set(run.id, run);
  }
  if (activeRun) {
    deduped.set(activeRun.id, {
      id: activeRun.id,
      status: activeRun.status,
      invocationSource: activeRun.invocationSource,
      triggerDetail: activeRun.triggerDetail,
      startedAt: activeRun.startedAt ? toDate(activeRun.startedAt).toISOString() : null,
      finishedAt: activeRun.finishedAt ? toDate(activeRun.finishedAt).toISOString() : null,
      createdAt: toDate(activeRun.createdAt).toISOString(),
      agentId: activeRun.agentId,
      agentName: activeRun.agentName,
      adapterType: activeRun.adapterType,
      issueId,
    });
  }
  return [...deduped.values()].sort((a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt));
}

function createLiveRunMessage(args: {
  run: LiveRunForIssue;
  transcript: readonly IssueChatTranscriptEntry[];
  t?: TranslateFn;
}) {
  const { run, transcript, t } = args;
  const compactedTranscript = compactIssueChatTranscript(transcript);
  const { parts, notices, segments } = buildAssistantPartsFromTranscript(compactedTranscript);
  const waitingText =
    run.status === "queued"
      ? translated(t, "run.queuedEllipsis", "Queued...")
      : parts.length > 0
        ? ""
        : translated(t, "run.working", "Working...");

  const content = parts;

  const message: ThreadAssistantMessage = {
    id: `run-assistant:${run.id}`,
    role: "assistant",
    createdAt: toDate(run.startedAt ?? run.createdAt),
    content,
    status: { type: "running" },
    metadata: createAssistantMetadata({
      kind: "live-run",
      runId: run.id,
      runAgentId: run.agentId,
      runAgentName: run.agentName,
      runStatus: run.status,
      adapterType: run.adapterType,
      notices,
      waitingText,
      chainOfThoughtLabel: runDurationLabel(run, t),
      chainOfThoughtSegments: segments,
    }),
  };
  return message;
}

export function buildIssueChatMessages(args: {
  comments: readonly IssueChatComment[];
  interactions?: readonly IssueThreadInteraction[];
  timelineEvents: readonly IssueTimelineEvent[];
  linkedRuns: readonly IssueChatLinkedRun[];
  liveRuns: readonly LiveRunForIssue[];
  activeRun?: ActiveRunForIssue | null;
  transcriptsByRunId?: ReadonlyMap<string, readonly IssueChatTranscriptEntry[]>;
  hasOutputForRun?: (runId: string) => boolean;
  includeSucceededRunsWithoutOutput?: boolean;
  issueId?: string;
  companyId?: string | null;
  projectId?: string | null;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
  t?: TranslateFn;
}) {
  const {
    comments,
    interactions = [],
    timelineEvents,
    linkedRuns,
    liveRuns,
    activeRun,
    transcriptsByRunId,
    hasOutputForRun,
    includeSucceededRunsWithoutOutput = false,
    issueId,
    companyId,
    projectId,
    agentMap,
    currentUserId,
    userLabelMap,
    t,
  } = args;

  const orderedMessages: MessageWithOrder[] = [];

  for (const comment of sortByCreated(comments)) {
    orderedMessages.push({
      createdAtMs: toTimestamp(comment.createdAt),
      order: 1,
      message: createCommentMessage({ comment, agentMap, currentUserId, userLabelMap, companyId, projectId }),
    });
  }

  for (const interaction of sortByCreated(interactions)) {
    orderedMessages.push({
      createdAtMs: toTimestamp(interaction.createdAt),
      order: 2,
      message: createInteractionMessage(interaction),
    });
  }

  for (const event of sortByCreated(timelineEvents)) {
    orderedMessages.push({
      createdAtMs: toTimestamp(event.createdAt),
      order: 0,
      message: createTimelineEventMessage({ event, agentMap, currentUserId, userLabelMap }),
    });
  }

  for (const run of [...linkedRuns].sort((a, b) => toTimestamp(runTimestamp(a)) - toTimestamp(runTimestamp(b)))) {
    const transcript = transcriptsByRunId?.get(run.runId) ?? [];
    const hasRunOutput = transcript.length > 0 || (hasOutputForRun?.(run.runId) ?? false);
    if (hasRunOutput || run.status !== "succeeded") {
      // Always use the transcript message for non-succeeded runs (even before
      // transcript data loads) so the message type and fold header are stable
      // from initial render — avoids a flash when transcripts arrive later.
      orderedMessages.push({
        createdAtMs: toTimestamp(run.startedAt ?? run.createdAt),
        order: 2,
        message: createHistoricalTranscriptMessage({
          run,
          transcript,
          hasOutput: hasRunOutput,
          agentMap,
          t,
        }),
      });
      continue;
    }
    if (!includeSucceededRunsWithoutOutput) continue;
    orderedMessages.push({
      createdAtMs: toTimestamp(runTimestamp(run)),
      order: 2,
      message: createHistoricalRunMessage(run, agentMap, t),
    });
  }

  for (const run of normalizeLiveRuns(liveRuns, activeRun, issueId)) {
    orderedMessages.push({
      createdAtMs: toTimestamp(run.startedAt ?? run.createdAt),
      order: 3,
      message: createLiveRunMessage({
        run,
        transcript: transcriptsByRunId?.get(run.id) ?? [],
        t,
      }),
    });
  }

  return orderedMessages
    .sort((a, b) => {
      if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
      if (a.order !== b.order) return a.order - b.order;
      return a.message.id.localeCompare(b.message.id);
    })
    .map((entry) => entry.message);
}
