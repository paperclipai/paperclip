import type { TaskChatDiffLine } from "./task-chat-model";

/** Display cap for one diff in the task chat. */
export const TASK_CHAT_DIFF_LINE_LIMIT = 400;

export type UnifiedDiffLineKind = TaskChatDiffLine["kind"] | "skip";

/**
 * Classify unified diff lines. File headers (`diff --git`, `index`, `---`,
 * `+++`, mode and rename lines) are skipped only before a file's first hunk;
 * inside a hunk, `--- x` is a removed `-- x` line and `+++ x` an added `++ x`.
 */
export function createUnifiedDiffClassifier(): (raw: string) => { kind: UnifiedDiffLineKind; text: string } {
  let inHunk = false;
  return (raw) => {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      return { kind: "skip", text: raw };
    }
    if (raw.startsWith("@@")) {
      inHunk = true;
      return { kind: "hunk", text: raw };
    }
    if (raw === "\\ No newline at end of file") return { kind: "skip", text: raw };
    if (!inHunk && (
      raw.startsWith("+++ ") || raw.startsWith("--- ") || raw.startsWith("index ") ||
      raw.startsWith("new file mode") || raw.startsWith("deleted file mode") ||
      raw.startsWith("similarity index") || raw.startsWith("rename from") || raw.startsWith("rename to")
    )) return { kind: "skip", text: raw };
    if (raw.startsWith("+")) return { kind: "add", text: raw.slice(1) };
    if (raw.startsWith("-")) return { kind: "remove", text: raw.slice(1) };
    return { kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw };
  };
}

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
