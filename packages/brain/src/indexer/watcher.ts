import type { BrainDbHandle } from "../db/client.js";
import { parseNote } from "./parser.js";
import { chunkMarkdown } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import { upsertNote, getNoteByPath, deleteNote } from "../db/queries.js";
import { writeChunks } from "./writer.js";

const CHUNK_OPTS = { maxTokens: 800, overlapTokens: 100 };
const EXCLUDED_TOP_LEVEL = new Set(["attachments", ".obsidian", ".trash"]);
const MAX_FILE_SIZE = 2 * 1024 * 1024;

export type IndexResult = "indexed" | "skipped" | "unchanged" | "empty";

export async function indexFile(
  handle: BrainDbHandle,
  embed: Embedder,
  vaultRoot: string,
  relPath: string,
): Promise<IndexResult> {
  const normalized = relPath.split(/[\\/]/).filter((s) => s.length > 0).join("/");
  const topLevel = normalized.split("/")[0];
  if (topLevel && EXCLUDED_TOP_LEVEL.has(topLevel)) return "skipped";
  if (!normalized.endsWith(".md")) return "skipped";

  const parsed = await parseNote(vaultRoot, normalized);
  if (parsed.sizeBytes > MAX_FILE_SIZE) return "skipped";

  const existing = await getNoteByPath(handle.db, parsed.path);
  if (existing && existing.checksum === parsed.checksum) return "unchanged";

  const chunks = chunkMarkdown(parsed.body, CHUNK_OPTS);

  const noteId = await upsertNote(handle.db, {
    path: parsed.path,
    folder: parsed.folder,
    title: parsed.title,
    frontmatter: parsed.frontmatter,
    mtime: parsed.mtime,
    sizeBytes: parsed.sizeBytes,
    checksum: parsed.checksum,
  });

  if (chunks.length === 0) {
    await writeChunks(handle.sql, noteId, []);
    return "empty";
  }

  const embeddings = await embed.embedBatch(chunks.map((c) => c.content));
  await writeChunks(
    handle.sql,
    noteId,
    chunks.map((c, i) => ({ ...c, embedding: embeddings[i]! })),
  );
  return "indexed";
}

export async function removeFile(handle: BrainDbHandle, relPath: string): Promise<void> {
  const normalized = relPath.split(/[\\/]/).filter((s) => s.length > 0).join("/");
  await deleteNote(handle.db, normalized);
}
