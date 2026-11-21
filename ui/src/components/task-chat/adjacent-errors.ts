import type { TaskChatItem, TaskChatMarkerItem, TaskChatMessageItem } from "./task-chat-model";

const RECOVERY_STATEMENT = /^Paperclip tried to (?:start|continue) this task again, but it still could not (?:start|continue)\b/i;
const LEGACY_RECOVERY_STATEMENT = /^Paperclip (?:automatically )?retried (?:dispatch|continuation|this issue's run)\b[^\r\n]*\bit still has no live execution path\b/i;
const RECOVERY_TITLES = new Set(["task could not continue", "no live execution path"]);

export function isNoLiveExecutionPathNotice(item: TaskChatMessageItem): boolean {
  if (item.author !== "system") return false;
  const text = item.text.trim();
  const recoveryStatement = RECOVERY_STATEMENT.test(text) || LEGACY_RECOVERY_STATEMENT.test(text);
  if (item.presentation) {
    if (RECOVERY_TITLES.has(item.presentation.title?.trim().toLowerCase() ?? "")) return true;
    // The stranded-recovery producer can replace the family title with
    // "Automatic recovery blocked" or a classified source-run failure.
    // Require both its recovery statement and saved action metadata so an
    // unrelated notice quoting that statement remains a group boundary.
    return recoveryStatement && !!item.metadata?.sections.some((section) =>
      section.title === "Recovery" && section.rows.some((row) =>
        row.type === "key_value" && row.label === "Recovery action" && row.value.trim().length > 0,
      ),
    );
  }
  // Older recovery comments lack presentation metadata. Recognize their own
  // recovery statement rather than any mention of the error phrase.
  return recoveryStatement;
}

function errorKind(item: TaskChatItem): "run" | "recovery" | null {
  if (item.kind === "marker" && item.variant === "interrupted"
    && item.tone !== "neutral" && !item.credentialAccess) return "run";
  if (item.kind === "message" && isNoLiveExecutionPathNotice(item)) return "recovery";
  return null;
}

/** Keep the last row when adjacent run and recovery errors describe a stop.
 * The caller supplies conversation order; saved comments and run history stay intact.
 * Messages, inputs, session boundaries and actionable credential denials break a group.
 */
export function compactAdjacentErrors(items: readonly TaskChatItem[]): {
  items: TaskChatItem[];
  retryMarkers: Map<string, TaskChatMarkerItem>;
} {
  const result: TaskChatItem[] = [];
  const retryMarkers = new Map<string, TaskChatMarkerItem>();
  for (let start = 0; start < items.length;) {
    const kind = errorKind(items[start]);
    if (!kind) {
      result.push(items[start++]);
      continue;
    }
    let end = start + 1;
    let mixed = false;
    while (end < items.length) {
      const next = errorKind(items[end]);
      if (!next) break;
      if (next !== kind) mixed = true;
      end++;
    }
    const latest = items[end - 1];
    if (mixed && errorKind(latest) === "recovery") {
      const marker = items.slice(start, end).reverse().find(
        (item): item is TaskChatMarkerItem => item.kind === "marker" && isRetryableFailureMarker(item),
      );
      // Preserve the retry target separately from the surviving error's text.
      // The renderer still applies the parent's permission and pending state.
      if (marker) retryMarkers.set(latest.id, marker);
    }
    result.push(...(mixed ? [latest] : items.slice(start, end)));
    start = end;
  }
  return { items: result, retryMarkers };
}

const RETRYABLE_FAILURE_LABELS = new Set(["Run failed", "Usage limit reached", "Model unavailable"]);

export function isRetryableFailureMarker(marker: Pick<TaskChatMarkerItem, "variant" | "label">) {
  return marker.variant === "interrupted" && RETRYABLE_FAILURE_LABELS.has(marker.label);
}
