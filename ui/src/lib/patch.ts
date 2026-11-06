export function isPatchFile(filename: string | null | undefined, contentType?: string | null) {
  const type = contentType?.toLowerCase().split(";")[0]?.trim();
  return /\.(patch|diff)$/i.test(filename ?? "")
    || type === "text/x-patch" || type === "text/x-diff";
}

export type PatchLineKind = "add" | "remove" | "hunk" | "context" | "file" | "skip";

export function createUnifiedDiffClassifier(): (raw: string) => { kind: PatchLineKind; text: string } {
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
