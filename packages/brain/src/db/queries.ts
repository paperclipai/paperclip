import { eq, sql } from "drizzle-orm";
import type { BrainDb } from "./client.js";
import { brainNotes } from "./schema/brain-notes.js";
import { brainAgentAcl } from "./schema/brain-agent-acl.js";
import { brainChunks } from "./schema/brain-chunks.js";
import type { Note, ParsedNote } from "../shared/types.js";

export async function upsertNote(
  db: BrainDb,
  parsed: Omit<ParsedNote, "body">,
): Promise<string> {
  const [row] = await db
    .insert(brainNotes)
    .values({
      path: parsed.path,
      folder: parsed.folder,
      title: parsed.title,
      frontmatter: parsed.frontmatter,
      mtime: parsed.mtime,
      sizeBytes: parsed.sizeBytes,
      checksum: parsed.checksum,
    })
    .onConflictDoUpdate({
      target: brainNotes.path,
      set: {
        folder: parsed.folder,
        title: parsed.title,
        frontmatter: parsed.frontmatter,
        mtime: parsed.mtime,
        sizeBytes: parsed.sizeBytes,
        checksum: parsed.checksum,
        indexedAt: sql`now()`,
      },
    })
    .returning({ id: brainNotes.id });

  if (!row) throw new Error("upsertNote: insert returned no row");
  return row.id;
}

export async function getNoteByPath(db: BrainDb, path: string): Promise<Note | null> {
  const rows = await db
    .select()
    .from(brainNotes)
    .where(eq(brainNotes.path, path))
    .limit(1);

  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    id: r.id,
    path: r.path,
    folder: r.folder,
    title: r.title,
    frontmatter: r.frontmatter,
    mtime: r.mtime,
    sizeBytes: r.sizeBytes,
    checksum: r.checksum,
  };
}

export async function deleteNote(db: BrainDb, path: string): Promise<void> {
  await db.delete(brainNotes).where(eq(brainNotes.path, path));
}

export async function getAclForAgent(db: BrainDb, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ allowed: brainAgentAcl.allowedFolders })
    .from(brainAgentAcl)
    .where(eq(brainAgentAcl.agentId, agentId))
    .limit(1);
  return rows[0]?.allowed ?? [];
}

export async function setAcl(
  db: BrainDb,
  agentId: string,
  allowedFolders: string[],
  description?: string,
): Promise<void> {
  await db
    .insert(brainAgentAcl)
    .values({ agentId, allowedFolders, description })
    .onConflictDoUpdate({
      target: brainAgentAcl.agentId,
      set: {
        allowedFolders,
        description,
        updatedAt: sql`now()`,
      },
    });
}

export async function countNotes(db: BrainDb): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(brainNotes);
  return rows[0]?.count ?? 0;
}

export async function deleteChunksForNote(db: BrainDb, noteId: string): Promise<void> {
  await db.delete(brainChunks).where(eq(brainChunks.noteId, noteId));
}
