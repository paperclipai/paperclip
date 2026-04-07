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
import type { IssueTimelineEvent } from "./issue-timeline-events";
import {
  summarizeNotice,
} from "./transcriptPresentation";

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

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
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt?: Date | string | null;
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

type MessageWithOrder = {
  createdAtMs: number;
  order: number;
  message: ThreadMessage;
};

function toDate(value: Date | string | null | undefined) {
  return value instanceof Date ? value : new Date(value ?? Date.now());
}

function toTimestamp(value: Date | string | null | undefined) {
  return toDate(value).getTime();
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
) {
  if (comment.authorAgentId) {
    return agentMap?.get(comment.authorAgentId)?.name ?? comment.authorAgentId.slice(0, 8);
  }
  return formatAssigneeUserLabel(comment.authorUserId ?? null, currentUserId) ?? "You";
}

function formatStatusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function createCommentMessage(args: {
  comment: IssueChatComment;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
}): ThreadMessage {
  const { comment, agentMap, currentUserId, companyId, projectId } = args;
  const createdAt = toDate(comment.createdAt);
  const authorName = authorNameForComment(comment, agentMap, currentUserId);
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
}) {
  const { event, agentMap, currentUserId } = args;
  const actorName = event.actorType === "agent"
    ? (agentMap?.get(event.actorId)?.name ?? event.actorId.slice(0, 8))
    : event.actorType === "system"
      ? "System"
      : (formatAssigneeUserLabel(event.actorId, currentUserId) ?? "Board");

  const lines: string[] = [`${actorName} updated this issue`];
  if (event.statusChange) {
    lines.push(
      `Status: ${event.statusChange.from ?? "none"} -> ${event.statusChange.to ?? "none"}`,
    );
  }
  if (event.assigneeChange) {
    const from = event.assigneeChange.from.agentId
      ? (agentMap?.get(event.assigneeChange.from.agentId)?.name ?? event.assigneeChange.from.agentId.slice(0, 8))
      : (formatAssigneeUserLabel(event.assigneeChange.from.userId, currentUserId) ?? "Unassigned");
    const to = event.assigneeChange.to.agentId
      ? (agentMap?.get(event.assigneeChange.to.agentId)?.name ?? event.assigneeChange.to.agentId.slice(0, 8))
      : (formatAssigneeUserLabel(event.assigneeChange.to.userId, currentUserId) ?? "Unassigned");
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

export function formatDurationWords(ms: number | null) {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function runDurationLabel(run: {
  status: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt?: Date | string | null;
}) {
  const start = run.startedAt ?? run.createdAt;
  const end = run.finishedAt ?? null;
  const durationMs = end ? Math.max(0, toTimestamp(end) - toTimestamp(start)) : null;
  const durationText = formatDurationWords(durationMs);
  switch (run.status) {
    case "succeeded":
      return durationText ? `Worked for ${durationText}` : "Finished work";
    case "failed":
    case "error":
      return durationText ? `Failed after ${durationText}` : "Run failed";
    case "timed_out":
      return durationText ? `Timed out after ${durationText}` : "Run timed out";
    case "cancelled":
      return durationText ? `Cancelled after ${durationText}` : "Run cancelled";
    case "queued":
      return "Queued";
    case "running":
      return "Working...";
    default:
      return formatStatusLabel(run.status);
  }
}

function createHistoricalRunMessage(run: IssueChatLinkedRun, agentMap?: Map<string, Agent>) {
  const agentName = agentMap?.get(run.agentId)?.name ?? run.agentId.slice(0, 8);
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
}) {
  const { run, transcript, hasOutput, agentMap } = args;
  const agentName = agentMap?.get(run.agentId)?.name ?? run.agentId.slice(0, 8);
  const { parts, notices, segments } = buildAssistantPartsFromTranscript(transcript);
  const waitingText = hasOutput ? "" : "Run finished";
  const content = parts.length > 0
    ? parts
    : waitingText
      ? [{ type: "text", text: waitingText } satisfies TextMessagePart]
      : [];

  const message: ThreadAssistantMessage = {
    id: `historical-run:${run.runId}`,
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
      chainOfThoughtLabel: runDurationLabel(run),
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

  for (const [index, entry] of entries.entries()) {
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
  hasOutput: boolean;
}) {
  const { run, transcript, hasOutput } = args;
  const { parts, notices, segments } = buildAssistantPartsFromTranscript(transcript);
  const waitingText =
    run.status === "queued"
      ? "Queued..."
      : hasOutput
        ? ""
        : "Working...";

  const content = parts.length > 0
    ? parts
    : waitingText
      ? [{ type: "text", text: waitingText } satisfies TextMessagePart]
      : [];

  const message: ThreadAssistantMessage = {
    id: `live-run:${run.id}`,
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
      chainOfThoughtLabel: runDurationLabel(run),
      chainOfThoughtSegments: segments,
    }),
  };
  return message;
}

export function buildIssueChatMessages(args: {
  comments: readonly IssueChatComment[];
  timelineEvents: readonly IssueTimelineEvent[];
  linkedRuns: readonly IssueChatLinkedRun[];
  liveRuns: readonly LiveRunForIssue[];
  activeRun?: ActiveRunForIssue | null;
  transcriptsByRunId?: ReadonlyMap<string, readonly IssueChatTranscriptEntry[]>;
  hasOutputForRun?: (runId: string) => boolean;
  issueId?: string;
  companyId?: string | null;
  projectId?: string | null;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
}) {
  const {
    comments,
    timelineEvents,
    linkedRuns,
    liveRuns,
    activeRun,
    transcriptsByRunId,
    hasOutputForRun,
    issueId,
    companyId,
    projectId,
    agentMap,
    currentUserId,
  } = args;

  const orderedMessages: MessageWithOrder[] = [];

  for (const comment of sortByCreated(comments)) {
    orderedMessages.push({
      createdAtMs: toTimestamp(comment.createdAt),
      order: 1,
      message: createCommentMessage({ comment, agentMap, currentUserId, companyId, projectId }),
    });
  }

  for (const event of sortByCreated(timelineEvents)) {
    orderedMessages.push({
      createdAtMs: toTimestamp(event.createdAt),
      order: 0,
      message: createTimelineEventMessage({ event, agentMap, currentUserId }),
    });
  }

  for (const run of [...linkedRuns].sort((a, b) => toTimestamp(runTimestamp(a)) - toTimestamp(runTimestamp(b)))) {
    const transcript = transcriptsByRunId?.get(run.runId) ?? [];
    const hasRunOutput = transcript.length > 0 || (hasOutputForRun?.(run.runId) ?? false);
    if (hasRunOutput) {
      orderedMessages.push({
        createdAtMs: toTimestamp(run.startedAt ?? run.createdAt),
        order: 2,
        message: createHistoricalTranscriptMessage({
          run,
          transcript,
          hasOutput: hasRunOutput,
          agentMap,
        }),
      });
      continue;
    }
    if (run.status === "succeeded") continue;
    orderedMessages.push({
      createdAtMs: toTimestamp(runTimestamp(run)),
      order: 2,
      message: createHistoricalRunMessage(run, agentMap),
    });
  }

  for (const run of normalizeLiveRuns(liveRuns, activeRun, issueId)) {
    orderedMessages.push({
      createdAtMs: toTimestamp(run.startedAt ?? run.createdAt),
      order: 3,
      message: createLiveRunMessage({
        run,
        transcript: transcriptsByRunId?.get(run.id) ?? [],
        hasOutput: hasOutputForRun?.(run.id) ?? false,
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
