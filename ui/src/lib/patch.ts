export function isPatchFile(filename: string | null | undefined, contentType?: string | null) {
  const type = contentType?.toLowerCase().split(";")[0]?.trim();
  return /\.(patch|diff)$/i.test(filename ?? "")
    || type === "text/x-patch" || type === "text/x-diff";
}

export type PatchLineKind = "add" | "remove" | "hunk" | "context" | "file" | "skip";

export function createUnifiedDiffClassifier(): (raw: string) => { kind: PatchLineKind; text: string } {
  let inHunk = false;
  let remaining: { old: number; next: number } | null = null;
  return (source) => {
    const raw = source.replace(/\r$/, "");
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      return { kind: "skip", text: raw };
    }
    if (raw.startsWith("@@")) {
      const header = raw.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
      remaining = header ? { old: Number(header[1] ?? 1), next: Number(header[2] ?? 1) } : null;
      inHunk = !remaining || remaining.old > 0 || remaining.next > 0;
      return { kind: "hunk", text: raw };
    }
    if (raw === "\\ No newline at end of file") return { kind: "skip", text: raw };
    if (!inHunk && (
      raw.startsWith("+++ ") || raw.startsWith("--- ") || raw.startsWith("index ") ||
      raw.startsWith("new file mode") || raw.startsWith("deleted file mode") ||
      raw.startsWith("similarity index") || raw.startsWith("rename from") || raw.startsWith("rename to")
    )) return { kind: "skip", text: raw };
    const kind = raw.startsWith("+") ? "add" : raw.startsWith("-") ? "remove" : "context";
    if (inHunk && remaining) {
      if (kind !== "add") remaining.old -= 1;
      if (kind !== "remove") remaining.next -= 1;
      if (remaining.old <= 0 && remaining.next <= 0) inHunk = false;
    }
    return { kind, text: kind === "add" || kind === "remove" || raw.startsWith(" ") ? raw.slice(1) : raw };
  };
}
