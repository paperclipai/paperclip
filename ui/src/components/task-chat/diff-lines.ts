import type { TaskChatDiffLine } from "./task-chat-model";
import { createUnifiedDiffClassifier } from "@/lib/patch";

/** Display cap for one diff in the task chat. */
export const TASK_CHAT_DIFF_LINE_LIMIT = 400;

export { createUnifiedDiffClassifier } from "@/lib/patch";
export type { PatchLineKind as UnifiedDiffLineKind } from "@/lib/patch";

/**
 * Parse a unified diff body into display lines. File headers (`---`, `+++`,
 * `diff --git`, `index`) are dropped because the row or card already names the
 * file. Lines past the display cap are omitted and reported as truncated.
 */
export function parseUnifiedDiffLines(
  patch: string,
  limit = TASK_CHAT_DIFF_LINE_LIMIT,
): { lines: TaskChatDiffLine[]; added: number; removed: number; truncated: boolean } {
  const lines: TaskChatDiffLine[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  const classify = createUnifiedDiffClassifier();
  const source = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  for (const raw of source.split("\n")) {
    const { kind, text } = classify(raw);
    if (kind === "skip") continue;
    if (kind === "add") added += 1;
    if (kind === "remove") removed += 1;
    if (lines.length < limit) lines.push({ kind, text });
    else truncated = true;
  }
  return { lines, added, removed, truncated };
}

/** Readable hunk label: `@@ -41,9 +41,18 @@ fn()` becomes `Line 41 · fn()`. */
export function hunkLabel(text: string): string {
  const match = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
  if (!match) return text;
  const context = match[2]?.trim();
  return context ? `Line ${match[1]} · ${context}` : `Line ${match[1]}`;
}
