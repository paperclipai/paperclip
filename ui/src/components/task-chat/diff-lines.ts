import type { TaskChatDiffLine } from "./task-chat-model";

/** Display cap for one edit diff; the full patch stays on the run record. */
export const TASK_CHAT_DIFF_LINE_LIMIT = 400;

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
  const source = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  for (const raw of source.split("\n")) {
    if (
      raw.startsWith("+++ ") || raw.startsWith("--- ") || raw.startsWith("diff --git ") ||
      raw.startsWith("index ") || raw.startsWith("new file mode") || raw.startsWith("deleted file mode") ||
      raw.startsWith("similarity index") || raw.startsWith("rename from") || raw.startsWith("rename to") ||
      raw === "\\ No newline at end of file"
    ) continue;
    let line: TaskChatDiffLine;
    if (raw.startsWith("@@")) line = { kind: "hunk", text: raw };
    else if (raw.startsWith("+")) { line = { kind: "add", text: raw.slice(1) }; added += 1; }
    else if (raw.startsWith("-")) { line = { kind: "remove", text: raw.slice(1) }; removed += 1; }
    else line = { kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw };
    if (lines.length < limit) lines.push(line);
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
