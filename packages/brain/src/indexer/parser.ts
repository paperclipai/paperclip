import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import type { ParsedNote } from "../shared/types.js";

export async function parseNote(vaultRoot: string, relPath: string): Promise<ParsedNote> {
  const absPath = path.join(vaultRoot, relPath);
  const raw = await readFile(absPath, "utf-8");
  const stats = await stat(absPath);
  const parsed = matter(raw);

  const body = parsed.content;
  const normalizedRel = relPath.split(path.sep).join("/");
  const folder = normalizedRel.split("/")[0] ?? "";
  const titleFromH1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const fallbackTitle = path.basename(relPath, ".md");

  return {
    path: normalizedRel,
    folder,
    title: titleFromH1 && titleFromH1.length > 0 ? titleFromH1 : fallbackTitle,
    frontmatter: (parsed.data ?? {}) as Record<string, unknown>,
    body,
    mtime: stats.mtime,
    sizeBytes: stats.size,
    checksum: createHash("sha256").update(body).digest("hex"),
  };
}
