/**
 * Live progress of one connected-app tool call, from the provider's MCP
 * `notifications/progress`. Everything here is untrusted provider content:
 * numbers are checked and the message is plain text, bounded in length.
 */
export const TOOL_CALL_PROGRESS_MESSAGE_MAX_LENGTH = 200;

export interface ToolCallProgress {
  /** Increases with each update. Never shown as a raw number without `total`. */
  progress: number;
  /** Known end value; absent when the provider does not know the total. */
  total: number | null;
  /** The provider's latest status line, plain text. */
  message: string | null;
  /** When the provider last reported progress (ISO). */
  updatedAt: string;
}

/** A running tool call's progress, as the task chat reads it. */
export interface ToolCallProgressSnapshot extends ToolCallProgress {
  invocationId: string;
  runId: string;
  /** The tool name the agent called through Paperclip. */
  toolName: string;
  /** The name native runners give that tool (shortened, with a hash); their transcripts show it. */
  nativeToolName?: string | null;
  /** When the call started (ISO), for elapsed time. */
  startedAt: string;
  /** True once the call has finished; the row then drops its progress. */
  done: boolean;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Plain, single-line text: control characters removed, whitespace collapsed, bounded. */
export function boundToolCallProgressMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const plain = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
  if (!plain) return null;
  return plain.length > TOOL_CALL_PROGRESS_MESSAGE_MAX_LENGTH
    ? `${plain.slice(0, TOOL_CALL_PROGRESS_MESSAGE_MAX_LENGTH - 1)}…`
    : plain;
}

/**
 * The progress a provider reported, or null when it is not usable. `total` is
 * kept only when it is positive and at least the progress so far.
 */
export function normalizeToolCallProgress(input: { progress?: unknown; total?: unknown; message?: unknown }, now = new Date()): ToolCallProgress | null {
  const progress = finite(input.progress);
  if (progress === null || progress < 0) return null;
  const total = finite(input.total);
  return {
    progress,
    total: total !== null && total > 0 && total >= progress ? total : null,
    message: boundToolCallProgressMessage(input.message),
    updatedAt: now.toISOString(),
  };
}

/** A fraction in [0, 1] when the total is known, otherwise null (indeterminate). */
export function toolCallProgressFraction(progress: Pick<ToolCallProgress, "progress" | "total">): number | null {
  if (progress.total === null || progress.total <= 0) return null;
  return Math.min(1, Math.max(0, progress.progress / progress.total));
}
