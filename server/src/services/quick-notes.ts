import type { Db } from "@paperclipai/db";
import { quickNotes, quickNoteThreads } from "@paperclipai/db";
import { and, desc, eq } from "drizzle-orm";

export function quickNoteService(db: Db) {
  async function create(input: {
    companyId: string;
    userId: string;
    text: string;
    metadata?: Record<string, unknown>;
  }) {
    const [note] = await db
      .insert(quickNotes)
      .values({
        companyId: input.companyId,
        userId: input.userId,
        text: input.text,
        metadata: input.metadata ?? null,
      })
      .returning();

    return note;
  }

  async function list(companyId: string, userId: string, opts?: { includeDismissed?: boolean }) {
    const conditions = [
      eq(quickNotes.companyId, companyId),
      eq(quickNotes.userId, userId),
    ];
    if (!opts?.includeDismissed) {
      conditions.push(eq(quickNotes.dismissed, false));
    }
    return db
      .select()
      .from(quickNotes)
      .where(and(...conditions))
      .orderBy(desc(quickNotes.createdAt));
  }

  async function getById(id: string) {
    const [note] = await db
      .select()
      .from(quickNotes)
      .where(eq(quickNotes.id, id));
    return note ?? null;
  }

  async function update(
    id: string,
    companyId: string,
    data: { text?: string; status?: string; dismissed?: boolean; metadata?: Record<string, unknown> },
  ) {
    const [note] = await db
      .update(quickNotes)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(quickNotes.id, id), eq(quickNotes.companyId, companyId)))
      .returning();
    return note ?? null;
  }

  async function remove(id: string, companyId: string) {
    const [note] = await db
      .delete(quickNotes)
      .where(and(eq(quickNotes.id, id), eq(quickNotes.companyId, companyId)))
      .returning();
    return note ?? null;
  }

  async function addThread(input: { noteId: string; authorType: string; authorId: string; body: string }) {
    const [entry] = await db
      .insert(quickNoteThreads)
      .values(input)
      .returning();
    return entry;
  }

  async function listThreads(noteId: string) {
    return db
      .select()
      .from(quickNoteThreads)
      .where(eq(quickNoteThreads.noteId, noteId))
      .orderBy(quickNoteThreads.createdAt);
  }

  return { create, list, getById, update, remove, addThread, listThreads };
}
